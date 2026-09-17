# Task: Implement the first stateless model execution layer

## Context

The repository already contains:

1. a vendor-neutral middleware kernel;
2. an OpenSpec adapter;
3. a static semantic model router;
4. a LiteLLM-backed provider resolution layer.

The current flow can produce:

```text
OpenSpec / task metadata
→ logical model tier
→ resolved LiteLLM deployment
```

This task adds the first real model execution step:

> Execute one stateless model request through the resolved LiteLLM deployment and normalize the result.

This is NOT an agent framework.

Do not add tool calling, loops, autonomous task execution, Codex/Claude harness integration, or repository modification.

---

# Goal

Given:

```text
ProviderResolutionResult
+
ModelRequest
```

execute exactly one request through LiteLLM and return a normalized result.

Conceptual flow:

```text
ModelRequest
   ↓
model.request.before
   ↓
middleware
   ↓
resolved deployment
   ↓
LiteLLM
   ↓
model response
   ↓
normalize
   ↓
model.request.after
   ↓
middleware
   ↓
ModelExecutionResult
```

---

# 1. Model executor boundary

Introduce a provider-neutral interface.

Conceptually:

```ts
interface ModelExecutor {
  execute(
    request: ModelExecutionRequest
  ): Promise<ModelExecutionOutcome>;
}
```

Do not expose LiteLLM-specific response objects outside the integration layer.

---

# 2. Execution request

Create a minimal normalized request model.

Conceptually:

```ts
interface ModelExecutionRequest {
  runId: string;
  taskId: string;

  deployment: string;

  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;

  parameters?: {
    temperature?: number;
    maxTokens?: number;
  };

  metadata?: Record<string, unknown>;
}
```

Keep it small.

Do not yet add:

* tool definitions;
* response schemas;
* multimodal content;
* streaming;
* reasoning controls;
* provider-specific options.

Those are future work.

---

# 3. Deployment source

The executor must consume the already resolved deployment.

Do not perform semantic routing again.

Do not perform provider resolution again unless the existing architecture explicitly requires passing through a single orchestrated service boundary.

Separation must remain:

```text
semantic router
→ provider resolver
→ model executor
```

---

# 4. LiteLLM integration

Use LiteLLM through the existing gateway/client abstraction.

Prefer an OpenAI-compatible chat/completions-compatible endpoint exposed by LiteLLM Proxy.

Do not import Anthropic, AWS Bedrock, OpenAI, Gemini, or OpenRouter SDKs directly into core.

The executor should know only:

```text
LiteLLM endpoint
resolved deployment alias
request
```

---

# 5. Normalized response

Return a provider-neutral result.

Conceptually:

```ts
interface ModelExecutionResult {
  content: string;

  deployment: string;

  provider?: string;
  model?: string;

  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };

  cost?: {
    amountUsd?: number;
    source?: string;
  };

  finishReason?: string;

  latencyMs: number;

  rawResponseId?: string;

  metadata?: Record<string, unknown>;
}
```

Do not expose secrets or raw authorization data.

Preserving a small opaque `rawResponseId` is acceptable.

Avoid leaking the full raw provider response throughout core unless needed for debugging behind an explicit integration boundary.

---

# 6. Execution outcome

Model execution may succeed, halt due to middleware, or fail.

Use an explicit result/outcome model rather than relying only on thrown exceptions.

Conceptually:

```ts
type ModelExecutionOutcome =
  | {
      status: "completed";
      result: ModelExecutionResult;
    }
  | {
      status: "denied";
      reason: string;
    }
  | {
      status: "requires-human";
      reason: string;
    }
  | {
      status: "failed";
      error: ModelExecutionError;
    };
```

Reuse existing repository result conventions if present.

---

# 7. Semantic middleware events

Use existing:

```text
model.request.before
model.request.after
```

Expected behavior:

## Before

Middleware can:

* observe;
* deny;
* require human;
* transform explicitly allowed request fields.

If denied or human approval is required:

* no LiteLLM call occurs.

## After

Middleware receives normalized execution result/context.

Do not introduce vendor-specific events.

---

# 8. Transformer behavior

Transformer middleware may modify only explicitly allowed request data.

Examples:

```text
messages
temperature
maxTokens
metadata
```

It must NOT be able to inject:

* API keys;
* arbitrary LiteLLM base URLs;
* unknown deployment identifiers;
* raw provider credentials.

Deployment changes belong to the provider resolution layer unless a clearly documented operational override already exists.

---

# 9. Policy behavior

Policy middleware may:

```text
continue
deny
require-human
```

A deny before execution must guarantee zero model calls.

A require-human result must also guarantee zero model calls.

Document this as an invariant and test it.

---

# 10. Failure model

Introduce typed model execution failures.

At minimum distinguish:

```text
LiteLLMUnavailable
RequestTimeout
AuthenticationFailure
RateLimited
DeploymentUnavailable
InvalidRequest
InvalidResponse
UpstreamProviderFailure
UnknownExecutionFailure
```

Exact mapping depends on LiteLLM response/error semantics.

Preserve:

```text
HTTP status where applicable
safe upstream error code
deployment
retryability hint if reliably known
```

Do not expose secrets or authorization headers.

---

# 11. No retries yet

Important:

Do NOT implement automatic retries or fallback execution in this step.

Why:

The provider resolver already returns ordered fallback candidates, but execution retry/fallback policy is a separate concern.

For now:

```text
one resolved deployment
→ one request
→ one result/failure
```

Keep the boundary clean.

---

# 12. Timeout

Support configurable request timeout.

Requirements:

* explicit default;
* configurable per executor/client configuration;
* timeout produces typed failure;
* do not allow indefinitely hanging requests.

Do not implement sophisticated deadline propagation yet unless trivial.

