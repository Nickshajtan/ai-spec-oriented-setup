import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface ProcessRunOptions {
  cwd: string;
  timeoutMs?: number;
  stdio?: "pipe" | "inherit";
}

export interface ProcessResult {
  exitCode: number;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
  timedOut?: boolean;
}

export interface ProcessRunner {
  run(command: string, args: string[], options: ProcessRunOptions): Promise<ProcessResult>;
}

export class NodeProcessRunner implements ProcessRunner {
  run(command: string, args: string[], options: ProcessRunOptions): Promise<ProcessResult> {
    return new Promise((resolve) => {
      const resolved = resolveWindowsNpmCli(command, args);
      const child = spawn(resolved.command, resolved.args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: options.stdio ?? "pipe",
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;

      const timeout =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              child.kill();
            }, options.timeoutMs);

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });

      child.on("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve({ exitCode: -1, stdout, stderr, error, timedOut });
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve({ exitCode: code ?? -1, signal: signal ?? undefined, stdout, stderr, timedOut });
      });
    });
  }
}

function resolveWindowsNpmCli(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32" || command !== "openspec") {
    return { command, args };
  }

  const located = spawnSync("where.exe", ["openspec.cmd"], { encoding: "utf8" });
  const shimPath = located.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!shimPath) {
    return { command, args };
  }

  const entrypoint = path.join(path.dirname(shimPath), "node_modules", "@fission-ai", "openspec", "bin", "openspec.js");
  if (!existsSync(entrypoint)) {
    return { command, args };
  }

  return { command: process.execPath, args: [entrypoint, ...args] };
}
