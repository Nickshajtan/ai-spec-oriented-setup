# Model Port And LiteLLM

Specifier Core uses a minimal provider-neutral `ModelPort`:

```ts
interface ModelPort {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
```

`ModelRequest.purpose` may describe semantic intent such as `interview` or `review`, but the Specifier must not route or select providers from that value. For v1, LiteLLM is the only supported standalone LLM backend.

## LiteLLM Adapter

`LiteLLMModelAdapter` maps `ModelRequest` to LiteLLM's OpenAI-compatible chat completions endpoint:

```text
POST <baseUrl>/v1/chat/completions
```

Responsibilities:

- map request fields to LiteLLM;
- invoke LiteLLM;
- normalize content, usage, finish reason, and response id;
- normalize relevant errors.

It does not implement model routing, provider selection, pricing, retry orchestration, provider scoring, fallback execution, or FinOps.

## CI Boundary

Tests use local HTTP test servers and do not require a running LiteLLM instance, credentials, or external model calls.
