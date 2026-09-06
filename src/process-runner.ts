import { spawn } from "node:child_process";

export interface ProcessRunOptions {
  cwd: string;
  timeoutMs?: number;
}

export interface ProcessResult {
  exitCode: number;
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
      const child = spawn(command, args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
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

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
      });
    });
  }
}