---

# 13. Request validation

Validate before execution:

* non-empty deployment;
* non-empty messages;
* supported roles;
* message content shape;
* valid temperature if supplied;
* positive maxTokens if supplied.

Invalid requests must fail before network execution.

---

# 14. Secret handling

Secrets must remain inside LiteLLM client configuration.

They must not appear in:

* middleware context;
* model execution result;
* audit logs;
* exceptions;
* test snapshots.

Redact sensitive HTTP headers from debug logging.

---

# 15. Audit trail

Reuse the existing audit infrastructure.

Record at minimum:

```text
runId
taskId
deployment
request start
request end
latency
status
provider/model if available
token usage if available
cost if available
finish reason
safe error category on failure
```

Do NOT audit full prompts by default.

If prompt logging already exists as a configurable feature, it must remain opt-in.

---

# 16. Cost/usage metadata

If LiteLLM returns usage/cost data in a structured way, normalize it.

Do not calculate provider pricing tables manually in this task.

Priority:

```text
actual gateway-reported usage/cost
> absent/unknown
```

Never invent cost values.

---

# 17. Test gateway

Normal tests must use a fake/mock LiteLLM-compatible endpoint/client.

Cover:

* successful completion;
* timeout;
* malformed response;
* HTTP 401/403;
* HTTP 429;
* HTTP 5xx;
* middleware deny;
* middleware require-human;
* transformer request modification;
* audit output;
* secret redaction.

Do not make unit tests call paid models.

---

# 18. Success test

Given:

```text
deployment = coding-strong-primary

messages:
system: "You are a concise assistant."
user: "Return exactly: pong"
```

mock gateway responds successfully.

Expected:

```text
status = completed
content = "pong"
deployment preserved
usage normalized if present
latency recorded
model.request.before emitted
model.request.after emitted
```

---

# 19. Middleware deny test

At:

```text
model.request.before
```

Policy returns:

```text
deny
```

Expected:

```text
LiteLLM client call count = 0
status = denied
```

---

# 20. Transformer test

Transformer changes:

```text
temperature
```

or appends allowed metadata.

Expected:

* transformed value is sent to LiteLLM;
* original request object is not unexpectedly mutated if immutable semantics are used elsewhere.

---

# 21. Invalid response test

LiteLLM returns HTTP success but malformed payload.

Expected:

```text
InvalidResponse
```

Do not silently return empty content.

---

# 22. Optional real smoke test

Add a separately enabled real integration test.

Example toggle:

```text
RUN_LITELLM_EXECUTION_SMOKE=1
```

The smoke test should:

1. use configured LiteLLM endpoint;
2. use a configured cheap deployment;
3. send a tiny request;
4. verify a non-empty normalized response.

Keep it cheap and explicitly opt-in.

CI must not require paid API access.

---

# 23. First end-to-end integration test

Add one integration test covering the existing layers:

```text
OpenSpec fixture
   ↓
normalized task/spec metadata
   ↓
StaticModelRouter
   ↓
logical tier
   ↓
ProviderResolver
   ↓
deployment
   ↓
ModelExecutor
   ↓
mock LiteLLM response
```

This is the first full vertical slice.

Do not add agent execution.

---

# 24. Documentation

Add concise documentation such as:

```text
docs/execution/model-executor.md
```

Explain:

* purpose;
* request model;
* normalized result;
* middleware lifecycle;
* LiteLLM boundary;
* failure categories;
* timeout;
* secret handling;
* why retries/fallbacks are deliberately deferred;
* how to run optional smoke test.

---

# Non-goals

Do NOT implement:

* retry loops;
* fallback execution;
* streaming;
* tool calling;
* function calling;
* structured output;
* JSON schema enforcement;
* agent loops;
* repository file modification;
* shell execution;
* Claude Code invocation;
* Codex CLI invocation;
* Gemini CLI invocation;
* Copilot CLI invocation;
* context assembly from repository files;
* prompt templates;
* conversation memory;
* Langfuse;
* dynamic budgets;
* parallel model calls;
* model racing;
* independent reviewer execution.

This task answers only:

> Can the control plane execute one normalized stateless request against one resolved deployment and receive a safe normalized result?

---

# Definition of Done

The task is complete when:

1. A provider-neutral `ModelExecutor` boundary exists.
2. A normalized model request contract exists.
3. A normalized model execution result exists.
4. Execution uses the previously resolved deployment.
5. LiteLLM remains the provider gateway boundary.
6. No direct model-provider SDK is introduced into core.
7. `model.request.before` executes before any network call.
8. `model.request.after` executes after execution/normalization where appropriate.
9. Policy deny guarantees zero network requests.
10. Require-human guarantees zero network requests.
11. Transformer middleware can modify explicitly allowed request fields.
12. Request validation occurs before network execution.
13. Request timeout exists.
14. Typed failure categories exist.
15. No automatic retry exists.
16. No automatic fallback execution exists.
17. Usage metadata is normalized when available.
18. Cost metadata is normalized only when provided reliably.
19. Audit records execution metadata without leaking secrets.
20. Prompts are not logged by default.
21. Mock LiteLLM unit/integration tests pass.
22. First full vertical-slice integration test passes:
    `OpenSpec → router → resolver → executor`.
23. Optional real LiteLLM smoke test is documented.
24. Existing lint/type/test checks pass.
25. Documentation exists.
26. Final response reports:

    * changed files;
    * executor API;
    * LiteLLM endpoint/API assumptions;
    * normalized response fields;
    * error mappings;
    * tests executed/results;
    * anything deliberately deferred.

## Final instruction

Do not continue into retries, fallback execution, agent harnesses, or tool calling.

When the control plane can perform exactly one safe stateless model request end-to-end, stop.
