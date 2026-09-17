import assert from "node:assert/strict";
import test from "node:test";
import { MiddlewareBus, createLimitWarnings, createLimitsGuard, createLoggingObserver } from "../src/index.ts";
import type { MiddlewareContext, ObserverMiddleware, PolicyMiddleware, TransformerMiddleware } from "../src/index.ts";

function baseContext(overrides: Partial<Omit<MiddlewareContext, "event">> = {}): Omit<MiddlewareContext, "event"> {
  return {
    runId: "run-1",
    subjectId: "change-1",
    metadata: {},
    ...overrides,
  };
}

test("registers middleware for Specifier domain events only", async () => {
  const bus = new MiddlewareBus();
  const observed: string[] = [];

  bus.use("openspec.validate.before", {
    id: "observe",
    type: "observer",
    priority: 1,
    handler(context) {
      observed.push(context.event.name);
    },
  });

  assert.equal(bus.getMiddleware("openspec.validate.before").length, 1);
  assert.equal(bus.getMiddleware("review.request.before").length, 0);

  await bus.execute("review.request.before", baseContext());
  await bus.execute("openspec.validate.before", baseContext());

  assert.deepEqual(observed, ["openspec.validate.before"]);
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

  bus.use("review.request.before", transformer("transformer-low", 1));
  bus.use("review.request.before", observer("observer-b", 20));
  bus.use("review.request.before", observer("observer-a", 10));
  bus.use("review.request.before", observer("observer-c", 20));

  await bus.execute("review.request.before", baseContext());

  assert.deepEqual(calls, ["observer-a", "observer-b", "observer-c", "transformer-low"]);
});

test("observer is read-only and cannot block execution", async () => {
  const bus = new MiddlewareBus();
  bus.use("run.started", {
    id: "bad-observer",
    type: "observer",
    priority: 1,
    failureMode: "fail-open",
    handler() {
      return { action: "deny", reason: "not allowed" } as never;
    },
  });

  const execution = await bus.execute("run.started", baseContext());

  assert.equal(execution.result.action, "continue");
  assert.equal(execution.records[0]?.error?.message, "Observer bad-observer returned an executable action");
});

test("policy continue, deny, and require-human semantics", async () => {
  const continueBus = new MiddlewareBus();
  continueBus.use("interview.turn.before", createLimitsGuard({ maxInterviewTurns: 3 }));
  assert.equal(
    (await continueBus.execute("interview.turn.before", baseContext({ lifecycle: { interviewTurn: 2 } }))).result.action,
    "continue",
  );

  const denied = await continueBus.execute("interview.turn.before", baseContext({ lifecycle: { interviewTurn: 4 } }));
  assert.deepEqual(denied.result, { action: "deny", reason: "Maximum interview turns exceeded: 3" });

  const humanBus = new MiddlewareBus();
  const humanPolicy: PolicyMiddleware = {
    id: "human-review",
    type: "policy",
    priority: 1,
    handler() {
      return { action: "require-human", reason: "Review needs approval" };
    },
  };
  humanBus.use("review.request.before", humanPolicy);
  const human = await humanBus.execute("review.request.before", baseContext());
  assert.deepEqual(human.result, { action: "require-human", reason: "Review needs approval" });
});

test("transformer returns explicit patch without mutating original context", async () => {
  const bus = new MiddlewareBus();
  const original = baseContext({ metadata: { artifactSizeBytes: 200 } });

  bus.use("openspec.validate.after", createLimitWarnings({ artifactSizeWarningBytes: 100 }));
  const execution = await bus.execute("openspec.validate.after", original);

  assert.equal(execution.result.action, "continue");
  assert.deepEqual(execution.context.warnings, ["Artifact size is 200 bytes; warning threshold is 100 bytes."]);
  assert.equal(original.warnings, undefined);
});

test("transformer cannot patch identity or event fields", async () => {
  const bus = new MiddlewareBus();
  bus.use("review.request.before", {
    id: "identity-transformer",
    type: "transformer",
    priority: 1,
    failureMode: "fail-closed",
    handler() {
      return { action: "modify", patch: { runId: "other-run" } } as never;
    },
  });

  const execution = await bus.execute("review.request.before", baseContext());

  assert.equal(execution.result.action, "deny");
  assert.equal(execution.context.runId, "run-1");
  assert.equal(execution.records[0]?.error?.message, "Transformer identity-transformer returned unsupported patch keys: runId");
});

test("fail-open records errors and continues; fail-closed records errors and stops", async () => {
  const openBus = new MiddlewareBus();
  const openCalls: string[] = [];
  openBus.use("run.started", {
    id: "open-error",
    type: "observer",
    priority: 1,
    failureMode: "fail-open",
    handler() {
      throw new Error("telemetry down");
    },
  });
  openBus.use("run.started", {
    id: "later-policy",
    type: "policy",
    priority: 1,
    handler() {
      openCalls.push("later-policy");
      return { action: "continue" };
    },
  });

  const openResult = await openBus.execute("run.started", baseContext());
  assert.equal(openResult.result.action, "continue");
  assert.deepEqual(openCalls, ["later-policy"]);
  assert.equal(openResult.records[0]?.error?.message, "telemetry down");

  const closedBus = new MiddlewareBus();
  closedBus.use("review.request.before", {
    id: "closed-error",
    type: "policy",
    priority: 1,
    failureMode: "fail-closed",
    handler() {
      throw new Error("policy unavailable");
    },
  });

  const closedResult = await closedBus.execute("review.request.before", baseContext());
  assert.deepEqual(closedResult.result, { action: "deny", reason: "Middleware closed-error failed closed" });
  assert.equal(closedResult.records[0]?.error?.message, "policy unavailable");
});

test("logging observer writes lifecycle event without requiring core behavior", async () => {
  const messages: string[] = [];
  const bus = new MiddlewareBus();
  bus.use(
    "run.started",
    createLoggingObserver({
      logger: {
        info(message) {
          messages.push(message);
        },
      },
    }),
  );

  await bus.execute("run.started", baseContext());

  assert.deepEqual(messages, ["specifier lifecycle event: run.started"]);
});
