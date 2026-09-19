import { modelError, ModelInvocationError } from "./errors.ts";
import type { LiteLLMModelAdapterConfig, ModelFailureCode, ModelMessage, ModelPort, ModelRequest, ModelResponse } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const ALLOWED_ROLES = new Set(["system", "user", "assistant"]);

export class LiteLLMModelAdapter implements ModelPort {
  private readonly baseUrl: string;
  private readonly apiKeyEnv?: string;
  private readonly timeoutMs: number;

  constructor(config: LiteLLMModelAdapterConfig) {
    validateConfig(config);
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKeyEnv = config.apiKeyEnv;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    validateRequest(request);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          temperature: request.parameters?.temperature,
          max_tokens: request.parameters?.maxTokens,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new ModelInvocationError(
          modelError("RequestTimeout", `LiteLLM request timed out after ${this.timeoutMs}ms.`, request.model, { retryable: true }),
        );
      }

      throw new ModelInvocationError(
        modelError("LiteLLMUnavailable", "LiteLLM endpoint is unavailable.", request.model, { retryable: true }),
      );
    } finally {
      clearTimeout(timeout);
    }

    const body = await readJsonBody(response);
    if (!response.ok) {
      throw new ModelInvocationError(mapHttpFailure(response.status, request.model, body));
    }

    return normalizeLiteLLMResponse(body, request.model, request.metadata);
  }

  private authHeaders(): Record<string, string> {
    if (!this.apiKeyEnv) return {};
    const apiKey = process.env[this.apiKeyEnv];
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }
}

function validateConfig(config: LiteLLMModelAdapterConfig): void {
  try {
    const url = new URL(config.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("baseUrl must use http or https");
    }
  } catch {
    throw new ModelInvocationError(modelError("LiteLLMUnavailable", `Malformed LiteLLM base URL: ${config.baseUrl}`, "unknown"));
  }

  if (config.apiKeyEnv !== undefined && config.apiKeyEnv.trim() === "") {
    throw new ModelInvocationError(modelError("LiteLLMUnavailable", "LiteLLM apiKeyEnv must not be empty.", "unknown"));
  }
}

function validateRequest(request: ModelRequest): void {
  if (!request.model.trim()) {
    throw new ModelInvocationError(modelError("InvalidRequest", "Model request requires a model.", request.model));
  }

  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new ModelInvocationError(modelError("InvalidRequest", "Model request requires at least one message.", request.model));
  }

  for (const message of request.messages) {
    if (!isValidMessage(message)) {
      throw new ModelInvocationError(modelError("InvalidRequest", "Model message has unsupported role or content.", request.model));
    }
  }

  const temperature = request.parameters?.temperature;
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new ModelInvocationError(modelError("InvalidRequest", "temperature must be between 0 and 2.", request.model));
  }

  const maxTokens = request.parameters?.maxTokens;
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
    throw new ModelInvocationError(modelError("InvalidRequest", "maxTokens must be a positive integer.", request.model));
  }
}

function isValidMessage(value: unknown): value is ModelMessage {
  return (
    isObject(value) &&
    typeof value.role === "string" &&
    ALLOWED_ROLES.has(value.role) &&
    typeof value.content === "string" &&
    value.content.length > 0
  );
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return undefined;

  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function mapHttpFailure(status: number, model: string, body: unknown) {
  const upstreamCode = safeUpstreamCode(body);
  const message = safeErrorMessage(body) ?? `LiteLLM returned HTTP ${status}.`;
  const code: ModelFailureCode =
    status === 401 || status === 403
      ? "AuthenticationFailure"
      : status === 429
        ? "RateLimited"
        : status === 404
          ? "ModelUnavailable"
          : status >= 500
            ? "UpstreamFailure"
            : "InvalidRequest";

  return modelError(code, message, model, {
    httpStatus: status,
    upstreamCode,
    retryable: code === "RateLimited" || code === "UpstreamFailure" || code === "LiteLLMUnavailable",
  });
}

function normalizeLiteLLMResponse(body: unknown, requestedModel: string, metadata?: Record<string, unknown>): ModelResponse {
  if (!isObject(body)) {
    throw new ModelInvocationError(modelError("InvalidResponse", "LiteLLM response body is malformed.", requestedModel));
  }

  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ModelInvocationError(modelError("InvalidResponse", "LiteLLM response has no choices.", requestedModel));
  }

  const first = choices[0];
  const content =
    isObject(first) && isObject(first.message) && typeof first.message.content === "string" ? first.message.content : undefined;
  if (content === undefined) {
    throw new ModelInvocationError(modelError("InvalidResponse", "LiteLLM response choice content is missing.", requestedModel));
  }

  return {
    content,
    model: typeof body.model === "string" ? body.model : undefined,
    usage: normalizeUsage(body.usage),
    finishReason: isObject(first) && typeof first.finish_reason === "string" ? first.finish_reason : undefined,
    rawResponseId: typeof body.id === "string" ? body.id : undefined,
    metadata,
  };
}

function normalizeUsage(value: unknown): ModelResponse["usage"] {
  if (!isObject(value)) return undefined;

  const usage = {
    inputTokens: numberField(value.prompt_tokens),
    outputTokens: numberField(value.completion_tokens),
    totalTokens: numberField(value.total_tokens),
  };

  return Object.values(usage).some((item) => item !== undefined) ? usage : undefined;
}

function safeUpstreamCode(body: unknown): string | undefined {
  if (!isObject(body) || !isObject(body.error)) return undefined;
  const code = body.error.code;
  return typeof code === "string" ? code : undefined;
}

function safeErrorMessage(body: unknown): string | undefined {
  if (!isObject(body) || !isObject(body.error)) return undefined;
  const message = body.error.message;
  return typeof message === "string" ? redactSecrets(message) : undefined;
}

function redactSecrets(value: string): string {
  return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
