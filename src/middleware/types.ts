import type { SpecifierEvent } from "../events.ts";

export interface MiddlewareContext {
  runId: string;
  subjectId: string;
  event: SpecifierEvent;
  lifecycle?: {
    interviewTurn?: number;
    reviewIteration?: number;
  };
  warnings?: string[];
  metadata: Record<string, unknown>;
}

export type ContextPatch = Partial<Pick<MiddlewareContext, "lifecycle" | "warnings" | "metadata">>;

export type MiddlewareAction = "continue" | "modify" | "deny" | "require-human";

export type MiddlewareResult =
  | { action: "continue" }
  | { action: "modify"; patch: ContextPatch }
  | { action: "deny"; reason: string }
  | { action: "require-human"; reason: string };

export type ObserverResult = void | { action: "continue" };
export type PolicyResult = { action: "continue" } | { action: "deny"; reason: string } | { action: "require-human"; reason: string };
export type TransformerResult = { action: "continue" } | { action: "modify"; patch: ContextPatch };

export type MiddlewareType = "observer" | "policy" | "transformer";
export type FailureMode = "fail-open" | "fail-closed";

interface MiddlewareBase {
  id: string;
  priority: number;
  failureMode?: FailureMode;
}

export interface ObserverMiddleware extends MiddlewareBase {
  type: "observer";
  handler: (context: Readonly<MiddlewareContext>) => ObserverResult | Promise<ObserverResult>;
}

export interface PolicyMiddleware extends MiddlewareBase {
  type: "policy";
  handler: (context: Readonly<MiddlewareContext>) => PolicyResult | Promise<PolicyResult>;
}

export interface TransformerMiddleware extends MiddlewareBase {
  type: "transformer";
  handler: (context: Readonly<MiddlewareContext>) => TransformerResult | Promise<TransformerResult>;
}

export type Middleware = ObserverMiddleware | PolicyMiddleware | TransformerMiddleware;

export interface MiddlewareRecord {
  event: string;
  middlewareId: string;
  middlewareType: MiddlewareType;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  resultAction: MiddlewareAction;
  error?: {
    name: string;
    message: string;
  };
}

export interface MiddlewareExecution {
  context: MiddlewareContext;
  result: MiddlewareResult;
  records: MiddlewareRecord[];
}
