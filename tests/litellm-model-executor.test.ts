import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EXAMPLE_LITELLM_RESOLVER_CONFIG,
  LiteLlmChatGateway,
  LiteLlmModelExecutor,
  LiteLlmProviderResolver,
  MiddlewareBus,
  OpenSpecAdapter,
  StaticModelRouter,
  routingInputFromSpecContext,
} from "../src/index.ts";
import type {
  LiteLlmChatCompletionRequest,
  LiteLlmChatCompletionResult,
  ModelExecutionRequest,
  ModelGateway,
  ProcessResult,
  ProcessRunner,
} from "../src/index.ts";

class FakeModelGateway implements ModelGateway {
  calls: LiteLlmChatCompletionRequest[] = [];
  private readonly result: LiteLlmChatCompletionResult | Error;

  constructor(result: LiteLlmChatCompletionResult | Error) {
    this.result = result;
  }

  async chatCompletion(request: LiteLlmChatCompletionRequest): Promise<LiteLlmChatCompletionResult> {
    this.calls.push(structuredClone(request));
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

class FakeProcessRunner implements ProcessRunner {
  private readonly result: ProcessResult;

  constructor(result: ProcessResult) {
    this.result = result;
  }

  async run(): Promise<ProcessResult> {
    return this.result;
  }
}

function request(overrides: Partial<ModelExecutionRequest> = {}): ModelExecutionRequest {
  return {
    runId: "run-1",
    taskId: "task-1",
    deployment: "coding-strong-primary",
    messages: [
      { role: "system", content: "You are a concise assistant." },
      { role: "user", content: "Return exactly: pong" },
    ],
    metadata: {},
    ...overrides,
  };
}

test("successful completion is normalized and emits before/after events", async () => {
  const gateway = new FakeModelGateway({
    id: "chatcmpl-1",
    model: "bedrock/example",
    provider: "bedrock",
    content: "pong",
    finishReason: "stop",
    usage: { inputTokens: 8, outputTokens: 1, totalTokens: 9 },
    cost: { amountUsd: 0.001, source: "litellm" },
  });
  const bus = new MiddlewareBus();
  const events: string[] = [];

  bus.use("model.request.before", {
    id: "before",
    type: "observer",
    priority: 1,
    handler(context) {
      events.push(context.event.name);
    },
  });
  bus.use("model.request.after", {
    id: "after",
    type: "observer",
    priority: 1,
    handler(context) {
      events.push(context.event.name);
      assert.equal((context.metadata.modelExecutionResult as { content: string }).content, "pong");
    },
  });

  const outcome = await new LiteLlmModelExecutor({ baseUrl: "http://localhost:4000" }, { bus, gateway }).execute(request());

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.result.content, "pong");
  assert.equal(outcome.result.deployment, "coding-strong-primary");
  assert.equal(outcome.result.provider, "bedrock");
  assert.equal(outcome.result.model, "bedrock/example");
  assert.deepEqual(outcome.result.usage, { inputTokens: 8, outputTokens: 1, totalTokens: 9 });
  assert.deepEqual(outcome.result.cost, { amountUsd: 0.001, source: "litellm" });
  assert.equal(outcome.result.finishReason, "stop");
  assert.ok(outcome.result.latencyMs >= 0);
  assert.equal(outcome.result.rawResponseId, "chatcmpl-1");
  assert.deepEqual(events, ["model.request.before", "model.request.after"]);
});

test("middleware deny before execution guarantees zero model calls", async () => {
  const gateway = new FakeModelGateway(new Error("must not execute"));
  const bus = new MiddlewareBus();

  bus.use("model.request.before", {
    id: "deny",
    type: "policy",
    priority: 1,
    handler() {
      return { action: "deny", reason: "blocked" };
    },
  });

  const outcome = await new LiteLlmModelExecutor({ baseUrl: "http://localhost:4000" }, { bus, gateway }).execute(request());

  assert.equal(outcome.status, "denied");
  assert.equal(outcome.reason, "blocked");
  assert.equal(gateway.calls.length, 0);
});

test("middleware require-human before execution guarantees zero model calls", async () => {
  const gateway = new FakeModelGateway(new Error("must not execute"));
  const bus = new MiddlewareBus();

  bus.use("model.request.before", {
    id: "human",
    type: "policy",
    priority: 1,
    handler() {
      return { action: "require-human", reason: "approval required" };
    },
  });

  const outcome = await new LiteLlmModelExecutor({ baseUrl: "http://localhost:4000" }, { bus, gateway }).execute(request());

  assert.equal(outcome.status, "requires-human");
  assert.equal(outcome.reason, "approval required");
  assert.equal(gateway.calls.length, 0);
});

test("transformer modifies allowed request fields without mutating original request", async () => {
  const gateway = new FakeModelGateway({ content: "pong" });
  const original = request({ parameters: { temperature: 0.8 }, metadata: { source: "test" } });
  const bus = new MiddlewareBus();

  bus.use("model.request.before", {
    id: "cool-down",
    type: "transformer",
    priority: 1,
    handler() {
      return {
        action: "modify",
        patch: {
          metadata: {
            modelExecutionRequest: {
              parameters: { temperature: 0.1 },
              metadata: { transformed: true },
            },
          },
        },
      };
    },
  });

  const outcome = await new LiteLlmModelExecutor({ baseUrl: "http://localhost:4000" }, { bus, gateway }).execute(original);

  assert.equal(outcome.status, "completed");
  assert.equal(gateway.calls[0]?.temperature, 0.1);
  assert.deepEqual(original.parameters, { temperature: 0.8 });
  assert.deepEqual(original.metadata, { source: "test" });
  assert.equal(outcome.result.metadata?.transformed, true);
});

test("invalid request fails before network execution", async () => {
  const gateway = new FakeModelGateway({ content: "pong" });
  const outcome = await new LiteLlmModelExecutor({ baseUrl: "http://localhost:4000" }, { gateway }).execute(
    request({ messages: [] }),
  );

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error.code, "InvalidRequest");
  assert.equal(gateway.calls.length, 0);
});

