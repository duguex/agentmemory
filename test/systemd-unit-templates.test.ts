import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const INSTALLER = join(ROOT, "scripts", "install-systemd.sh");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function installUnits() {
  const home = mkdtempSync(join(tmpdir(), "agentmemory-systemd-template-test-"));
  temporaryDirectories.push(home);
  const fakeBin = join(home, "bin");
  const outputDir = join(home, "systemd", "user");
  const systemctlLog = join(home, "systemctl.log");
  const fakeAgentmemory = join(fakeBin, "agentmemory");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(systemctlLog, "", "utf8");
  writeExecutable(
    join(fakeBin, "systemctl"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
`,
  );
  writeExecutable(fakeAgentmemory, "#!/usr/bin/env bash\nexit 0\n");

  const result = spawnSync("bash", [INSTALLER], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      AGENTMEMORY_ROOT: ROOT,
      AGENTMEMORY_BIN: fakeAgentmemory,
      AGENTMEMORY_SYSTEMD_UNIT_DIR: outputDir,
      SYSTEMCTL_LOG: systemctlLog,
    },
    encoding: "utf8",
    timeout: 10_000,
  });

  return {
    result,
    outputDir,
    systemctlLog: readFileSync(systemctlLog, "utf8"),
  };
}

describe("versioned systemd deployment", () => {
  it("renders an independent primary owner and safe ensure/timer units", () => {
    const { result, outputDir, systemctlLog } = installUnits();

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const service = readFileSync(join(outputDir, "agentmemory.service"), "utf8");
    const ensure = readFileSync(
      join(outputDir, "agentmemory-ensure.service"),
      "utf8",
    );
    const timer = readFileSync(join(outputDir, "agentmemory-ensure.timer"), "utf8");

    for (const unit of [service, ensure, timer]) {
      expect(unit).not.toContain("@AGENTMEMORY_");
    }
    expect(service).toContain("Type=simple");
    expect(service).toContain("KillMode=control-group");
    expect(service).toContain("Restart=always");
    expect(service).toContain("ExecStart=");
    expect(service).toContain("agentmemory --verbose");
    expect(ensure).toContain("Type=oneshot");
    expect(ensure).toContain("TimeoutStartSec=60s");
    expect(ensure).toContain("am-daemon.sh ensure");
    expect(timer).toContain("OnUnitActiveSec=2min");
    expect(timer).toContain("Unit=agentmemory-ensure.service");
    expect(systemctlLog).toContain("--user daemon-reload");
  });
});
