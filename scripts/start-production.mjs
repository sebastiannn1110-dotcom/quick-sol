import { spawn } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const nodeExecutable = process.execPath;
const nextCli = path.join(root, "node_modules", "next", "dist", "bin", "next");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

const processes = [
  {
    name: "web",
    child: spawn(nodeExecutable, [nextCli, "start"], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    }),
  },
  {
    name: "opportunity-finder-worker",
    child: spawn(
      nodeExecutable,
      [tsxCli, "scripts/opportunity-finder-worker.ts"],
      {
        cwd: root,
        env: process.env,
        stdio: "inherit",
      },
    ),
  },
  {
    name: "opportunity-finder-cleanup",
    child: spawn(
      nodeExecutable,
      [tsxCli, "scripts/cleanup-opportunity-finder.ts", "--loop"],
      {
        cwd: root,
        env: process.env,
        stdio: "inherit",
      },
    ),
  },
];

let stopping = false;

function stopAll(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const processEntry of processes) {
    if (!processEntry.child.killed) {
      processEntry.child.kill(signal);
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopAll(signal);
  });
}

for (const processEntry of processes) {
  processEntry.child.on("error", (error) => {
    console.error(`${processEntry.name} failed to start.`, error);
    stopAll();
    process.exitCode = 1;
  });

  processEntry.child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(
      `${processEntry.name} exited unexpectedly (${signal ?? code ?? "unknown"}).`,
    );
    stopAll();
    process.exitCode = code && code !== 0 ? code : 1;
  });
}

await Promise.all(
  processes.map(
    ({ child }) =>
      new Promise((resolve) => {
        child.once("exit", resolve);
      }),
  ),
);

process.exit(process.exitCode ?? 0);
