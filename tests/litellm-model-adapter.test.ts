import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { LiteLLMModelAdapter, ModelInvocationError } from "../src/index.ts";

test("LiteLLM adapter sends chat completion request and normalizes response", async () => {
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
        model: "litellm/example",
        choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }),
    );
  });

  try {
    const adapter = new LiteLLMModelAdapter({ baseUrl: server.baseUrl, apiKeyEnv: "LITELLM_GATEWAY_SECRET" });
    const result = await adapter.complete({
      model: "specifier-reviewer",
      purpose: "review",
      messages: [{ role: "user", content: "Return exactly: pong" }],
      parameters: { temperature: 0, maxTokens: 8 },
      metadata: { trace: "test" },
    });

    assert.equal(capturedAuth, "Bearer test-token");
    assert.deepEqual(capturedBody, {
      model: "specifier-reviewer",
      messages: [{ role: "user", content: "Return exactly: pong" }],
      temperature: 0,
      max_tokens: 8,
    });
    assert.equal(result.content, "pong");
    assert.equal(result.model, "litellm/example");
    assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 1, totalTokens: 3 });
    assert.equal(result.finishReason, "stop");
    assert.equal(result.rawResponseId, "chatcmpl-2");
    assert.deepEqual(result.metadata, { trace: "test" });
  } finally {
    delete process.env.LITELLM_GATEWAY_SECRET;
    await server.close();
  }
});

test("adapter rejects invalid requests before network execution", async () => {
  const adapter = new LiteLLMModelAdapter({ baseUrl: "http://127.0.0.1:1" });

  await assert.rejects(
    () => adapter.complete({ model: "specifier-reviewer", messages: [] }),
    (error) => error instanceof ModelInvocationError && error.modelError.code === "InvalidRequest",
  );
});

test("HTTP failures map to provider-neutral model errors", async () => {
  const server = await testServer((_request, response) => {
    response.writeHead(429, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "slow down", code: "rate_limit" } }));
  });

  try {
    const adapter = new LiteLLMModelAdapter({ baseUrl: server.baseUrl });
    await assert.rejects(
      () => adapter.complete({ model: "specifier-reviewer", messages: [{ role: "user", content: "hello" }] }),
      (error) =>
        error instanceof ModelInvocationError &&
        error.modelError.code === "RateLimited" &&
        error.modelError.retryable === true &&
        error.modelError.upstreamCode === "rate_limit",
    );
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
    const adapter = new LiteLLMModelAdapter({ baseUrl: server.baseUrl });
    await assert.rejects(
      () => adapter.complete({ model: "specifier-reviewer", messages: [{ role: "user", content: "hello" }] }),
      (error) => error instanceof ModelInvocationError && error.modelError.code === "InvalidResponse",
    );
  } finally {
    await server.close();
  }
});

test("timeout maps to typed RequestTimeout failure", async () => {
  const server = await testServer((_request, _response) => undefined);

  try {
    const adapter = new LiteLLMModelAdapter({ baseUrl: server.baseUrl, timeoutMs: 20 });
    await assert.rejects(
      () => adapter.complete({ model: "specifier-reviewer", messages: [{ role: "user", content: "hello" }] }),
      (error) => error instanceof ModelInvocationError && error.modelError.code === "RequestTimeout",
    );
  } finally {
    await server.close();
  }
});

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
