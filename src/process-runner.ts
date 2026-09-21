import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
      const resolved = resolveWindowsCommand(command, args);
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

function resolveWindowsCommand(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") {
    return { command, args };
  }

  if (command === "openspec") return resolveWindowsOpenSpec(command, args);
  if (command === "codex" || command === "claude") return resolveWindowsCmdShim(command, args);
  return { command, args };
}

function resolveWindowsOpenSpec(command: string, args: string[]): { command: string; args: string[] } {
  const shimPath = findWindowsCommand(`${command}.cmd`);

  if (!shimPath) {
    return { command, args };
  }

  const entrypoint = path.join(path.dirname(shimPath), "node_modules", "@fission-ai", "openspec", "bin", "openspec.js");
  if (!existsSync(entrypoint)) {
    return { command, args };
  }

  return { command: process.execPath, args: [entrypoint, ...args] };
}

function resolveWindowsCmdShim(command: string, args: string[]): { command: string; args: string[] } {
  const shimPath = findWindowsCommand(`${command}.cmd`);
  if (!shimPath) return { command, args };

  const nodeEntrypoint = nodeEntrypointFromCmdShim(shimPath);
  if (nodeEntrypoint) return { command: process.execPath, args: [nodeEntrypoint, ...args] };

  const commandLine = [shimPath, ...args].map(quoteCmdArgument).join(" ");
  return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/c", commandLine] };
}

function quoteCmdArgument(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return /[\s&()^|<>"]/.test(value) ? `"${escaped}"` : escaped;
}

function findWindowsCommand(name: string): string | undefined {
  for (const directory of (process.env.Path ?? process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }

  const located = spawnSync("where.exe", [name], { encoding: "utf8" });
  return located.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function nodeEntrypointFromCmdShim(shimPath: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(shimPath, "utf8");
  } catch {
    return undefined;
  }

  const explicit = content.match(/"[^"]*node(?:\.exe)?"\s+"([^"]+\.(?:js|mjs))"\s+%/i)?.[1];
  if (explicit && existsSync(explicit)) return explicit;

  const dp0Relative = content.match(/"%dp0%\\([^"]+\.(?:js|mjs))"/i)?.[1];
  if (!dp0Relative) return undefined;
  const resolved = path.resolve(path.dirname(shimPath), dp0Relative);
  return existsSync(resolved) ? resolved : undefined;
}
