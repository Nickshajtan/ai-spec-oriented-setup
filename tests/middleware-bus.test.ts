import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAuditSink, MiddlewareBus, createAuditObserver, createBudgetPolicy, createModelTierTransformer } from "../src/index.ts";
import type { MiddlewareContext, ObserverMiddleware, PolicyMiddleware, TransformerMiddleware } from "../src/index.ts";

function baseContext(overrides: Partial<Omit<MiddlewareContext, "event">> = {}): Omit<MiddlewareContext, "event"> {
  return {
    runId: "run-1",
    taskId: "task-1",
    metadata: {},
    ...overrides,
  };
}

test("registers middleware for the correct event only", async () => {
  const bus = new MiddlewareBus();
  const observed: string[] = [];

  bus.use("model.route.before", createAuditObserver((eventName) => observed.push(eventName)));

  assert.equal(bus.getMiddleware("model.route.before").length, 1);
  assert.equal(bus.getMiddleware("model.request.before").length, 0);

  await bus.execute("model.request.before", baseContext());
  assert.deepEqual(observed, []);

  await bus.execute("model.route.before", baseContext());
  assert.deepEqual(observed, ["model.route.before"]);
});

test("orders by phase, priority, and stable registration order", async () => {
  const bus = new MiddlewareBus();
  const calls: string[] = [];

  const observer = (id: string, priority: number): ObserverMiddleware => ({
    id,
    type: "observer",
    priority,
    handler() {
      calls.push(id);
    },
  });

  const transformer = (id: string, priority: number): TransformerMiddleware => ({
    id,
    type: "transformer",
    priority,
    handler() {
      calls.push(id);
      return { action: "continue" };
    },
  });

  bus.use("verify.before", transformer("transformer-low", 1));
  bus.use("verify.before", observer("observer-b", 20));
  bus.use("verify.before", observer("observer-a", 10));
  bus.use("verify.before", observer("observer-c", 20));

  await bus.execute("verify.before", baseContext());

  assert.deepEqual(calls, ["observer-a", "observer-b", "observer-c", "transformer-low"]);
});

test("observer receives context and cannot modify or block execution", async () => {
  const bus = new MiddlewareBus();
  const seen: string[] = [];

  bus.use("run.started", {
    id: "bad-observer",
    type: "observer",
    priority: 1,
    failureMode: "fail-open",
    handler(context) {
      seen.push(context.runId);
      return { action: "deny", reason: "not allowed" } as never;
    },
  });

  const execution = await bus.execute("run.started", baseContext());

  assert.deepEqual(seen, ["run-1"]);
  assert.equal(execution.result.action, "continue");
  assert.equal(execution.audit[0]?.error?.message, "Observer bad-observer returned an executable action");
});

test("policy continue, deny, and require-human semantics", async () => {
  const continueBus = new MiddlewareBus();
  continueBus.use("model.request.before", createBudgetPolicy());
  assert.equal((await continueBus.execute("model.request.before", baseContext({ budget: { maxCostUsd: 10, spentUsd: 5 } }))).result.action, "continue");

  const denyBus = new MiddlewareBus();
  denyBus.use("model.request.before", createBudgetPolicy());
  const denied = await denyBus.execute("model.request.before", baseContext({ budget: { maxCostUsd: 10, spentUsd: 10 } }));
  assert.deepEqual(denied.result, { action: "deny", reason: "Budget exhausted" });

  const humanBus = new MiddlewareBus();
  const humanPolicy: PolicyMiddleware = {
    id: "human-review",
    type: "policy",
    priority: 1,
    handler() {
      return { action: "require-human", reason: "High risk task" };
    },
  };
  humanBus.use("model.request.before", humanPolicy);
  const human = await humanBus.execute("model.request.before", baseContext());
  assert.deepEqual(human.result, { action: "require-human", reason: "High risk task" });
});

test("policy stop prevents later executable middleware processing", async () => {
  const bus = new MiddlewareBus();
  const calls: string[] = [];

  bus.use("model.request.before", {
    id: "deny",
    type: "policy",
    priority: 1,
    handler() {
      calls.push("deny");
      return { action: "deny", reason: "no" };
    },
  });
  bus.use("model.request.before", {
    id: "later-transformer",
    type: "transformer",
    priority: 1,
    handler() {
      calls.push("later-transformer");
      return { action: "continue" };
    },
  });

  await bus.execute("model.request.before", baseContext());
  assert.deepEqual(calls, ["deny"]);
});

