import type { ProcessRunner } from "../process-runner.ts";
import type { AgentAvailability, LaunchAgentInput, SupportedAgent } from "./types.ts";

const DETECTION_TIMEOUT_MS = 5_000;

export interface AgentAdapter {
  readonly agent: SupportedAgent;
  readonly executable: string;
  detect(processRunner: ProcessRunner, cwd: string): Promise<AgentAvailability>;
  initialArgs(input: LaunchAgentInput): string[];
}

abstract class CliAgentAdapter implements AgentAdapter {
  abstract readonly agent: SupportedAgent;
  abstract readonly executable: string;
  protected abstract skillInvocation: string;

  async detect(processRunner: ProcessRunner, cwd: string): Promise<AgentAvailability> {
    const result = await processRunner.run(this.executable, ["--version"], {
      cwd,
      timeoutMs: DETECTION_TIMEOUT_MS,
    });
    if (result.exitCode === 0) {
      return {
        agent: this.agent,
        executable: this.executable,
        available: true,
        version: firstLine(result.stdout || result.stderr),
      };
    }
    return {
      agent: this.agent,
      executable: this.executable,
      available: false,
      diagnostic: result.timedOut
        ? `${this.executable} --version timed out.`
        : result.error?.code === "ENOENT"
          ? `${this.executable} executable was not found.`
          : firstLine(result.stderr) || `${this.executable} --version exited with code ${result.exitCode}.`,
    };
  }

  initialArgs(input: LaunchAgentInput): string[] {
    return [initialInstruction(this.skillInvocation, input)];
  }
}

export class CodexAgentAdapter extends CliAgentAdapter {
  readonly agent = "codex" as const;
  readonly executable = "codex";
  protected readonly skillInvocation = "$specifier";
}

export class ClaudeAgentAdapter extends CliAgentAdapter {
  readonly agent = "claude" as const;
  readonly executable = "claude";
  protected readonly skillInvocation = "/specifier";
}

function initialInstruction(skillInvocation: string, input: LaunchAgentInput): string {
  const lines = [
    `Explicitly invoke the project's ${skillInvocation} skill.`,
    "Use that skill to run the existing SpecificationWorkflow until it returns ready, needs input, or a structured failure.",
    "Do not implement the resulting feature.",
    "",
    `Project: ${input.projectRoot}`,
  ];
  if (input.changeName) lines.push(`Change: ${input.changeName}`);
  lines.push(`Idea: ${input.idea?.trim() || "Not supplied; ask the user for the rough feature idea."}`);
  return lines.join("\n");
}

function firstLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}
