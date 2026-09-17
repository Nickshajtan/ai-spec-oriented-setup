import assert from "node:assert/strict";
import { mkdtemp, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MiddlewareBus,
  OpenSpecAdapter,
  RoutingValidationError,
  StaticModelRouter,
  routingInputFromSpecContext,
} from "../src/index.ts";
import type { ProcessResult, ProcessRunner, RoutingInput } from "../src/index.ts";

class FakeProcessRunner implements ProcessRunner {
  private readonly result: ProcessResult;

  constructor(result: ProcessResult) {
    this.result = result;
  }

  async run(): Promise<ProcessResult> {
    return this.result;
  }
}

function route(taskType: string, input: Partial<RoutingInput> = {}) {
  return new StaticModelRouter().route({
    ...input,
    task: { type: taskType, ...input.task },
  });
}

test("documentation routes to cheap", () => {
  assert.equal(route("documentation").tier, "cheap");
});

test("small-fix routes to coding-fast", () => {
  assert.equal(route("small-fix").tier, "coding-fast");
});

test("feature routes to coding-strong", () => {
  assert.equal(route("feature").tier, "coding-strong");
});

test("architecture routes to reasoning-strong", () => {
  assert.equal(route("architecture").tier, "reasoning-strong");
});

test("review routes to reviewer", () => {
  assert.equal(route("review").tier, "reviewer");
});

test("unknown task uses explicit default tier", () => {
  const decision = route("unknown-task");

  assert.equal(decision.tier, "coding-strong");
  assert.equal(decision.source, "default");
  assert.equal(decision.matchedRule, undefined);
});

test("explicit override takes precedence", () => {
  const decision = route("feature", { override: { modelTier: "reasoning-strong" } });

  assert.equal(decision.tier, "reasoning-strong");
  assert.equal(decision.source, "override");
});

test("invalid override fails explicitly", () => {
  assert.throws(
    () => route("feature", { override: { modelTier: "gpt-5" } as never }),
    (error) => error instanceof RoutingValidationError && /Invalid override\.modelTier/.test(error.message),
  );
});

test("high risk promotes configured task tiers", () => {
  assert.equal(route("documentation", { task: { risk: "high" } }).tier, "coding-strong");
  assert.equal(route("small-fix", { task: { risk: "high" } }).tier, "coding-strong");
  assert.equal(route("feature", { task: { risk: "high" } }).tier, "reasoning-strong");
  assert.equal(route("review", { task: { risk: "high" } }).tier, "reviewer");
});

test("transformer before route can modify routing input", async () => {
  const bus = new MiddlewareBus();
  bus.use("model.route.before", {
    id: "force-docs",
    type: "transformer",
    priority: 1,
    handler() {
      return { action: "modify", patch: { task: { type: "documentation" } } };
    },
  });

  const result = await new StaticModelRouter().routeWithMiddleware({ task: { type: "feature" } }, { bus });

  assert.equal(result.status, "routed");
  assert.equal(result.decision?.tier, "cheap");
});

test("policy deny before route prevents router execution", async () => {
  const bus = new MiddlewareBus();
  bus.use("model.route.before", {
    id: "deny",
    type: "policy",
    priority: 1,
    handler() {
      return { action: "deny", reason: "no route" };
    },
  });

  const result = await new StaticModelRouter().routeWithMiddleware({ task: { type: "feature" } }, { bus });

  assert.equal(result.ok, false);
  assert.equal(result.status, "middleware-denied");
  assert.equal(result.decision, undefined);
  assert.equal(result.error?.message, "no route");
});

test("policy require-human before route prevents router execution", async () => {
  const bus = new MiddlewareBus();
  bus.use("model.route.before", {
    id: "human",
    type: "policy",
    priority: 1,
    handler() {
      return { action: "require-human", reason: "review route" };
    },
  });

  const result = await new StaticModelRouter().routeWithMiddleware({ task: { type: "feature" } }, { bus });

  assert.equal(result.ok, false);
  assert.equal(result.status, "requires-human");
  assert.equal(result.decision, undefined);
  assert.equal(result.error?.message, "review route");
});

test("model.route.after is emitted and receives routing decision metadata", async () => {
  const bus = new MiddlewareBus();
  const events: string[] = [];

  bus.use("model.route.before", {
    id: "before",
    type: "observer",
    priority: 1,
    handler(context) {
      events.push(context.event.name);
    },
  });
  bus.use("model.route.after", {
    id: "after",
    type: "observer",
    priority: 1,
    handler(context) {
      events.push(context.event.name);
      assert.equal((context.metadata.routingDecision as { tier: string }).tier, "coding-strong");
    },
  });

  const result = await new StaticModelRouter().routeWithMiddleware({ task: { type: "feature" } }, { bus });

  assert.equal(result.ok, true);
  assert.deepEqual(events, ["model.route.before", "model.route.after"]);
});

test("every successful decision contains a non-empty reason and audit summary", async () => {
  const result = await new StaticModelRouter().routeWithMiddleware({
    task: { type: "feature", risk: "medium" },
    spec: { changeName: "add-health-check" },
  });

  assert.ok(result.decision?.reason);
  assert.equal(result.audit?.selectedTier, "coding-strong");
  assert.equal(result.audit?.decisionSource, "rule");
  assert.equal(result.audit?.inputSummary.taskType, "feature");
  assert.equal(result.audit?.inputSummary.changeName, "add-health-check");
});

test("routing is deterministic for the same input and config", () => {
  const router = new StaticModelRouter();
  const input: RoutingInput = { task: { type: "feature", risk: "high" } };

  assert.deepEqual(router.route(input), router.route(input));
});

test("invalid routing config fails early", () => {
  assert.throws(
    () =>
      new StaticModelRouter({
        defaultTier: "coding-strong",
        rules: [
          { id: "duplicate", taskType: "a", tier: "cheap" },
          { id: "duplicate", taskType: "b", tier: "coding-fast" },
        ],
      }),
    /Duplicate routing rule id/,
  );

  assert.throws(
    () =>
      new StaticModelRouter({
        defaultTier: "gpt-5" as never,
        rules: [],
      }),
    /Invalid defaultTier/,
  );
});

test("OpenSpec inspection can derive routing input from normalized metadata", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "openspec-routing-"));
  await cp(path.resolve("tests", "fixtures", "openspec-project"), projectRoot, { recursive: true });

  const adapter = new OpenSpecAdapter({
    processRunner: new FakeProcessRunner({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
    }),
  });
  const inspected = await adapter.inspect({ projectRoot, changeName: "docs-only" });
  assert.ok(inspected.context);

  const routingInput = routingInputFromSpecContext(inspected.context);
  const decision = new StaticModelRouter().route(routingInput);

  assert.equal(routingInput.task.type, "documentation");
  assert.equal(decision.tier, "cheap");
});
