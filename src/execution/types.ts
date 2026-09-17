import type { MiddlewareExecution } from "../types.ts";

export type ModelMessageRole = "system" | "user" | "assistant";

export interface ModelMessage {
  role: ModelMessageRole;
  content: string;
}

export interface ModelExecutionRequest {
  runId: string;
  taskId: string;
  deployment: string;
  messages: ModelMessage[];
  parameters?: {
    temperature?: number;
    maxTokens?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface ModelExecutionResult {
  content: string;
  deployment: string;
  provider?: string;
  model?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  cost?: {
    amountUsd?: number;
    source?: string;
  };
  finishReason?: string;
  latencyMs: number;
  rawResponseId?: string;
  metadata?: Record<string, unknown>;
}

export type ModelExecutionFailureCode =
  | "LiteLLMUnavailable"
  | "RequestTimeout"
  | "AuthenticationFailure"
  | "RateLimited"
  | "DeploymentUnavailable"
  | "InvalidRequest"
  | "InvalidResponse"
  | "UpstreamProviderFailure"
  | "UnknownExecutionFailure";

export interface ModelExecutionError {
  code: ModelExecutionFailureCode;
  message: string;
  deployment: string;
  httpStatus?: number;
  upstreamCode?: string;
  retryable?: boolean;
}

export type ModelExecutionOutcome =
  | {
      status: "completed";
      result: ModelExecutionResult;
      audit: ModelExecutionAudit;
      middleware: {
        before?: MiddlewareExecution;
        after?: MiddlewareExecution;
      };
    }
  | {
      status: "denied";
      reason: string;
      middleware: {
        before?: MiddlewareExecution;
        after?: MiddlewareExecution;
      };
    }
  | {
      status: "requires-human";
      reason: string;
      middleware: {
        before?: MiddlewareExecution;
        after?: MiddlewareExecution;
      };
    }
  | {
      status: "failed";
      error: ModelExecutionError;
      audit?: ModelExecutionAudit;
      middleware: {
        before?: MiddlewareExecution;
        after?: MiddlewareExecution;
      };
    };

export interface ModelExecutor {
  execute(request: ModelExecutionRequest): Promise<ModelExecutionOutcome>;
}

export interface ModelExecutionAudit {
  runId: string;
  taskId: string;
  deployment: string;
  requestStartedAt: string;
  requestEndedAt: string;
  latencyMs: number;
  status: ModelExecutionOutcome["status"];
  provider?: string;
  model?: string;
  usage?: ModelExecutionResult["usage"];
  cost?: ModelExecutionResult["cost"];
  finishReason?: string;
  errorCategory?: ModelExecutionFailureCode;
}

export interface LiteLlmChatCompletionRequest {
  model: string;
  messages: ModelMessage[];
  temperature?: number;
  max_tokens?: number;
}

export interface LiteLlmChatCompletionResult {
  id?: string;
  model?: string;
  provider?: string;
  content: string;
  finishReason?: string;
  usage?: ModelExecutionResult["usage"];
  cost?: ModelExecutionResult["cost"];
}

export interface ModelGateway {
  chatCompletion(request: LiteLlmChatCompletionRequest, options: { timeoutMs: number }): Promise<LiteLlmChatCompletionResult>;
}

export interface LiteLlmModelExecutorConfig {
  baseUrl: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
}