test("timeout maps to typed RequestTimeout failure", async () => {
  const server = await testServer((_request, _response) => {});

  try {
    const outcome = await new LiteLlmModelExecutor({ baseUrl: server.baseUrl, timeoutMs: 20 }).execute(request());

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error.code, "RequestTimeout");
    assert.equal(outcome.error.retryable, true);
  } finally {
    await server.close();
  }
});

test("malformed HTTP success response maps to InvalidResponse", async () => {
  const server = await testServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ unexpected: true }));
  });

  try {
    const outcome = await new LiteLlmModelExecutor({ baseUrl: server.baseUrl }).execute(request());

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error.code, "InvalidResponse");
  } finally {
    await server.close();
  }
});

test("HTTP 401 and 403 map to AuthenticationFailure", async () => {
  for (const status of [401, 403]) {
    const server = await errorServer(status, "bad auth");
    try {
      const outcome = await new LiteLlmModelExecutor({ baseUrl: server.baseUrl }).execute(request());
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.error.code, "AuthenticationFailure");
      assert.equal(outcome.error.httpStatus, status);
    } finally {
      await server.close();
    }
  }
});

test("HTTP 429 maps to RateLimited", async () => {
  const server = await errorServer(429, "slow down");

  try {
    const outcome = await new LiteLlmModelExecutor({ baseUrl: server.baseUrl }).execute(request());

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error.code, "RateLimited");
    assert.equal(outcome.error.retryable, true);
  } finally {
    await server.close();
  }
});

test("HTTP 5xx maps to UpstreamProviderFailure", async () => {
  const server = await errorServer(502, "upstream failed");

  try {
    const outcome = await new LiteLlmModelExecutor({ baseUrl: server.baseUrl }).execute(request());

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error.code, "UpstreamProviderFailure");
    assert.equal(outcome.error.retryable, true);
  } finally {
    await server.close();
  }
});

test("audit output omits prompt content and secrets", async () => {
  process.env.LITELLM_EXECUTION_SECRET = "secret-value-that-must-not-leak";
  const gateway = new FakeModelGateway({
    id: "chatcmpl-1",
    content: "pong",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });

  const outcome = await new LiteLlmModelExecutor(
    { baseUrl: "http://localhost:4000", apiKeyEnv: "LITELLM_EXECUTION_SECRET" },
    { gateway },
  ).execute(request());

  assert.equal(outcome.status, "completed");
  const serializedAudit = JSON.stringify(outcome.audit);
  assert.equal(serializedAudit.includes("Return exactly: pong"), false);
  assert.equal(serializedAudit.includes("secret-value-that-must-not-leak"), false);
  assert.equal(serializedAudit.includes("LITELLM_EXECUTION_SECRET"), false);
  delete process.env.LITELLM_EXECUTION_SECRET;
});

