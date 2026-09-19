export type SupportedAgent = "codex" | "claude";

export interface AgentAvailability {
  agent: SupportedAgent;
  available: boolean;
  executable: string;
  version?: string;
  diagnostic?: string;
}

export interface LaunchAgentInput {
  projectRoot: string;
  idea?: string;
  changeName?: string;
  agent?: SupportedAgent;
}

export type LaunchAgentResult =
  | { ok: true; agent: SupportedAgent; exitCode: 0 }
  | {
      ok: false;
      status: "no-agent" | "agent-unavailable" | "agent-failed" | "interrupted";
      message: string;
      agent?: SupportedAgent;
      exitCode?: number;
      diagnostic?: string;
    };

export interface AgentLauncher {
  detect(): Promise<AgentAvailability[]>;
  launch(input: LaunchAgentInput): Promise<LaunchAgentResult>;
}
