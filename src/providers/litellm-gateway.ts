import type { GatewayHealth, GatewayModel, LiteLlmEndpointConfig, LlmGateway } from "./types.ts";
import { ProviderResolutionError } from "./errors.ts";

export class LiteLlmGateway implements LlmGateway {
  private readonly baseUrl: string;
  private readonly apiKeyEnv?: string;
  private readonly timeoutMs: number;

  constructor(config: LiteLlmEndpointConfig) {
    validateEndpoint(config);
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKeyEnv = config.apiKeyEnv;
    this.timeoutMs = config.timeoutMs ?? 5_000;
  }

  async health(): Promise<GatewayHealth> {
    try {
      const response = await this.request("/health");
      return { status: response.ok ? "available" : "unavailable" };
    } catch {
      return { status: "unavailable" };
    }
  }

  async listModels(): Promise<GatewayModel[]> {
    let response: Response;
    try {
      response = await this.request("/v1/models");
    } catch (error) {
      throw new ProviderResolutionError("LiteLLMUnavailable", error instanceof Error ? error.message : String(error));
    }

    if (!response.ok) {
      throw new ProviderResolutionError("LiteLLMUnavailable", `LiteLLM model list returned HTTP ${response.status}`);
    }

    const body = await response.json().catch(() => undefined);
    if (!isModelListResponse(body)) {
      throw new ProviderResolutionError("InvalidLiteLLMResponse", "LiteLLM model list response is malformed.");
    }

    return body.data.map((model) => ({ id: model.id }));
  }

  private async request(path: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await fetch(`${this.baseUrl}${path}`, {
        headers: this.headers(),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(): Record<string, string> {
    if (!this.apiKeyEnv) return {};
    const apiKey = process.env[this.apiKeyEnv];
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }
}

function validateEndpoint(config: LiteLlmEndpointConfig): void {
  try {
    const url = new URL(config.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("baseUrl must use http or https");
    }
  } catch {
    throw new ProviderResolutionError("LiteLLMUnavailable", `Malformed LiteLLM base URL: ${config.baseUrl}`);
  }

  if (config.apiKeyEnv !== undefined && config.apiKeyEnv.trim() === "") {
    throw new ProviderResolutionError("LiteLLMUnavailable", "LiteLLM apiKeyEnv must not be empty.");
  }
}

function isModelListResponse(value: unknown): value is { data: Array<{ id: string }> } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { data?: unknown }).data) &&
    (value as { data: unknown[] }).data.every((item) => {
      return typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string";
    })
  );
}
