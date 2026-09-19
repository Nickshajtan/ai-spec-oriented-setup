import type { PolicyMiddleware, TransformerMiddleware } from "./types.ts";

export interface LimitsGuardConfig {
  maxInterviewTurns?: number;
  maxReviewIterations?: number;
  contextSizeWarningBytes?: number;
  artifactSizeWarningBytes?: number;
}

export function createLimitsGuard(config: LimitsGuardConfig = {}): PolicyMiddleware {
  return {
    id: "limits-guard",
    type: "policy",
    priority: 10,
    failureMode: "fail-closed",
    handler(context) {
      if (
        config.maxInterviewTurns !== undefined &&
        context.lifecycle?.interviewTurn !== undefined &&
        context.lifecycle.interviewTurn > config.maxInterviewTurns
      ) {
        return { action: "deny", reason: `Maximum interview turns exceeded: ${config.maxInterviewTurns}` };
      }

      if (
        config.maxReviewIterations !== undefined &&
        context.lifecycle?.reviewIteration !== undefined &&
        context.lifecycle.reviewIteration > config.maxReviewIterations
      ) {
        return { action: "deny", reason: `Maximum review iterations exceeded: ${config.maxReviewIterations}` };
      }

      return { action: "continue" };
    },
  };
}

export function createLimitWarnings(config: LimitsGuardConfig = {}): TransformerMiddleware {
  return {
    id: "limit-warnings",
    type: "transformer",
    priority: 90,
    failureMode: "fail-open",
    handler(context) {
      const warnings = [...(context.warnings ?? [])];

      if (config.contextSizeWarningBytes !== undefined) {
        const contextBytes = byteLength(JSON.stringify(context.metadata));
        if (contextBytes > config.contextSizeWarningBytes) {
          warnings.push(`Context size is ${contextBytes} bytes; warning threshold is ${config.contextSizeWarningBytes} bytes.`);
        }
      }

      const artifactBytes = numericMetadata(context.metadata.artifactSizeBytes);
      if (config.artifactSizeWarningBytes !== undefined && artifactBytes !== undefined && artifactBytes > config.artifactSizeWarningBytes) {
        warnings.push(`Artifact size is ${artifactBytes} bytes; warning threshold is ${config.artifactSizeWarningBytes} bytes.`);
      }

      return warnings.length === (context.warnings ?? []).length ? { action: "continue" } : { action: "modify", patch: { warnings } };
    },
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function numericMetadata(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
