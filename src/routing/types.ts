import type { MiddlewareExecution } from "../types.ts";

export const MODEL_TIERS = ["cheap", "coding-fast", "coding-strong", "reasoning-strong", "reviewer"] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];

export type RoutingDecisionSource = "override" | "rule" | "default";

export interface RoutingInput {
  task: {
    type?: string;
    risk?: "low" | "medium" | "high";
  };
  spec?: {
    changeName?: string;
    metadata?: {
      goal?: string;
      affectedAreas?: string[];
      skipSpecs?: boolean;
    };
  };
  override?: {
    modelTier?: ModelTier;
  };
  metadata?: Record<string, unknown>;
}

export interface RoutingDecision {
  tier: ModelTier;
  reason: string;
  matchedRule?: string;
  source: RoutingDecisionSource;
  signals?: string[];
}

export interface RoutingRule {
  id: string;
  taskType: string;
  tier: ModelTier;
}

export interface RoutingConfig {
  defaultTier: ModelTier;
  rules: RoutingRule[];
}

export interface ModelRouter {
  route(input: RoutingInput): RoutingDecision;
}

export type RoutingStatus = "routed" | "middleware-denied" | "requires-human";

export interface RoutingAudit {
  inputSummary: {
    taskType?: string;
    risk?: string;
    changeName?: string;
    overrideTier?: string;
  };
  selectedTier: ModelTier;
  matchedRule?: string;
  decisionSource: RoutingDecisionSource;
  reason: string;
}

export interface MiddlewareRoutingResult {
  ok: boolean;
  status: RoutingStatus;
  decision?: RoutingDecision;
  error?: {
    code: RoutingStatus;
    message: string;
  };
  audit?: RoutingAudit;
  middleware: {
    before?: MiddlewareExecution;
    after?: MiddlewareExecution;
  };
}