test("LiteLLM gateway sends chat completion request and normalizes response", async () => {
  let capturedAuth: string | undefined;
  let capturedBody: unknown;
  process.env.LITELLM_GATEWAY_SECRET = "test-token";
  const server = await testServer(async (request, response) => {
    capturedAuth = request.headers.authorization;
    capturedBody = JSON.parse(await readBody(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "chatcmpl-2",
        model: "bedrock/example",
        choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        _hidden_params: { response_cost: 0.002 },
      }),
    );
  });

  try {
    const gateway = new LiteLlmChatGateway({ baseUrl: server.baseUrl, apiKeyEnv: "LITELLM_GATEWAY_SECRET" });
    const result = await gateway.chatCompletion(
      {
        model: "coding-strong-primary",
        messages: [{ role: "user", content: "Return exactly: pong" }],
        temperature: 0,
        max_tokens: 8,
      },
      { timeoutMs: 1_000 },
    );

    assert.equal(capturedAuth, "Bearer test-token");
    assert.deepEqual(capturedBody, {
      model: "coding-strong-primary",
      messages: [{ role: "user", content: "Return exactly: pong" }],
      temperature: 0,
      max_tokens: 8,
    });
    assert.equal(result.content, "pong");
    assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 1, totalTokens: 3 });
    assert.deepEqual(result.cost, { amountUsd: 0.002, source: "litellm" });
  } finally {
    delete process.env.LITELLM_GATEWAY_SECRET;
    await server.close();
  }
});

test("optional real LiteLLM execution smoke test returns non-empty content when enabled", async (t) => {
  if (process.env.RUN_LITELLM_EXECUTION_SMOKE !== "1") {
    t.skip("Set RUN_LITELLM_EXECUTION_SMOKE=1 to run the real LiteLLM execution smoke test.");
    return;
  }

  const baseUrl = process.env.LITELLM_BASE_URL;
  const deployment = process.env.LITELLM_SMOKE_DEPLOYMENT ?? "cheap-primary";
  if (!baseUrl) {
    throw new Error("LITELLM_BASE_URL is required when RUN_LITELLM_EXECUTION_SMOKE=1.");
  }

  const outcome = await new LiteLlmModelExecutor({
    baseUrl,
    apiKeyEnv: "LITELLM_API_KEY",
    timeoutMs: 30_000,
  }).execute(
    request({
      deployment,
      messages: [{ role: "user", content: "Return one short word." }],
    }),
  );

  assert.equal(outcome.status, "completed");
  assert.ok(outcome.result.content.trim().length > 0);
});

test("vertical slice: OpenSpec to router to resolver to executor with mock LiteLLM", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "openspec-execution-"));
  await cp(path.resolve("tests", "fixtures", "openspec-project"), projectRoot, { recursive: true });
  const spec = await new OpenSpecAdapter({
    processRunner: new FakeProcessRunner({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
    }),
  }).inspect({ projectRoot, changeName: "docs-only" });
  assert.ok(spec.context);

  const routingDecision = new StaticModelRouter().route(routingInputFromSpecContext(spec.context));
  const providerResolution = await new LiteLlmProviderResolver(EXAMPLE_LITELLM_RESOLVER_CONFIG).resolve(routingDecision);
  const gateway = new FakeModelGateway({ content: "pong" });
  const execution = await new LiteLlmModelExecutor({ baseUrl: "http://localhost:4000" }, { gateway }).execute(
    request({
      deployment: providerResolution.selected.deployment,
      metadata: {
        changeName: spec.context.changeName,
        modelTier: routingDecision.tier,
      },
    }),
  );

  assert.equal(routingDecision.tier, "cheap");
  assert.equal(providerResolution.selected.deployment, "cheap-primary");
  assert.equal(execution.status, "completed");
  assert.equal(execution.result.content, "pong");
});

async function errorServer(status: number, message: string) {
  return testServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message, code: `HTTP_${status}` } }));
  });
}

async function testServer(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
