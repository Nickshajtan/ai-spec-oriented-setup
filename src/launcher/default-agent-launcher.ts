import type { ProcessRunner } from "../process-runner.ts";
import { NodeProcessRunner } from "../process-runner.ts";
import { ClaudeAgentAdapter, CodexAgentAdapter, type AgentAdapter } from "./agent-adapter.ts";
import type { AgentAvailability, AgentLauncher, LaunchAgentInput, LaunchAgentResult, SupportedAgent } from "./types.ts";

const SIGNAL_EXIT_CODES = new Set([130, 143]);

export class DefaultAgentLauncher implements AgentLauncher {
  private readonly adapters: ReadonlyMap<SupportedAgent, AgentAdapter>;
  private readonly processRunner: ProcessRunner;

  constructor(
    processRunner: ProcessRunner = new NodeProcessRunner(),
    adapters: AgentAdapter[] = [new CodexAgentAdapter(), new ClaudeAgentAdapter()],
  ) {
    this.processRunner = processRunner;
    this.adapters = new Map(adapters.map((adapter) => [adapter.agent, adapter]));
  }

  async detect(): Promise<AgentAvailability[]> {
    return Promise.all([...this.adapters.values()].map((adapter) => adapter.detect(this.processRunner, process.cwd())));
  }

  async launch(input: LaunchAgentInput): Promise<LaunchAgentResult> {
    const availability = await this.detect();
    const selected = selectAgent(input.agent, availability);
    if (!selected.ok) return selected.result;

    const adapter = this.adapters.get(selected.agent);
    if (!adapter) {
      return { ok: false, status: "agent-unavailable", agent: selected.agent, message: `Unsupported agent: ${selected.agent}.` };
    }

    const result = await this.processRunner.run(adapter.executable, adapter.initialArgs(input), {
      cwd: input.projectRoot,
      stdio: "inherit",
    });
    if (result.exitCode === 0) return { ok: true, agent: selected.agent, exitCode: 0 };
    if (SIGNAL_EXIT_CODES.has(result.exitCode)) {
      return {
        ok: false,
        status: "interrupted",
        agent: selected.agent,
        exitCode: result.exitCode,
        message: `${displayName(selected.agent)} session was interrupted.`,
      };
    }
    return {
      ok: false,
      status: "agent-failed",
      agent: selected.agent,
      exitCode: result.exitCode,
      message: `${displayName(selected.agent)} exited unexpectedly with code ${result.exitCode}.`,
      diagnostic: result.error?.message || result.stderr || undefined,
    };
  }
}

function selectAgent(
  requested: SupportedAgent | undefined,
  availability: AgentAvailability[],
): { ok: true; agent: SupportedAgent } | { ok: false; result: LaunchAgentResult } {
  if (requested) {
    const match = availability.find((candidate) => candidate.agent === requested);
    if (match?.available) return { ok: true, agent: requested };
    return {
      ok: false,
      result: {
        ok: false,
        status: "agent-unavailable",
        agent: requested,
        message: `${displayName(requested)} CLI is not installed or unavailable. Install and authenticate it, then retry.`,
        diagnostic: match?.diagnostic,
      },
    };
  }

  const available = availability.filter((candidate) => candidate.available);
  if (available.length === 0) {
    return {
      ok: false,
      result: {
        ok: false,
        status: "no-agent",
        message: "No supported agent CLI is available. Install and authenticate Codex CLI or Claude Code CLI.",
        diagnostic: availability
          .map((candidate) => candidate.diagnostic)
          .filter(Boolean)
          .join(" "),
      },
    };
  }

  // Codex is the documented deterministic preference when both are installed.
  const codex = available.find((candidate) => candidate.agent === "codex");
  return { ok: true, agent: codex?.agent ?? available[0]!.agent };
}

function displayName(agent: SupportedAgent): string {
  return agent === "codex" ? "Codex" : "Claude Code";
}
