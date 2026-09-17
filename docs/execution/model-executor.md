# Stateless Model Executor

## Purpose

The stateless model executor sends exactly one normalized request to one already resolved LiteLLM deployment and returns a provider-neutral result.

Flow:

```text
ModelExecutionRequest
  -> model.request.before
  -> LiteLLM deployment alias
  -> LiteLLM /v1/chat/completions
  -> normalized result
  -> model.request.after
  -> ModelExecutionOutcome
```

This is not an agent framework. It does not retry, execute fallbacks, call tools, stream responses, modify repositories, or run autonomous loops.

## Layer Boundary

The execution layer consumes a deployment selected by provider resolution:

```text
StaticModelRouter
  -> logical tier
  -> LiteLlmProviderResolver
  -> deployment alias
  -> LiteLlmModelExecutor
```

The executor does not perform semantic routing or provider resolution again.

## Request Model

```ts
{
  runId: "run-1",
  taskId: "task-1",
  deployment: "coding-strong-primary",
  messages: [
    { role: "system", content: "You are a concise assistant." },
    { role: "user", content: "Return exactly: pong" }
  ],
  parameters: {
    temperature: 0,
    maxTokens: 16
  },
  metadata: {}
}
```

Supported message roles:

```text
system
user
assistant
```

Validation happens before any network call. Invalid deployment, empty messages, unsupported roles, invalid content, invalid temperature, and non-positive `maxTokens` fail as `InvalidRequest`.

## Normalized Result

Successful execution returns:

```ts
{
  content: "pong",
  deployment: "coding-strong-primary",
  provider: "bedrock",
  model: "bedrock/example",
  usage: {
    inputTokens: 8,
    outputTokens: 1,
    totalTokens: 9
  },
  cost: {
    amountUsd: 0.001,
    source: "litellm"
  },
  finishReason: "stop",
  latencyMs: 123,
  rawResponseId: "chatcmpl-..."
}
```

Usage and cost are normalized only when LiteLLM returns structured values. The executor does not calculate provider pricing tables or invent cost.

## LiteLLM Boundary

The executor uses LiteLLM Proxy through an OpenAI-compatible endpoint:

```text
POST <baseUrl>/v1/chat/completions
```

Request mapping:

```text
deployment -> model
messages -> messages
parameters.temperature -> temperature
parameters.maxTokens -> max_tokens
```

Configuration:

```ts
{
  baseUrl: "http://127.0.0.1:4000",
  apiKeyEnv: "LITELLM_API_KEY",
  timeoutMs: 30000
}
```

Provider SDKs are not imported into core. Bedrock, OpenRouter, OpenAI, and other upstreams remain behind LiteLLM configuration.

## Middleware Lifecycle

Events:

```text
model.request.before
model.request.after
```

Before middleware can observe, deny, require human approval, or transform explicitly allowed request fields.

Allowed transformer fields are carried through `metadata.modelExecutionRequest`:

```ts
{
  modelExecutionRequest: {
    messages: [{ role: "user", content: "Return exactly: pong" }],
    parameters: { temperature: 0.1 },
    metadata: { trace: "local" }
  }
}
```

Deployment, base URL, and credentials are not accepted from request middleware.

Invariants:

```text
deny before execution          -> zero LiteLLM calls
require-human before execution -> zero LiteLLM calls
```

`model.request.after` receives normalized success or typed failure metadata when execution reaches the gateway.

## Failure Categories

Typed failures:

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

HTTP mapping:

```text
401 / 403 -> AuthenticationFailure
404       -> DeploymentUnavailable
429       -> RateLimited
5xx       -> UpstreamProviderFailure
other 4xx -> InvalidRequest
network   -> LiteLLMUnavailable
timeout   -> RequestTimeout
malformed success response -> InvalidResponse
```

Failures preserve safe fields such as HTTP status, upstream error code, deployment, and a retryability hint where reliable.

## Timeout

Default timeout:

```text
30000ms
```

Override it in executor config:

```ts
new LiteLlmModelExecutor({
  baseUrl: "http://127.0.0.1:4000",
  timeoutMs: 5000
});
```

Timeouts return `RequestTimeout`. Requests are not allowed to hang indefinitely.

## Secret Handling

Secrets stay inside LiteLLM client configuration:

```ts
apiKeyEnv: "LITELLM_API_KEY"
```

The executor does not put API keys, authorization headers, or environment dumps into middleware context, results, errors, or audit data. Prompt content is also not included in execution audit by default.

## Audit Data

Execution audit includes:

```text
runId
taskId
deployment
request start/end
latency
status
provider/model if returned
token usage if returned
cost if returned
finish reason
safe error category on failure
```

It does not include full prompts by default.

## Optional Smoke Test

The real LiteLLM execution smoke test is opt-in:

```powershell
$env:RUN_LITELLM_EXECUTION_SMOKE = "1"
$env:LITELLM_BASE_URL = "http://127.0.0.1:4000"
$env:LITELLM_API_KEY = "<proxy-key-if-required>"
$env:LITELLM_SMOKE_DEPLOYMENT = "cheap-primary"
npm test
```

The smoke test sends one tiny request and verifies a non-empty normalized response. It is disabled by default so CI does not depend on paid external model access.

## Vertical Slice

The tested end-to-end path is:

```text
OpenSpec fixture
  -> OpenSpecAdapter
  -> StaticModelRouter
  -> LiteLlmProviderResolver
  -> LiteLlmModelExecutor
  -> mock LiteLLM response
```

This validates integration boundaries without adding agent execution.

## Deliberately Deferred

Do not add these here:

```text
automatic retries
fallback execution
streaming
tool/function calling
structured output schemas
agent loops
repository edits
shell execution
Codex/Claude/Gemini/Copilot invocation
context assembly
prompt templates
conversation memory
Langfuse
dynamic budgets
parallel model calls
model racing
reviewer execution
```
