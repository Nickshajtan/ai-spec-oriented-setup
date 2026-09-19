#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

const entrypoint = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const child = spawn(process.execPath, ["--experimental-strip-types", entrypoint, ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`Unable to start ai-spec: ${error.message}`);
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
});
