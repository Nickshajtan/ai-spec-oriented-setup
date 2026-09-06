# Middleware Kernel

## Purpose

This package is a minimal vendor-neutral middleware/event kernel for AI development control-plane experiments. It provides a typed semantic event model, three constrained middleware capabilities, deterministic execution, explicit failure behavior, and an in-memory audit trail.

It does not call models, route providers, persist data, expose HTTP APIs, or integrate with any vendor-specific system.

## Semantic Events

Events are defined once in `src/events.ts` as `SEMANTIC_EVENT_NAMES`.

Current event names:

```text
run.started
task.classify.before
task.classify.after
spec.validate.before
spec.validate.after
model.route.before
model.route.after
model.request.before
model.request.after
tool.execute.before
tool.execute.after
verify.before
verify.after
run.complete.before
run.completed
run.failed
```

Each runtime event is versioned:

```ts
{ name: "model.route.before", version: 1 }
```

## Middleware Capabilities

Middleware is registered against one semantic event:

```ts
bus.use("model.route.before", middleware);
```

Every middleware has:

```ts
{
  id: "budget-policy",
  type: "policy",
  priority: 100,
  failureMode: "fail-closed",
  handler(context) {
    return { action: "continue" };
  }
}
```

### Observer

Observers are read-only. They can inspect the frozen context but cannot modify execution, deny execution, or require human review.

Expected use cases: audit hooks, telemetry, tracing.

### Policy

Policies can return:

```text
continue
deny
require-human
```

`deny` and `require-human` stop later middleware for the current event.

### Transformer

Transformers can return:

```text
continue
modify
```

Modification is explicit through a context patch. Handlers receive a cloned, frozen context, so hidden mutation of the shared context is not part of the contract.

## Ordering

Execution is phase-based:

```text
Observer -> Policy -> Transformer
```

Within each phase:

1. Lower numeric `priority` executes first.
2. Equal priorities preserve registration order.

This ordering is implemented by sorting registered middleware before execution.

## Failure Modes

Each middleware can set:

```text
fail-open
fail-closed
```

Defaults:

```text
observer    -> fail-open
policy      -> fail-closed
transformer -> fail-closed
```

`fail-open` records the error in the audit trail and continues.

`fail-closed` records the error and stops execution with:

```ts
{ action: "deny", reason: "Middleware <id> failed closed" }
```

Middleware exceptions are never silently swallowed.

## Audit Trail

Every middleware execution produces an `AuditRecord` with:

```text
event
middleware id
middleware type
start/end timestamp
duration
result action
error, if any
```

Use `InMemoryAuditSink` for the current prototype. Langfuse or other observability systems should adapt to the `AuditSink` interface later.

## Usage Example

```ts
import {
  InMemoryAuditSink,
  MiddlewareBus,
  createAuditObserver,
  createBudgetPolicy,
  createModelTierTransformer,
} from "./src/index.ts";

const audit = new InMemoryAuditSink();
const bus = new MiddlewareBus(audit);

bus.use("model.route.before", createAuditObserver());
bus.use("model.route.before", createBudgetPolicy());
bus.use("model.route.before", createModelTierTransformer());

const result = await bus.execute("model.route.before", {
  runId: "run-1",
  taskId: "task-1",
  task: { type: "documentation" },
  budget: { maxCostUsd: 1, spentUsd: 0.25 },
  metadata: {},
});

console.log(result.context.routing?.modelTier); // "cheap"
console.log(result.audit);
```

## Adding Middleware

1. Choose the semantic event from `SEMANTIC_EVENT_NAMES`.
2. Pick exactly one capability: `observer`, `policy`, or `transformer`.
3. Give the middleware a unique `id` for that event.
4. Set a deterministic `priority`.
5. Pick `failureMode` based on risk.
6. Return only the actions allowed by the selected capability.

## What Does Not Belong Here

Keep this package small and replaceable. Do not add:

```text
AI provider SDKs
LiteLLM or OpenRouter integration
Claude/OpenAI/Gemini/Codex-specific events
model API calls
full routing logic
retry logic
budget accounting
prompt injection detection
Langfuse integration
queues
databases
HTTP servers
UIs
plugin discovery
generic workflow DSLs
dependency injection frameworks
```
