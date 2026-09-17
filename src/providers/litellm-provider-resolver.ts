import { MiddlewareBus } from "../bus.ts";
import type { ModelTier, RoutingDecision } from "../routing/types.ts";
import type { MiddlewareContext } from "../types.ts";
import { ProviderResolutionError } from "./errors.ts";
import { LiteLlmGateway } from "./litellm-gateway.ts";
import {
  type DeploymentAvailability,
  type DeploymentRef,
  type LiteLlmDeploymentConfig,
  type LiteLlmResolverConfig,
  type LlmGateway,
  type MiddlewareProviderResolutionResult,
  type ProviderResolutionAudit,
  type ProviderResolutionContext,
  type ProviderResolutionResult,
  type ProviderResolver,
  type TierDeploymentPolicy,
} from "./types.ts";
import { MODEL_TIERS, type RoutingDecisionSource } from "../routing/types.ts";

export const EXAMPLE_LITELLM_RESOLVER_CONFIG: LiteLlmResolverConfig = {
  policy: {
    tiers: {
      cheap: {
        primary: "cheap-primary",
        fallbacks: ["cheap-fallback"],
      },
      "coding-fast": {
        primary: "coding-fast-primary",
        fallbacks: ["coding-fast-fallback"],
      },
      "coding-strong": {
        primary: "coding-strong-primary",
        fallbacks: ["coding-strong-fallback"],
      },
      "reasoning-strong": {
        primary: "reasoning-primary",
        fallbacks: ["reasoning-fallback"],
      },
      reviewer: {
        primary: "reviewer-primary",
        fallbacks: ["reviewer-fallback"],
      },
    },
  },
  deployments: [
    { deployment: "cheap-primary", provider: "openai", model: "openai/example-cheap" },
    { deployment: "cheap-fallback", provider: "openrouter", model: "openrouter/example-cheap" },
    { deployment: "coding-fast-primary", provider: "openai", model: "openai/example-fast" },
    { deployment: "coding-fast-fallback", provider: "openrouter", model: "openrouter/example-fast" },
    { deployment: "coding-strong-primary", provider: "bedrock", model: "bedrock/example-claude" },
    { deployment: "coding-strong-fallback", provider: "openrouter", model: "openrouter/example-strong" },
    { deployment: "reasoning-primary", provider: "bedrock", model: "bedrock/example-reasoning" },
    { deployment: "reasoning-fallback", provider: "openrouter", model: "openrouter/example-reasoning" },
    { deployment: "reviewer-primary", provider: "bedrock", model: "bedrock/example-reviewer" },
    { deployment: "reviewer-fallback", provider: "openrouter", model: "openrouter/example-reviewer" },
  ],
  endpoint: {
    baseUrl: "http://localhost:4000",
    apiKeyEnv: "LITELLM_API_KEY",
  },
};

export class LiteLlmProviderResolver implements ProviderResolver {
  private readonly config: LiteLlmResolverConfig;
  private readonly deploymentsByName: Map<string, LiteLlmDeploymentConfig>;
  private readonly gateway?: LlmGateway;

  constructor(config: LiteLlmResolverConfig, options: { gateway?: LlmGateway } = {}) {
    validateResolverConfig(config);
    this.config = structuredClone(config);
    this.deploymentsByName = new Map(this.config.deployments.map((deployment) => [deployment.deployment, deployment]));
    this.gateway = options.gateway ?? (config.endpoint ? new LiteLlmGateway(config.endpoint) : undefined);
  }

