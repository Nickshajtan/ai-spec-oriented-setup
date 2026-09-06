import type { SemanticEvent } from "./events.ts";

export interface MiddlewareContext {
  runId: string;
  taskId: string;
  event: SemanticEvent;
  task?: {
    type?: string;
    risk?: string;
  };
  routing?: {
    modelTier?: string;
    provider?: string;
    model?: string;
  };
  budget?: {
    maxCostUsd?: number;
    spentUsd?: number;
  };
  metadata: Record<string, unknown>;
}

export type ContextPatch = Partial<Omit<MiddlewareContext, "runId" | "taskId" | "event">>;

export type MiddlewareAction = "continue" | "modify" | "deny" | "require-human";

export type MiddlewareResult =
  | { action: "continue" }
  | { action: "modify"; patch: ContextPatch }
  | { action: "deny"; reason: string }
  | { action: "require-human"; reason: string };

export type ObserverResult = void | { action: "continue" };
export type PolicyResult =
  | { action: "continue" }
  | { action: "deny"; reason: string }
  | { action: "require-human"; reason: string };
export type TransformerResult =
  | { action: "continue" }
  | { action: "modify"; patch: ContextPatch };

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

export interface AuditRecord {
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

export interface AuditSink {
  record(entry: AuditRecord): void;
}

export interface MiddlewareExecution {
  context: MiddlewareContext;
  result: MiddlewareResult;
  audit: AuditRecord[];
}
