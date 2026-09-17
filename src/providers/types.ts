import type { ModelTier, RoutingDecision } from "../routing/types.ts";
import type { MiddlewareExecution } from "../types.ts";

export type DeploymentAvailability = "configured" | "available" | "unavailable" | "unknown";

export type ProviderResolutionSource = "config" | "override";

export type ProviderResolutionFailureCode =
  | "UnknownModelTier"
  | "MissingTierConfiguration"
  | "UnknownDeployment"
  | "LiteLLMUnavailable"
  | "InvalidLiteLLMResponse"
  | "NoCandidateDeployment";

export interface DeploymentRef {
  deployment: string;
  provider?: string;
  model?: string;
  availability: DeploymentAvailability;
}

export interface ProviderResolutionContext {
  override?: {
    deployment?: string;
  };
  checkAvailability?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ProviderResolutionResult {
  logicalTier: ModelTier;
  selected: DeploymentRef;
  fallbacks: DeploymentRef[];
  source: ProviderResolutionSource;
  reason: string;
  gatewayStatus?: "not-checked" | "available" | "unavailable" | "invalid-response";
}

export interface ProviderResolver {
  resolve(decision: RoutingDecision, context?: ProviderResolutionContext): Promise<ProviderResolutionResult>;
}

export interface TierDeploymentPolicy {
  primary: string;
  fallbacks?: string[];
}

export interface ProviderPolicyConfig {
  tiers: Partial<Record<ModelTier, TierDeploymentPolicy>>;
}

export interface LiteLlmDeploymentConfig {
  deployment: string;
  provider?: string;
  model?: string;
}

export interface LiteLlmEndpointConfig {
  baseUrl: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
}

export interface LiteLlmResolverConfig {
  policy: ProviderPolicyConfig;
  deployments: LiteLlmDeploymentConfig[];
  endpoint?: LiteLlmEndpointConfig;
}

export interface GatewayHealth {
  status: "available" | "unavailable";
}

export interface GatewayModel {
  id: string;
}

export interface LlmGateway {
  health?(): Promise<GatewayHealth>;
  listModels?(): Promise<GatewayModel[]>;
}

export interface ProviderResolutionAudit {
  logicalTier: ModelTier;
  selectedDeployment: string;
  provider?: string;
  model?: string;
  fallbackChain: string[];
  resolutionSource: ProviderResolutionSource;
  reason: string;
  gatewayStatus?: ProviderResolutionResult["gatewayStatus"];
}

export type ProviderResolutionStatus = "resolved" | "middleware-denied" | "requires-human" | "failed";

export interface MiddlewareProviderResolutionResult {
  ok: boolean;
  status: ProviderResolutionStatus;
  result?: ProviderResolutionResult;
  error?: {
    code: ProviderResolutionStatus | ProviderResolutionFailureCode;
    message: string;
  };
  audit?: ProviderResolutionAudit;
  middleware: {
    before?: MiddlewareExecution;
    after?: MiddlewareExecution;
  };
}
