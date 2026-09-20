import { stat } from "node:fs/promises";
import { createSpecifierRuntime } from "./composition.ts";
import type { RuntimeResult } from "./types.ts";

export interface CoreCliIo {
  stdin(): Promise<string>;
  stdout(message: string): void;
  stderr(message: string): void;
}

export async function runCoreCli(argv: string[], io: CoreCliIo = processIo): Promise<number> {
  const command = argv[0];
  if (command === "--help" || command === "-h" || command === undefined) {
    io.stdout(helpText);
    return command === undefined ? 2 : 0;
  }

  let input: unknown;
  try {
    input = await readInput(argv.slice(1), io);
  } catch (error) {
    writeJson(io, failed("invalid-runtime-request", error instanceof Error ? error.message : "Invalid runtime request."));
    return 2;
  }

  let result: RuntimeResult;
  try {
    const runtime = createSpecifierRuntime();
    if (command === "start") result = await runtime.start(requireObject(input));
    else if (command === "answer") result = await runtime.answer(requireObject(input));
    else if (command === "status") result = await runtime.status(requireObject(input));
    else {
      writeJson(io, failed("invalid-runtime-command", `Unknown ai-spec-core command: ${command}`));
      return 2;
    }
  } catch (error) {
    result = failed("runtime-configuration", error instanceof Error ? error.message : "Runtime could not be configured.");
  }

  writeJson(io, result);
  return result.status === "failed" ? 1 : 0;
}

async function readInput(argv: string[], io: CoreCliIo): Promise<unknown> {
  const inputIndex = argv.indexOf("--input-json");
  if (inputIndex !== -1) return JSON.parse(argv[inputIndex + 1] ?? "");

  const stdin = await io.stdin();
  if (!stdin.trim()) throw new Error("Runtime JSON input is required on stdin or --input-json.");
  return JSON.parse(stdin);
}

function requireObject(value: unknown): any {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Runtime input must be a JSON object.");
  }
  return value;
}

function writeJson(io: CoreCliIo, result: RuntimeResult): void {
  io.stdout(JSON.stringify(result, null, 2));
}

function failed(code: string, message: string): RuntimeResult {
  return { status: "failed", error: { code, message } };
}

const processIo: CoreCliIo = {
  async stdin() {
    const chunks: Buffer[] = [];
    if ((await stat("/dev/stdin").catch(() => undefined))?.isFile()) return "";
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  },
  stdout(message) {
    process.stdout.write(`${message}\n`);
  },
  stderr(message) {
    process.stderr.write(`${message}\n`);
  },
};

const helpText = `Usage: ai-spec-core <start|answer|status> [--input-json <json>]

Reads one JSON request and writes one structured JSON result to stdout.
Diagnostics are written to stderr. The runtime does not prompt interactively.`;
