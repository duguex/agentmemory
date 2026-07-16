import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  cpSync,
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

function installUnits(useSpacedPaths = false) {
  const home = mkdtempSync(join(tmpdir(), "agentmemory-systemd-template-test-"));
  temporaryDirectories.push(home);
  const fakeBin = join(home, useSpacedPaths ? "bin with spaces" : "bin");
  const fakeRoot = useSpacedPaths ? join(home, "checkout with spaces") : ROOT;
  const outputDir = join(home, "systemd", "user");
  const systemctlLog = join(home, "systemctl.log");
  const fakeAgentmemory = join(fakeBin, "agentmemory");
  mkdirSync(fakeBin, { recursive: true });
  if (useSpacedPaths) {
    cpSync(join(ROOT, "deploy"), join(fakeRoot, "deploy"), { recursive: true });
    writeFileSync(join(fakeRoot, "iii-config.supervised.yaml"), "", "utf8");
  }
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
      AGENTMEMORY_ROOT: fakeRoot,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
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
    const execStart = service.split("\n").find((line) => line.startsWith("ExecStart="));
    expect(execStart).toBeDefined();
    expect(execStart).toContain("AGENTMEMORY_SUPERVISED=1");
    expect(execStart).toContain("AGENTMEMORY_III_CONFIG=");
    expect(execStart).toContain("AGENTMEMORY_VERBOSE=1");
    expect(service).toContain("EnvironmentFile=-%h/.agentmemory/.env");
    expect(ensure).toContain('am-daemon.sh" ensure');
    expect(ensure).toContain("TimeoutStartSec=90s");
    expect(timer).toContain("OnUnitActiveSec=2min");
    expect(timer).toContain("Unit=agentmemory-ensure.service");
    expect(systemctlLog).toContain("--user daemon-reload");
  });

  it("quotes checkout and binary paths accepted by systemd", () => {
    const { result, outputDir } = installUnits(true);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const units = [
      join(outputDir, "agentmemory.service"),
      join(outputDir, "agentmemory-ensure.service"),
      join(outputDir, "agentmemory-ensure.timer"),
    ];
    const service = readFileSync(units[0], "utf8");
    const ensure = readFileSync(units[1], "utf8");
    expect(service).toContain("WorkingDirectory=");
    expect(service).toContain("checkout with spaces");
    expect(service).toContain('Environment="PATH=');
    expect(service).toContain('ExecStart=/usr/bin/env ');
    expect(ensure).toContain("WorkingDirectory=");
    expect(ensure).toContain("checkout with spaces");

    const hasSystemdAnalyze = spawnSync("sh", ["-c", "command -v systemd-analyze"], {
      encoding: "utf8",
    }).status === 0;
    if (hasSystemdAnalyze) {
      const verification = spawnSync("systemd-analyze", ["verify", ...units], {
        encoding: "utf8",
      });

      expect(
        verification.status,
        verification.stderr || verification.stdout,
      ).toBe(0);
    }
  });
});
