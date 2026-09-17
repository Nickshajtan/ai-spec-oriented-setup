import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import {
  EXAMPLE_LITELLM_RESOLVER_CONFIG,
  LiteLlmGateway,
  LiteLlmProviderResolver,
  MiddlewareBus,
  ProviderResolutionError,
} from "../src/index.ts";
import type { GatewayModel, LiteLlmResolverConfig, LlmGateway, RoutingDecision } from "../src/index.ts";

const codingStrongDecision: RoutingDecision = {
  tier: "coding-strong",
  source: "rule",
  matchedRule: "task.feature",
  reason: "feature requires strong coding model tier",
};

class FakeGateway implements LlmGateway {
  private readonly models: GatewayModel[] | Error;

  constructor(models: GatewayModel[] | Error) {
    this.models = models;
  }

  async listModels(): Promise<GatewayModel[]> {
    if (this.models instanceof Error) throw this.models;
    return this.models;
  }
}

function config(): LiteLlmResolverConfig {
  return structuredClone(EXAMPLE_LITELLM_RESOLVER_CONFIG);
}

test("coding-strong tier resolves to configured primary deployment", async () => {
  const resolver = new LiteLlmProviderResolver(config());

  const result = await resolver.resolve(codingStrongDecision);

  assert.equal(result.logicalTier, "coding-strong");
  assert.equal(result.selected.deployment, "coding-strong-primary");
  assert.equal(result.selected.provider, "bedrock");
  assert.equal(result.source, "config");
});

test("fallback chain remains deterministic and ordered", async () => {
  const resolver = new LiteLlmProviderResolver(config());

  const result = await resolver.resolve(codingStrongDecision);

  assert.deepEqual(
    [result.selected.deployment, ...result.fallbacks.map((fallback) => fallback.deployment)],
    ["coding-strong-primary", "coding-strong-fallback"],
  );
});

test("unknown model tier fails explicitly", async () => {
  const resolver = new LiteLlmProviderResolver(config());

  await assert.rejects(
    () => resolver.resolve({ ...codingStrongDecision, tier: "gpt-5" as never }),
    (error) => error instanceof ProviderResolutionError && error.code === "UnknownModelTier",
  );
});

test("missing tier configuration fails eagerly", () => {
  const broken = config();
  delete broken.policy.tiers["coding-strong"];

  assert.throws(
    () => new LiteLlmProviderResolver(broken),
    (error) => error instanceof ProviderResolutionError && error.code === "MissingTierConfiguration",
  );
});

test("configured deployment override succeeds", async () => {
  const resolver = new LiteLlmProviderResolver(config());

  const result = await resolver.resolve(codingStrongDecision, {
    override: { deployment: "coding-strong-fallback" },
  });

  assert.equal(result.selected.deployment, "coding-strong-fallback");
  assert.equal(result.source, "override");
  assert.deepEqual(result.fallbacks, []);
});

test("invalid deployment override fails explicitly", async () => {
  const resolver = new LiteLlmProviderResolver(config());

  await assert.rejects(
    () => resolver.resolve(codingStrongDecision, { override: { deployment: "unconfigured" } }),
    (error) => error instanceof ProviderResolutionError && error.code === "UnknownDeployment",
  );
});

test("middleware deny before resolution prevents gateway lookup", async () => {
  const bus = new MiddlewareBus();
  let gatewayCalls = 0;

  bus.use("provider.resolve.before", {
    id: "deny-provider",
    type: "policy",
    priority: 1,
    handler() {
      return { action: "deny", reason: "provider blocked" };
    },
  });

  const gateway: LlmGateway = {
    async listModels() {
      gatewayCalls += 1;
      return [];
    },
  };

  const result = await new LiteLlmProviderResolver(config(), { gateway }).resolveWithMiddleware(
    codingStrongDecision,
    { checkAvailability: true },
    { bus },
  );

  assert.equal(result.status, "middleware-denied");
  assert.equal(result.error?.message, "provider blocked");
  assert.equal(gatewayCalls, 0);
});

test("middleware require-human before resolution prevents gateway lookup", async () => {
  const bus = new MiddlewareBus();
  let gatewayCalls = 0;

  bus.use("provider.resolve.before", {
    id: "human-provider",
    type: "policy",
    priority: 1,
    handler() {
      return { action: "require-human", reason: "approve provider" };
    },
  });

  const gateway: LlmGateway = {
    async listModels() {
      gatewayCalls += 1;
      return [];
    },
  };

  const result = await new LiteLlmProviderResolver(config(), { gateway }).resolveWithMiddleware(
    codingStrongDecision,
    { checkAvailability: true },
    { bus },
  );

  assert.equal(result.status, "requires-human");
  assert.equal(result.error?.message, "approve provider");
  assert.equal(gatewayCalls, 0);
});

test("transformer can change allowed resolution override before execution", async () => {
  const bus = new MiddlewareBus();
  bus.use("provider.resolve.before", {
    id: "force-fallback",
    type: "transformer",
    priority: 1,
    handler() {
      return {
        action: "modify",
        patch: {
          metadata: {
            providerResolutionContext: {
              override: { deployment: "coding-strong-fallback" },
            },
          },
        },
      };
    },
  });

  const result = await new LiteLlmProviderResolver(config()).resolveWithMiddleware(codingStrongDecision, {}, { bus });

  assert.equal(result.status, "resolved");
  assert.equal(result.result?.source, "override");
  assert.equal(result.result?.selected.deployment, "coding-strong-fallback");
});