  async resolve(decision: RoutingDecision, context: ProviderResolutionContext = {}): Promise<ProviderResolutionResult> {
    const logicalTier = validateTier(decision.tier);
    const availability = await this.availability(context.checkAvailability === true);

    if (context.override?.deployment) {
      const deployment = this.deploymentsByName.get(context.override.deployment);
      if (!deployment) {
        throw new ProviderResolutionError("UnknownDeployment", `Unknown deployment override: ${context.override.deployment}`);
      }

      const selected = this.toDeploymentRef(deployment, availability);
      return {
        logicalTier,
        selected,
        fallbacks: [],
        source: "override",
        reason: `Explicit deployment override selected ${deployment.deployment}.`,
        gatewayStatus: availability.gatewayStatus,
      };
    }

    const tierPolicy = this.config.policy.tiers[logicalTier];
    if (!tierPolicy) {
      throw new ProviderResolutionError("MissingTierConfiguration", `No deployment policy configured for tier: ${logicalTier}`);
    }

    const chain = [tierPolicy.primary, ...(tierPolicy.fallbacks ?? [])];
    if (chain.length === 0) {
      throw new ProviderResolutionError("NoCandidateDeployment", `No candidate deployments configured for tier: ${logicalTier}`);
    }

    const candidates = chain.map((deploymentName) => {
      const deployment = this.deploymentsByName.get(deploymentName);
      if (!deployment) throw new ProviderResolutionError("UnknownDeployment", `Unknown deployment referenced by tier ${logicalTier}: ${deploymentName}`);
      return this.toDeploymentRef(deployment, availability);
    });

    return {
      logicalTier,
      selected: candidates[0],
      fallbacks: candidates.slice(1),
      source: "config",
      reason: `Tier ${logicalTier} resolved to ${candidates[0].deployment} from provider policy.`,
      gatewayStatus: availability.gatewayStatus,
    };
  }

  async resolveWithMiddleware(
    decision: RoutingDecision,
    context: ProviderResolutionContext = {},
    options: { bus?: MiddlewareBus } = {},
  ): Promise<MiddlewareProviderResolutionResult> {
    const bus = options.bus ?? new MiddlewareBus();
    const before = await bus.execute("provider.resolve.before", providerMiddlewareContext(decision, context));

    if (before.result.action === "deny") {
      return halted("middleware-denied", before.result.reason, before);
    }
    if (before.result.action === "require-human") {
      return halted("requires-human", before.result.reason, before);
    }

    const transformedContext = resolutionContextFromMiddleware(context, before.context);

    try {
      const result = await this.resolve(decision, transformedContext);
      const audit = resolutionAudit(result);
      const after = await bus.execute("provider.resolve.after", {
        ...providerMiddlewareContext(decision, transformedContext),
        routing: {
          modelTier: result.logicalTier,
          provider: result.selected.provider,
          model: result.selected.model,
        },
        metadata: {
          ...(transformedContext.metadata ?? {}),
          providerResolution: result,
          providerResolutionAudit: audit,
        },
      });

      if (after.result.action === "deny") {
        return {
          ok: false,
          status: "middleware-denied",
          result,
          audit,
          error: { code: "middleware-denied", message: after.result.reason },
          middleware: { before, after },
        };
      }
      if (after.result.action === "require-human") {
        return {
          ok: false,
          status: "requires-human",
          result,
          audit,
          error: { code: "requires-human", message: after.result.reason },
          middleware: { before, after },
        };
      }

      return {
        ok: true,
        status: "resolved",
        result,
        audit,
        middleware: { before, after },
      };
    } catch (error) {
      if (error instanceof ProviderResolutionError) {
        return {
          ok: false,
          status: "failed",
          error: { code: error.code, message: error.message },
          middleware: { before },
        };
      }
      throw error;
    }
  }

  private toDeploymentRef(deployment: LiteLlmDeploymentConfig, availability: AvailabilityLookup): DeploymentRef {
    return {
      deployment: deployment.deployment,
      provider: deployment.provider,
      model: deployment.model,
      availability: availability.byDeployment.get(deployment.deployment) ?? availability.defaultAvailability,
    };
  }

  private async availability(checkAvailability: boolean): Promise<AvailabilityLookup> {
    if (!checkAvailability) {
      return { byDeployment: new Map(), defaultAvailability: "configured", gatewayStatus: "not-checked" };
    }

    if (!this.gateway?.listModels) {
      return { byDeployment: new Map(), defaultAvailability: "unknown", gatewayStatus: "not-checked" };
    }

    let models;
    try {
      models = await this.gateway.listModels();
    } catch (error) {
      if (error instanceof ProviderResolutionError) throw error;
      throw new ProviderResolutionError("LiteLLMUnavailable", error instanceof Error ? error.message : String(error));
    }

    const available = new Set(models.map((model) => model.id));
    return {
      byDeployment: new Map(
        this.config.deployments.map((deployment) => [
          deployment.deployment,
          available.has(deployment.deployment) ? "available" : "unavailable",
        ]),
      ),
      defaultAvailability: "unknown",
      gatewayStatus: "available",
    };
  }
}

