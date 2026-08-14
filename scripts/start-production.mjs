import { spawn } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const nodeExecutable = process.execPath;
const nextCli = path.join(root, "node_modules", "next", "dist", "bin", "next");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const minimumRestartDelayMs = 5_000;
const maximumRestartDelayMs = 60_000;
const stableRuntimeMs = 60_000;

const services = [
  {
    name: "web",
    args: [nextCli, "start"],
    critical: true,
  },
  {
    name: "opportunity-finder-worker",
    args: [tsxCli, "scripts/opportunity-finder-worker.ts"],
    critical: false,
  },
  {
    name: "opportunity-finder-cleanup",
    args: [tsxCli, "scripts/cleanup-opportunity-finder.ts", "--loop"],
    critical: false,
  },
  {
    name: "business-summary-worker",
    args: [tsxCli, "scripts/business-summary-worker.ts"],
    critical: false,
  },
  {
    name: "observability-outbox-worker",
    args: [tsxCli, "scripts/observability-outbox-worker.ts"],
    critical: false,
  },
];

const children = new Map();
const restartTimers = new Set();
let stopping = false;
let resolveWebExit;
const webExit = new Promise((resolve) => {
  resolveWebExit = resolve;
});

function clearRestartTimers() {
  for (const timer of restartTimers) clearTimeout(timer);
  restartTimers.clear();
}

function stopAll(signal = "SIGTERM", exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  clearRestartTimers();
  for (const child of children.values()) {
    if (!child.killed) child.kill(signal);
  }
  resolveWebExit();
}

function scheduleRestart(service, attempt) {
  if (stopping) return;
  const delay = Math.min(
    minimumRestartDelayMs * (2 ** Math.min(attempt, 4)),
    maximumRestartDelayMs,
  );
  console.error(`${service.name} will restart in ${delay}ms.`);
  const timer = setTimeout(() => {
    restartTimers.delete(timer);
    startService(service, attempt);
  }, delay);
  restartTimers.add(timer);
}

function startService(service, attempt = 0) {
  if (stopping) return;
  const startedAt = Date.now();
  const child = spawn(nodeExecutable, service.args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  children.set(service.name, child);
  let handled = false;

  const handleTermination = (detail, spawnError = null) => {
    if (handled) return;
    handled = true;
    children.delete(service.name);
    if (stopping) return;

    if (spawnError) console.error(`${service.name} failed to start.`, spawnError);
    else console.error(`${service.name} exited unexpectedly (${detail}).`);

    if (service.critical) {
      stopAll("SIGTERM", 1);
      return;
    }

    const nextAttempt = Date.now() - startedAt >= stableRuntimeMs ? 0 : attempt + 1;
    scheduleRestart(service, nextAttempt);
  };

  child.once("error", (error) => handleTermination("spawn_error", error));
  child.once("exit", (code, signal) => {
    handleTermination(signal ?? code ?? "unknown");
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stopAll(signal, 0));
}

for (const service of services) startService(service);

await webExit;
