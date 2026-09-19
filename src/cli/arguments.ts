import path from "node:path";
import type { SupportedAgent } from "../launcher/types.ts";

export interface CliOptions {
  agent?: SupportedAgent;
  changeName?: string;
  projectPath: string;
  idea?: string;
  help: boolean;
  version: boolean;
}

export function parseCliArguments(argv: string[], cwd: string): CliOptions {
  const options: CliOptions = { projectPath: cwd, help: false, version: false };
  const idea: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--") {
      idea.push(...argv.slice(index + 1));
      break;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--version" || argument === "-v") {
      options.version = true;
      continue;
    }
    if (argument === "--agent") {
      const value = requiredValue(argv, ++index, "--agent");
      if (value !== "codex" && value !== "claude") throw new CliUsageError("--agent must be codex or claude.");
      options.agent = value;
      continue;
    }
    if (argument === "--change") {
      options.changeName = requiredValue(argv, ++index, "--change");
      continue;
    }
    if (argument === "--project") {
      options.projectPath = path.resolve(cwd, requiredValue(argv, ++index, "--project"));
      continue;
    }
    if (argument.startsWith("-")) throw new CliUsageError(`Unknown option: ${argument}`);
    idea.push(argument);
  }

  if (options.changeName?.includes("\0")) throw new CliUsageError("--change contains an invalid null byte.");
  options.idea = idea.length > 0 ? idea.join(" ") : undefined;
  return options;
}

export class CliUsageError extends Error {}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new CliUsageError(`${flag} requires a value.`);
  return value;
}
