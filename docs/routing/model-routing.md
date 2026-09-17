# Static Model Routing

## Purpose

The static model router maps normalized task/spec metadata to a logical model tier. It is deterministic, rule-based, and provider-neutral.

It answers only:

```text
Which logical model tier should this task use?
```

It does not choose a concrete provider or model.

## Logical Tiers

Canonical tiers:

```text
cheap
coding-fast
coding-strong
reasoning-strong
reviewer
```

These are semantic tiers. Do not put provider or model names here.

Forbidden examples:

```text
gpt-5
claude-sonnet
gemini-pro
bedrock-claude
```

## Static Rules

Default configuration:

```ts
{
  defaultTier: "coding-strong",
  rules: [
    { id: "task.documentation", taskType: "documentation", tier: "cheap" },
    { id: "task.small-fix", taskType: "small-fix", tier: "coding-fast" },
    { id: "task.bugfix", taskType: "bugfix", tier: "coding-fast" },
    { id: "task.feature", taskType: "feature", tier: "coding-strong" },
    { id: "task.refactor", taskType: "refactor", tier: "coding-strong" },
    { id: "task.architecture", taskType: "architecture", tier: "reasoning-strong" },
    { id: "task.design", taskType: "design", tier: "reasoning-strong" },
    { id: "task.review", taskType: "review", tier: "reviewer" }
  ]
}
```

Configuration is validated when `StaticModelRouter` is constructed. Invalid tiers, duplicate rule ids, and duplicate task types fail immediately.

## Default Behavior

If no task-type rule matches, the router returns:

```text
coding-strong
```

The decision source is:

```text
default
```

The default is intentionally explicit. Unknown task types are not silently interpreted.

## Overrides

An explicit override takes precedence over rules:

```ts
router.route({
  task: { type: "feature" },
  override: { modelTier: "reasoning-strong" }
});
```

Result:

```ts
{
  tier: "reasoning-strong",
  source: "override",
  reason: "Explicit model tier override selected reasoning-strong."
}
```

Invalid override values throw `RoutingValidationError`.

## Risk Promotion

Only `task.risk = "high"` promotes tiers.

Promotion policy:

```text
cheap          -> coding-strong
coding-fast    -> coding-strong
coding-strong  -> reasoning-strong
reasoning-strong -> reasoning-strong
reviewer       -> reviewer
```

Low and medium risk do not change the selected tier.

## Middleware Events

Middleware-aware routing emits:

```text
model.route.before
model.route.after
```

Flow:

```text
RoutingInput
  -> model.route.before
  -> StaticModelRouter
  -> RoutingDecision
  -> model.route.after
  -> MiddlewareRoutingResult
```

Policy behavior:

```text
deny before route          -> router is not executed
require-human before route -> router is not executed
deny after route           -> result includes the decision and halted status
require-human after route  -> result includes the decision and halted status
```

Transformer behavior:

```ts
bus.use("model.route.before", {
  id: "force-docs",
  type: "transformer",
  priority: 1,
  handler() {
    return {
      action: "modify",
      patch: { task: { type: "documentation" } }
    };
  }
});
```

The router sees the transformed task type.

## Decision Shape

Every successful route returns an explainable decision:

```ts
{
  tier: "coding-strong",
  source: "rule",
  matchedRule: "task.feature",
  reason: "Task type 'feature' matched rule 'task.feature' and selected coding-strong.",
  signals: ["task.type=feature"]
}
```

Middleware-aware routing also returns an audit summary:

```ts
{
  inputSummary: {
    taskType: "feature",
    risk: "medium",
    changeName: "add-health-check"
  },
  selectedTier: "coding-strong",
  matchedRule: "task.feature",
  decisionSource: "rule",
  reason: "..."
}
```

## OpenSpec Integration

Use `routingInputFromSpecContext(specContext, taskType?)` to convert normalized OpenSpec inspection output into routing input.

Current explicit metadata mapping:

```text
skipSpecs = true and affectedAreas contains docs -> task.type = documentation
```

This is intentionally narrow. The router does not parse proposal prose or infer task type with an LLM. If a consumer knows the task type, pass it explicitly:

```ts
const input = routingInputFromSpecContext(specContext, "feature");
const decision = router.route(input);
```

## Example

```ts
import { MiddlewareBus, StaticModelRouter } from "../src/index.ts";

const bus = new MiddlewareBus();
const router = new StaticModelRouter();

const result = await router.routeWithMiddleware(
  {
    task: { type: "feature", risk: "high" },
    spec: { changeName: "add-health-check" }
  },
  { bus }
);

console.log(result.decision?.tier); // reasoning-strong
console.log(result.decision?.reason);
```

## Deliberately Out Of Scope

Do not add these to this router:

```text
physical model names
provider selection
LiteLLM or OpenRouter
OpenAI, Anthropic, Gemini, Bedrock, Claude, or Codex adapters
model availability checks
fallbacks between providers
retries
dynamic cost optimization
latency-aware routing
historical success-based routing
LLM classification
embedding classification
token/context-size classification
agent selection
prompt generation
```
