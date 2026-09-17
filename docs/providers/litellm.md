# LiteLLM Provider Resolution

## Purpose

Provider resolution maps a logical model tier to configured LiteLLM deployment aliases.

Pipeline:

```text
task/spec metadata
  -> StaticModelRouter
  -> logical tier
  -> LiteLlmProviderResolver
  -> LiteLLM deployment aliases
  -> LiteLLM proxy
  -> upstream providers
```

The semantic router stays unaware of provider and model names. The resolver owns deployment selection.

## Architecture Boundary

The router answers:

```text
What capability tier do we need?
```

The provider resolver answers:

```text
Which configured deployment can satisfy that tier?
```

The control plane still does not execute prompts or call chat/completion APIs in this phase.

## Control-Plane Policy

Control-plane policy maps logical tiers to deployment aliases:

```ts
{
  policy: {
    tiers: {
      cheap: {
        primary: "cheap-primary",
        fallbacks: ["cheap-fallback"]
      },
      "coding-fast": {
        primary: "coding-fast-primary",
        fallbacks: ["coding-fast-fallback"]
      },
      "coding-strong": {
        primary: "coding-strong-primary",
        fallbacks: ["coding-strong-fallback"]
      },
      "reasoning-strong": {
        primary: "reasoning-primary",
        fallbacks: ["reasoning-fallback"]
      },
      reviewer: {
        primary: "reviewer-primary",
        fallbacks: ["reviewer-fallback"]
      }
    }
  }
}
```

Fallback order is deterministic:

```text
primary first, then fallbacks in listed order
```

No retry loop is implemented here. This layer only returns the ordered candidate chain.

## LiteLLM Deployment Config

LiteLLM deployment details are separate from control-plane tier policy:

```ts
{
  deployments: [
    {
      deployment: "coding-strong-primary",
      provider: "bedrock",
      model: "bedrock/anthropic.claude-example"
    },
    {
      deployment: "coding-strong-fallback",
      provider: "openrouter",
      model: "openrouter/anthropic/claude-example"
    }
  ]
}
```

Equivalent LiteLLM proxy config shape:

```yaml
model_list:
  - model_name: coding-strong-primary
    litellm_params:
      model: bedrock/anthropic.claude-example

  - model_name: coding-strong-fallback
    litellm_params:
      model: openrouter/anthropic/claude-example
```

Bedrock is represented only through LiteLLM configuration. The control plane does not import AWS SDKs, implement SigV4, or manage AWS credentials.

OpenRouter is treated as another LiteLLM upstream. The control plane does not call OpenRouter directly.

## Endpoint Config

The optional LiteLLM gateway supports model availability checks:

```ts
{
  endpoint: {
    baseUrl: "http://127.0.0.1:4000",
    apiKeyEnv: "LITELLM_API_KEY",
    timeoutMs: 5000
  }
}
```

`baseUrl` is configurable. It is not hardcoded to localhost.

Secrets are referenced by environment variable name. Do not commit API keys, AWS secrets, tokens, or private endpoints.

## API Example

```ts
import {
  EXAMPLE_LITELLM_RESOLVER_CONFIG,
  LiteLlmProviderResolver,
  StaticModelRouter
} from "../src/index.ts";

const router = new StaticModelRouter();
const routingDecision = router.route({
  task: { type: "feature", risk: "high" }
});

const resolver = new LiteLlmProviderResolver(EXAMPLE_LITELLM_RESOLVER_CONFIG);
const resolution = await resolver.resolve(routingDecision, {
  checkAvailability: false
});

console.log(resolution.selected.deployment);
console.log(resolution.fallbacks.map((fallback) => fallback.deployment));
```

Example result:

```ts
{
  logicalTier: "reasoning-strong",
  selected: {
    deployment: "reasoning-primary",
    provider: "bedrock",
    model: "bedrock/example-reasoning",
    availability: "configured"
  },
  fallbacks: [
    {
      deployment: "reasoning-fallback",
      provider: "openrouter",
      model: "openrouter/example-reasoning",
      availability: "configured"
    }
  ],
  source: "config",
  reason: "Tier reasoning-strong resolved to reasoning-primary from provider policy."
}
```

## Operational Override

A low-level deployment override is available for development/debugging:

```ts
await resolver.resolve(routingDecision, {
  override: {
    deployment: "coding-strong-fallback"
  }
});
```

The override must reference a configured deployment. It cannot inject arbitrary provider/model names.

This is separate from the semantic model-tier override handled by the router.

## Middleware Events

Middleware-aware resolution emits:

```text
provider.resolve.before
provider.resolve.after
```

Flow:

```text
RoutingDecision
  -> provider.resolve.before
  -> LiteLlmProviderResolver
  -> ProviderResolutionResult
  -> provider.resolve.after
```

Policy behavior:

```text
deny before resolution          -> no gateway lookup occurs
require-human before resolution -> no gateway lookup occurs
```

Transformers can modify allowed resolution context fields through metadata:

```ts
{
  providerResolutionContext: {
    override: { deployment: "coding-strong-fallback" },
    checkAvailability: true
  }
}
```

Do not place credentials in middleware context.

## Availability

Deployment availability can be:

```text
configured
available
unavailable
unknown
```

Without a gateway check, configured deployments are marked:

```text
configured
```

With `checkAvailability: true`, the gateway calls:

```text
GET <baseUrl>/v1/models
```

If the LiteLLM model list contains a deployment alias, that deployment is `available`; configured aliases missing from the model list are `unavailable`.

If availability cannot be determined without execution, preserve `unknown`.

## Failure Codes

Typed provider-resolution failures:

```text
UnknownModelTier
MissingTierConfiguration
UnknownDeployment
LiteLLMUnavailable
InvalidLiteLLMResponse
NoCandidateDeployment
```

Configuration is validated eagerly. Missing required tiers, duplicate deployments, unknown deployment references, malformed endpoint configuration, and invalid overrides fail explicitly.

## Audit Data

Audit-safe resolution data includes:

```text
logical tier
selected deployment
provider, if known
model, if known
fallback chain
resolution source
reason
gateway status, if checked
```

Audit output must not include:

```text
API keys
AWS secrets
authorization headers
full environment dumps
```

## Local Smoke Test

Optional local flow:

```text
1. Start LiteLLM proxy with a config that defines deployment aliases.
2. Set LITELLM_BASE_URL to the proxy URL.
3. Set LITELLM_API_KEY if the proxy requires it.
4. Run tests with RUN_LITELLM_INTEGRATION=1.
```

PowerShell:

```powershell
$env:RUN_LITELLM_INTEGRATION = "1"
$env:LITELLM_BASE_URL = "http://127.0.0.1:4000"
$env:LITELLM_API_KEY = "<proxy-key-if-needed>"
npm test
```

The smoke test checks logical tier to LiteLLM deployment resolution and model-list availability. It does not generate model output and should not spend external API money by default.

## Deliberately Out Of Scope

Do not add these here:

```text
agent execution
chat/completion orchestration
prompt construction
tool calling
retry loops
provider benchmarking
latency ranking
cost-based dynamic routing
monthly budgets
Langfuse
security guardrails
automatic model discovery
Claude Code, Gemini CLI, Copilot CLI, or Codex execution
```
