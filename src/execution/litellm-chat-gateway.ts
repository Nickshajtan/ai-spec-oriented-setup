import { executionError, ModelExecutionFailure } from "./errors.ts";
import type {
  LiteLlmChatCompletionRequest,
  LiteLlmChatCompletionResult,
  LiteLlmModelExecutorConfig,
  ModelExecutionFailureCode,
  ModelGateway,
} from "./types.ts";

export class LiteLlmChatGateway implements ModelGateway {
  private readonly baseUrl: string;
  private readonly apiKeyEnv?: string;

  constructor(config: LiteLlmModelExecutorConfig) {
    validateConfig(config);
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKeyEnv = config.apiKeyEnv;
  }

  async chatCompletion(
    request: LiteLlmChatCompletionRequest,
    options: { timeoutMs: number },
  ): Promise<LiteLlmChatCompletionResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new ModelExecutionFailure(
          executionError("RequestTimeout", `LiteLLM request timed out after ${options.timeoutMs}ms.`, request.model, {
            retryable: true,
          }),
        );
      }

      throw new ModelExecutionFailure(
        executionError("LiteLLMUnavailable", "LiteLLM endpoint is unavailable.", request.model, { retryable: true }),
      );
    } finally {
      clearTimeout(timeout);
    }

    const body = await readJsonBody(response);
    if (!response.ok) {
      throw new ModelExecutionFailure(mapHttpFailure(response.status, request.model, body));
    }

    return normalizeLiteLlmResponse(body, request.model);
  }

  private authHeaders(): Record<string, string> {
    if (!this.apiKeyEnv) return {};
    const apiKey = process.env[this.apiKeyEnv];
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }
}

function validateConfig(config: LiteLlmModelExecutorConfig): void {
  try {
    const url = new URL(config.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("baseUrl must use http or https");
    }
  } catch {
    throw new ModelExecutionFailure(
      executionError("LiteLLMUnavailable", `Malformed LiteLLM base URL: ${config.baseUrl}`, "unknown", {
        retryable: false,
      }),
    );
  }

  if (config.apiKeyEnv !== undefined && config.apiKeyEnv.trim() === "") {
    throw new ModelExecutionFailure(
      executionError("LiteLLMUnavailable", "LiteLLM apiKeyEnv must not be empty.", "unknown", { retryable: false }),
    );
  }
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

function mapHttpFailure(status: number, deployment: string, body: unknown) {
  const upstreamCode = safeUpstreamCode(body);
  const message = safeErrorMessage(body) ?? `LiteLLM returned HTTP ${status}.`;
  const code: ModelExecutionFailureCode =
    status === 401 || status === 403
      ? "AuthenticationFailure"
      : status === 429
        ? "RateLimited"
        : status === 404
          ? "DeploymentUnavailable"
          : status >= 500
            ? "UpstreamProviderFailure"
            : "InvalidRequest";

  return executionError(code, message, deployment, {
    httpStatus: status,
    upstreamCode,
    retryable: code === "RateLimited" || code === "UpstreamProviderFailure" || code === "LiteLLMUnavailable",
  });
}

function normalizeLiteLlmResponse(body: unknown, deployment: string): LiteLlmChatCompletionResult {
  if (!isObject(body)) {
    throw new ModelExecutionFailure(executionError("InvalidResponse", "LiteLLM response body is malformed.", deployment));
  }

  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ModelExecutionFailure(executionError("InvalidResponse", "LiteLLM response has no choices.", deployment));
  }

  const first = choices[0];
  const content = isObject(first) && isObject(first.message) && typeof first.message.content === "string" ? first.message.content : undefined;
  if (content === undefined) {
    throw new ModelExecutionFailure(executionError("InvalidResponse", "LiteLLM response choice content is missing.", deployment));
  }

  return {
    id: typeof body.id === "string" ? body.id : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
    provider: typeof body.provider === "string" ? body.provider : undefined,
    content,
    finishReason: isObject(first) && typeof first.finish_reason === "string" ? first.finish_reason : undefined,
    usage: normalizeUsage(body.usage),
    cost: normalizeCost(body),
  };
}

function normalizeUsage(value: unknown): LiteLlmChatCompletionResult["usage"] {
  if (!isObject(value)) return undefined;

  const usage = {
    inputTokens: numberField(value.prompt_tokens),
    outputTokens: numberField(value.completion_tokens),
    totalTokens: numberField(value.total_tokens),
  };

  return Object.values(usage).some((item) => item !== undefined) ? usage : undefined;
}

function normalizeCost(body: Record<string, unknown>): LiteLlmChatCompletionResult["cost"] {
  const cost =
    numberField(body._hidden_params && isObject(body._hidden_params) ? body._hidden_params.response_cost : undefined) ??
    numberField(body.response_cost);

  return cost === undefined ? undefined : { amountUsd: cost, source: "litellm" };
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