interface AvailabilityLookup {
  byDeployment: Map<string, DeploymentAvailability>;
  defaultAvailability: DeploymentAvailability;
  gatewayStatus: ProviderResolutionResult["gatewayStatus"];
}

function validateResolverConfig(config: LiteLlmResolverConfig): void {
  const seenDeployments = new Set<string>();
  for (const deployment of config.deployments) {
    if (!deployment.deployment) {
      throw new ProviderResolutionError("UnknownDeployment", "Deployment identifier is required.");
    }
    if (seenDeployments.has(deployment.deployment)) {
      throw new ProviderResolutionError("UnknownDeployment", `Duplicate deployment identifier: ${deployment.deployment}`);
    }
    seenDeployments.add(deployment.deployment);
  }

  for (const tier of MODEL_TIERS) {
    const policy = config.policy.tiers[tier];
    if (!policy) {
      throw new ProviderResolutionError("MissingTierConfiguration", `Missing deployment policy for tier: ${tier}`);
    }
    validateTierPolicy(tier, policy, seenDeployments);
  }

  if (config.endpoint) {
    new LiteLlmGateway(config.endpoint);
  }
}

function validateTierPolicy(tier: ModelTier, policy: TierDeploymentPolicy, deployments: Set<string>): void {
  if (!policy.primary) {
    throw new ProviderResolutionError("NoCandidateDeployment", `Tier ${tier} must define a primary deployment.`);
  }
  for (const deployment of [policy.primary, ...(policy.fallbacks ?? [])]) {
    if (!deployments.has(deployment)) {
      throw new ProviderResolutionError("UnknownDeployment", `Tier ${tier} references unknown deployment: ${deployment}`);
    }
  }
}

function validateTier(tier: string): ModelTier {
  if (!MODEL_TIERS.includes(tier as ModelTier)) {
    throw new ProviderResolutionError("UnknownModelTier", `Unknown model tier: ${tier}`);
  }
  return tier as ModelTier;
}

function providerMiddlewareContext(decision: RoutingDecision, context: ProviderResolutionContext): Omit<MiddlewareContext, "event"> {
  return {
    runId: String(context.metadata?.runId ?? `provider:${decision.tier}`),
    taskId: String(context.metadata?.taskId ?? decision.matchedRule ?? decision.tier),
    routing: { modelTier: decision.tier },
    metadata: {
      ...(context.metadata ?? {}),
      providerResolutionContext: sanitizedContext(context),
      routingDecision: {
        tier: decision.tier,
        source: decision.source as RoutingDecisionSource,
        matchedRule: decision.matchedRule,
        reason: decision.reason,
      },
    },
  };
}

function resolutionContextFromMiddleware(original: ProviderResolutionContext, context: MiddlewareContext): ProviderResolutionContext {
  const providerContext = context.metadata.providerResolutionContext;
  const next: ProviderResolutionContext = {
    ...original,
    metadata: context.metadata,
  };

  if (isObject(providerContext)) {
    const override = providerContext.override;
    if (isObject(override) && typeof override.deployment === "string") {
      next.override = { deployment: override.deployment };
    }
    if (typeof providerContext.checkAvailability === "boolean") {
      next.checkAvailability = providerContext.checkAvailability;
    }
  }

  return next;
}

function sanitizedContext(context: ProviderResolutionContext): ProviderResolutionContext {
  return {
    override: context.override,
    checkAvailability: context.checkAvailability,
  };
}

function resolutionAudit(result: ProviderResolutionResult): ProviderResolutionAudit {
  return {
    logicalTier: result.logicalTier,
    selectedDeployment: result.selected.deployment,
    provider: result.selected.provider,
    model: result.selected.model,
    fallbackChain: [result.selected.deployment, ...result.fallbacks.map((fallback) => fallback.deployment)],
    resolutionSource: result.source,
    reason: result.reason,
    gatewayStatus: result.gatewayStatus,
  };
}

function halted(
  status: "middleware-denied" | "requires-human",
  message: string,
  before: MiddlewareProviderResolutionResult["middleware"]["before"],
): MiddlewareProviderResolutionResult {
  return {
    ok: false,
    status,
    error: { code: status, message },
    middleware: { before },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