test("config validation catches broken deployment references", () => {
  const broken = config();
  broken.policy.tiers["coding-strong"] = {
    primary: "missing-deployment",
  };

  assert.throws(
    () => new LiteLlmProviderResolver(broken),
    (error) => error instanceof ProviderResolutionError && error.code === "UnknownDeployment",
  );
});

test("serialized result and audit do not leak LiteLLM API key values", async () => {
  process.env.LITELLM_TEST_SECRET = "secret-value-that-must-not-leak";
  const resolverConfig = config();
  resolverConfig.endpoint = {
    baseUrl: "http://127.0.0.1:1",
    apiKeyEnv: "LITELLM_TEST_SECRET",
  };
  const resolver = new LiteLlmProviderResolver(resolverConfig, {
    gateway: new FakeGateway([{ id: "coding-strong-primary" }]),
  });

  const result = await resolver.resolveWithMiddleware(codingStrongDecision, { checkAvailability: true });
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes("secret-value-that-must-not-leak"), false);
  assert.equal(serialized.includes("LITELLM_TEST_SECRET"), false);
  delete process.env.LITELLM_TEST_SECRET;
});

test("availability check marks configured deployments using gateway model list", async () => {
  const resolver = new LiteLlmProviderResolver(config(), {
    gateway: new FakeGateway([{ id: "coding-strong-primary" }]),
  });

  const result = await resolver.resolve(codingStrongDecision, { checkAvailability: true });

  assert.equal(result.selected.availability, "available");
  assert.equal(result.fallbacks[0]?.availability, "unavailable");
  assert.equal(result.gatewayStatus, "available");
});

test("gateway unavailable maps to typed LiteLLMUnavailable failure", async () => {
  const resolver = new LiteLlmProviderResolver(config(), {
    gateway: new FakeGateway(new Error("connection refused")),
  });

  await assert.rejects(
    () => resolver.resolve(codingStrongDecision, { checkAvailability: true }),
    (error) => error instanceof ProviderResolutionError && error.code === "LiteLLMUnavailable",
  );
});

test("provider.resolve.after receives audit-safe resolution data", async () => {
  const bus = new MiddlewareBus();
  const events: string[] = [];

  bus.use("provider.resolve.before", {
    id: "before",
    type: "observer",
    priority: 1,
    handler(context) {
      events.push(context.event.name);
    },
  });
  bus.use("provider.resolve.after", {
    id: "after",
    type: "observer",
    priority: 1,
    handler(context) {
      events.push(context.event.name);
      assert.equal((context.metadata.providerResolutionAudit as { selectedDeployment: string }).selectedDeployment, "coding-strong-primary");
    },
  });

  const result = await new LiteLlmProviderResolver(config()).resolveWithMiddleware(codingStrongDecision, {}, { bus });

  assert.equal(result.ok, true);
  assert.deepEqual(events, ["provider.resolve.before", "provider.resolve.after"]);
  assert.deepEqual(result.audit?.fallbackChain, ["coding-strong-primary", "coding-strong-fallback"]);
});

test("LiteLLM gateway parses valid model list response", async () => {
  const server = await testServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "coding-strong-primary" }] }));
  });

  try {
    const gateway = new LiteLlmGateway({ baseUrl: server.baseUrl });
    const models = await gateway.listModels();

    assert.deepEqual(models, [{ id: "coding-strong-primary" }]);
  } finally {
    await server.close();
  }
});

test("LiteLLM gateway reports unavailable endpoint", async () => {
  const server = await testServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unavailable" }));
  });

  try {
    const gateway = new LiteLlmGateway({ baseUrl: server.baseUrl });
    await assert.rejects(
      () => gateway.listModels(),
      (error) => error instanceof ProviderResolutionError && error.code === "LiteLLMUnavailable",
    );
  } finally {
    await server.close();
  }
});

test("LiteLLM gateway rejects malformed model list response", async () => {
  const server = await testServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ models: ["coding-strong-primary"] }));
  });

  try {
    const gateway = new LiteLlmGateway({ baseUrl: server.baseUrl });
    await assert.rejects(
      () => gateway.listModels(),
      (error) => error instanceof ProviderResolutionError && error.code === "InvalidLiteLLMResponse",
    );
  } finally {
    await server.close();
  }
});

test("optional real LiteLLM smoke test resolves configured deployment when enabled", async (t) => {
  if (process.env.RUN_LITELLM_INTEGRATION !== "1") {
    t.skip("Set RUN_LITELLM_INTEGRATION=1 to run the real LiteLLM smoke test.");
    return;
  }

  const baseUrl = process.env.LITELLM_BASE_URL;
  if (!baseUrl) {
    throw new Error("LITELLM_BASE_URL is required when RUN_LITELLM_INTEGRATION=1.");
  }

  const resolverConfig = config();
  resolverConfig.endpoint = {
    baseUrl,
    apiKeyEnv: "LITELLM_API_KEY",
  };

  const resolver = new LiteLlmProviderResolver(resolverConfig);
  const result = await resolver.resolve(codingStrongDecision, { checkAvailability: true });

  assert.equal(result.logicalTier, "coding-strong");
  assert.equal(result.selected.deployment, "coding-strong-primary");
});

async function testServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = createServer(handler);
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
