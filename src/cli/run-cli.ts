import { realpath, stat } from "node:fs/promises";
import { DefaultAgentLauncher } from "../launcher/default-agent-launcher.ts";
import type { AgentLauncher } from "../launcher/types.ts";
import { CliUsageError, parseCliArguments } from "./arguments.ts";

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export async function runCli(
  argv: string[],
  options: { cwd?: string; launcher?: AgentLauncher; io?: CliIo; version?: string } = {},
): Promise<number> {
  const io = options.io ?? consoleIo;
  let parsed;
  try {
    parsed = parseCliArguments(argv, options.cwd ?? process.cwd());
  } catch (error) {
    io.stderr(error instanceof CliUsageError ? error.message : "Invalid command-line arguments.");
    io.stderr("Run ai-spec --help for usage.");
    return 2;
  }

  if (parsed.help) {
    io.stdout(helpText);
    return 0;
  }
  if (parsed.version) {
    io.stdout(options.version ?? "0.1.0");
    return 0;
  }

  const project = await resolveProject(parsed.projectPath);
  if (!project.ok) {
    io.stderr(project.message);
    return 2;
  }

  const result = await (options.launcher ?? new DefaultAgentLauncher()).launch({
    agent: parsed.agent,
    changeName: parsed.changeName,
    idea: parsed.idea,
    projectRoot: project.path,
  });
  if (result.ok) return 0;
  io.stderr(result.message);
  if (result.diagnostic) io.stderr(result.diagnostic);
  return result.status === "interrupted" ? (result.exitCode ?? 130) : 1;
}

async function resolveProject(projectPath: string): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  try {
    const path = await realpath(projectPath);
    if (!(await stat(path)).isDirectory()) return { ok: false, message: `Project path is not a directory: ${projectPath}` };
    return { ok: true, path };
  } catch {
    return { ok: false, message: `Project path does not exist or is inaccessible: ${projectPath}` };
  }
}

const consoleIo: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

const helpText = `Usage: ai-spec [options] [idea]

Launch a supported host agent and explicitly invoke the project Specifier skill.

Options:
  --agent <codex|claude>  Select the host agent (never falls back)
  --change <name>         Preserve an explicit OpenSpec change name
  --project <path>        Project root (default: current directory)
  --help, -h              Show help
  --version, -v           Show version`;
