import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  createDevelopmentServerUrl,
  parseDevelopmentPort,
} from "../electron/development-config.mjs";

function requireWorkspacePath(value) {
  if (typeof value !== "string" || !value || !path.isAbsolute(value)) {
    throw new TypeError("CONDUCTOR_WORKSPACE_PATH doit être un chemin absolu.");
  }
  return path.resolve(value);
}

function quoteForShell(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function run() {
  const port = parseDevelopmentPort(process.env.CONDUCTOR_PORT);
  const workspacePath = requireWorkspacePath(process.env.CONDUCTOR_WORKSPACE_PATH);
  const userDataPath = path.join(workspacePath, ".context", "vibedeck-dev", "user-data");
  await mkdir(userDataPath, { recursive: true });

  const env = {
    ...process.env,
    VIBEDECK_DEV_SERVER_PORT: String(port),
    VITE_DEV_SERVER_URL: createDevelopmentServerUrl(port),
  };
  delete env.VIBEDECK_DB_PATH;

  const viteCommand = "vite --host 127.0.0.1";
  const electronCommand = [
    `wait-on tcp:127.0.0.1:${port}`,
    "&&",
    "electron",
    `--user-data-dir=${quoteForShell(userDataPath)}`,
    ".",
  ].join(" ");
  const child = spawn(
    "concurrently",
    ["-k", "-s", "first", "--names", "vite,electron", viteCommand, electronCommand],
    { cwd: workspacePath, env, stdio: "inherit" },
  );

  let stopping = false;
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      stopping = true;
      child.kill(signal);
    });
  }

  child.once("error", (error) => {
    console.error("Démarrage Conductor impossible :", error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = stopping ? 0 : (code ?? (signal ? 1 : 0));
  });
}

run().catch((error) => {
  console.error("Démarrage Conductor impossible :", error.message);
  process.exitCode = 1;
});