test("transformer returns explicit patch without mutating original context", async () => {
  const bus = new MiddlewareBus();
  const original = baseContext({ task: { type: "documentation" }, routing: { provider: "example" } });

  bus.use("model.route.before", createModelTierTransformer());
  const execution = await bus.execute("model.route.before", original);

  assert.equal(execution.result.action, "continue");
  assert.deepEqual(execution.context.routing, { provider: "example", modelTier: "cheap" });
  assert.deepEqual(original.routing, { provider: "example" });
});

test("transformer cannot deny execution", async () => {
  const bus = new MiddlewareBus();
  const badTransformer: TransformerMiddleware = {
    id: "bad-transformer",
    type: "transformer",
    priority: 1,
    failureMode: "fail-closed",
    handler() {
      return { action: "deny", reason: "not allowed" } as never;
    },
  };

  bus.use("model.route.before", badTransformer);
  const execution = await bus.execute("model.route.before", baseContext());

  assert.equal(execution.result.action, "deny");
  assert.equal(execution.audit[0]?.error?.message, "Transformer bad-transformer returned an unsupported action");
});

test("transformer cannot patch identity or event fields", async () => {
  const bus = new MiddlewareBus();
  bus.use("model.route.before", {
    id: "identity-transformer",
    type: "transformer",
    priority: 1,
    failureMode: "fail-closed",
    handler() {
      return { action: "modify", patch: { runId: "other-run" } } as never;
    },
  });

  const execution = await bus.execute("model.route.before", baseContext());

  assert.equal(execution.result.action, "deny");
  assert.equal(execution.context.runId, "run-1");
  assert.equal(execution.audit[0]?.error?.message, "Transformer identity-transformer returned unsupported patch keys: runId");
});

test("fail-open records errors and continues; fail-closed records errors and stops", async () => {
  const openBus = new MiddlewareBus();
  const openCalls: string[] = [];
  openBus.use("tool.execute.before", {
    id: "open-error",
    type: "observer",
    priority: 1,
    failureMode: "fail-open",
    handler() {
      throw new Error("telemetry down");
    },
  });
  openBus.use("tool.execute.before", {
    id: "later-policy",
    type: "policy",
    priority: 1,
    handler() {
      openCalls.push("later-policy");
      return { action: "continue" };
    },
  });

  const openResult = await openBus.execute("tool.execute.before", baseContext());
  assert.equal(openResult.result.action, "continue");
  assert.deepEqual(openCalls, ["later-policy"]);
  assert.equal(openResult.audit[0]?.error?.message, "telemetry down");

  const closedBus = new MiddlewareBus();
  const closedCalls: string[] = [];
  closedBus.use("tool.execute.before", {
    id: "closed-error",
    type: "policy",
    priority: 1,
    failureMode: "fail-closed",
    handler() {
      throw new Error("policy unavailable");
    },
  });
  closedBus.use("tool.execute.before", {
    id: "later-policy",
    type: "policy",
    priority: 2,
    handler() {
      closedCalls.push("later-policy");
      return { action: "continue" };
    },
  });

  const closedResult = await closedBus.execute("tool.execute.before", baseContext());
  assert.deepEqual(closedResult.result, { action: "deny", reason: "Middleware closed-error failed closed" });
  assert.deepEqual(closedCalls, []);
  assert.equal(closedResult.audit[0]?.error?.message, "policy unavailable");
});

test("middleware executions produce audit records in the returned result and sink", async () => {
  const auditSink = new InMemoryAuditSink();
  const bus = new MiddlewareBus(auditSink);

  bus.use("verify.after", createAuditObserver());
  bus.use("verify.after", {
    id: "verify-policy",
    type: "policy",
    priority: 1,
    handler() {
      return { action: "continue" };
    },
  });

  const execution = await bus.execute("verify.after", baseContext());
  const sinkRecords = auditSink.getRecords();

  assert.equal(execution.audit.length, 2);
  assert.equal(sinkRecords.length, 2);
  assert.deepEqual(
    execution.audit.map((record) => ({
      event: record.event,
      middlewareId: record.middlewareId,
      middlewareType: record.middlewareType,
      resultAction: record.resultAction,
      hasDuration: record.durationMs >= 0,
    })),
    [
      {
        event: "verify.after",
        middlewareId: "audit-observer",
        middlewareType: "observer",
        resultAction: "continue",
        hasDuration: true,
      },
      {
        event: "verify.after",
        middlewareId: "verify-policy",
        middlewareType: "policy",
        resultAction: "continue",
        hasDuration: true,
      },
    ],
  );
});
