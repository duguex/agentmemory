import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
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

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DAEMON_SCRIPT = join(REPO_ROOT, "scripts", "am-daemon.sh");
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

function runEnsure(
  mode: "inactive-installed" | "unit-not-found",
  invokedBySystemd = false,
  healthDelayChecks = 0,
  waitSeconds = "45",
) {
  const home = mkdtempSync(join(tmpdir(), "agentmemory-ensure-test-"));
  temporaryDirectories.push(home);
  const fakeBin = join(home, "bin");
  const fakeRoot = join(home, "root");
  const state = join(home, "state");
  const systemctlLog = join(state, "systemctl.log");
  const agentmemoryLog = join(state, "agentmemory.log");
  const systemctlRestarted = join(state, "systemctl-restarted");
  const manualStarted = join(state, "manual-started");
  const healthChecks = join(state, "health-checks");

  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(join(fakeRoot, "dist"), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(fakeRoot, "iii-config.supervised.yaml"), "", "utf8");
  writeFileSync(join(home, "state-marker"), "", "utf8");
  writeFileSync(systemctlLog, "", "utf8");
  writeFileSync(agentmemoryLog, "", "utf8");
  writeFileSync(join(fakeRoot, "dist", "index.mjs"), "", "utf8");

  writeExecutable(
    join(fakeBin, "systemctl"),
    `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
if [[ "$*" == *show* && "$*" == *agentmemory.service* ]]; then
  if [[ "$SYSTEMD_UNIT_MODE" == loaded ]]; then
    printf 'loaded\\n'
    exit 0
  fi
  printf 'Unit agentmemory.service could not be found.\\n' >&2
  exit 1
fi
if [[ "$*" == *restart* && "$*" == *agentmemory.service* ]]; then
  touch "$SYSTEMCTL_RESTARTED"
  exit 0
fi
if [[ "$*" == *" is-active "* ]]; then
  exit 3
fi
exit 0
`,
  );

  writeExecutable(
    join(fakeBin, "curl"),
    `#!/usr/bin/env bash
set -u
if [[ ! -e "$SYSTEMCTL_RESTARTED" && ! -e "$MANUAL_STARTED" ]]; then
  for _ in {1..20}; do
    [[ -e "$SYSTEMCTL_RESTARTED" || -e "$MANUAL_STARTED" ]] && break
    /bin/sleep 0.01
  done
fi
if [[ ! -e "$SYSTEMCTL_RESTARTED" && ! -e "$MANUAL_STARTED" ]]; then
  exit 7
fi
if [[ -n "\${HEALTH_DELAY_CHECKS:-}" && -e "$SYSTEMCTL_RESTARTED" ]]; then
  checks=0
  [[ -f "$HEALTH_CHECKS" ]] && checks=$(cat "$HEALTH_CHECKS")
  checks=$((checks + 1))
  printf '%s\n' "$checks" > "$HEALTH_CHECKS"
  if (( checks <= HEALTH_DELAY_CHECKS )); then
    exit 7
  fi
fi
if [[ "$*" == *"/agentmemory/livez"* ]]; then
  printf '{"status":"ok"}\n'
else
  printf '{"health":{"workers":[{"pid":123}]}}\n'
fi
`,
  );

  writeExecutable(
    join(fakeBin, "pgrep"),
    `#!/usr/bin/env bash
printf '999999\\n'
exit 0
`,
  );

  writeExecutable(
    join(fakeBin, "sleep"),
    `#!/usr/bin/env bash
exit 0
`,
  );

  writeExecutable(
    join(fakeBin, "agentmemory"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$AGENTMEMORY_LOG"
if [[ "$*" == *"--verbose"* ]]; then
  touch "$MANUAL_STARTED"
fi
exit 0
`,
  );

  const result = spawnSync("bash", [DAEMON_SCRIPT, "ensure"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AGENTMEMORY_HOME: home,
      AGENTMEMORY_ROOT: fakeRoot,
      AGENTMEMORY_BIN: join(fakeBin, "agentmemory"),
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      SYSTEMCTL_LOG: systemctlLog,
      SYSTEMD_UNIT_MODE: mode === "inactive-installed" ? "loaded" : "missing",
      INVOCATION_ID: invokedBySystemd ? "test-invocation" : "",
      SYSTEMCTL_RESTARTED: systemctlRestarted,
      MANUAL_STARTED: manualStarted,
      HEALTH_CHECKS: healthChecks,
      HEALTH_DELAY_CHECKS: String(healthDelayChecks),
      AGENTMEMORY_ENSURE_WAIT_SECONDS: waitSeconds,
      AGENTMEMORY_LOG: agentmemoryLog,
    },
    encoding: "utf8",
    timeout: 10_000,
  });

  return {
    result,
    systemctlLog: readFileSync(systemctlLog, "utf8"),
    agentmemoryLog: readFileSync(agentmemoryLog, "utf8"),
    healthChecks: existsSync(healthChecks) ? readFileSync(healthChecks, "utf8") : "",
  };
}

describe("am-daemon ensure systemd ownership", () => {
  it("restarts an installed but inactive service and waits for delayed health", () => {
    const { result, systemctlLog, agentmemoryLog } = runEnsure("inactive-installed", true, 3);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(systemctlLog).toContain("show agentmemory.service");
    expect(
      systemctlLog,
      `systemctl=${systemctlLog} agentmemory=${agentmemoryLog} stdout=${result.stdout}`,
    ).toContain("restart agentmemory.service");
    expect(agentmemoryLog).toBe("");
  });

  it("does not probe again after the ensure deadline", () => {
    const { result, healthChecks } = runEnsure("inactive-installed", false, 0, "0");

    expect(result.status).not.toBe(0);
    expect(healthChecks).toBe("");
  });

  it("falls back to manual restart when the service unit is not installed", () => {
    const { result, systemctlLog, agentmemoryLog } = runEnsure("unit-not-found", false);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(systemctlLog).toContain("show agentmemory.service");
    expect(systemctlLog).not.toContain("restart agentmemory.service");
    expect(agentmemoryLog).toContain("--verbose");
  });

  it("refuses a background fallback when systemd owns the ensure invocation", () => {
    const { result, systemctlLog, agentmemoryLog } = runEnsure("unit-not-found", true);

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("refusing");
    expect(systemctlLog).toContain("show agentmemory.service");
    expect(systemctlLog).not.toContain("restart agentmemory.service");
    expect(agentmemoryLog).toBe("");
  });
});
