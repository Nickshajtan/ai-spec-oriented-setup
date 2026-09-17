export type ModelMessageRole = "system" | "user" | "assistant";

export interface ModelMessage {
  role: ModelMessageRole;
  content: string;
}

export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  purpose?: "interview" | "review" | string;
  parameters?: {
    temperature?: number;
    maxTokens?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface ModelResponse {
  content: string;
  model?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  finishReason?: string;
  rawResponseId?: string;
  metadata?: Record<string, unknown>;
}

export type ModelFailureCode =
  | "LiteLLMUnavailable"
  | "RequestTimeout"
  | "AuthenticationFailure"
  | "RateLimited"
  | "ModelUnavailable"
  | "InvalidRequest"
  | "InvalidResponse"
  | "UpstreamFailure"
  | "UnknownFailure";

export interface ModelError {
  code: ModelFailureCode;
  message: string;
  model: string;
  httpStatus?: number;
  upstreamCode?: string;
  retryable?: boolean;
}

export interface ModelPort {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface LiteLLMModelAdapterConfig {
  baseUrl: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
}
