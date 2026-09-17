# Specifier Middleware Kernel

The middleware kernel handles optional cross-cutting behavior for Specifier lifecycle events. It is intentionally small: observers, policies, transformers, deterministic ordering, and explicit failure semantics.

It does not call models, route providers, persist audit logs, expose HTTP APIs, or implement OpenSpec behavior.

## Events

Events are defined in `src/events.ts` as `SPECIFIER_EVENT_NAMES`. They use domain language:

```text
interview.*
openspec.*
review.*
```

Technical model-call telemetry should not be represented as product lifecycle behavior.

Implemented interview lifecycle events include:

```text
interview.started
interview.question.planned
interview.answer.accepted
interview.gap.detected
interview.ready
```

## Middleware Types

Observers are read-only and fail open by default.

Policies can continue, deny, or require human input. They fail closed by default.

Transformers can continue or return an explicit patch for `lifecycle`, `warnings`, or `metadata`. They fail closed by default.

Execution order is:

```text
Observer -> Policy -> Transformer
```

Within each phase, lower priority runs first and equal priorities preserve registration order.

## Bundled Middleware

`createLoggingObserver` provides optional lifecycle logging.

`createLimitsGuard` enforces cheap deterministic hard limits such as maximum interview turns and maximum review iterations.

`createLimitWarnings` adds warnings for cheap deterministic thresholds such as context size and artifact size.

Core behavior must work with no middleware installed.

## Example

```ts
import { MiddlewareBus, createLimitsGuard, createLoggingObserver } from "../src/index.ts";

const bus = new MiddlewareBus();

bus.use("openspec.validate.before", createLoggingObserver());
bus.use("interview.turn.before", createLimitsGuard({ maxInterviewTurns: 12 }));

const result = await bus.execute("interview.turn.before", {
  runId: "run-1",
  subjectId: "add-health-check",
  lifecycle: { interviewTurn: 3 },
  metadata: {},
});

console.log(result.result.action);
console.log(result.records);
```

Returned records describe middleware execution for the current call. They are not a product audit subsystem.
