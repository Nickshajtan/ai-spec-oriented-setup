import assert from "node:assert/strict";
import { mkdtemp, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MiddlewareBus, NodeProcessRunner, OpenSpecAdapter } from "../src/index.ts";
import type { ProcessResult, ProcessRunner } from "../src/index.ts";

class FakeProcessRunner implements ProcessRunner {
  calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  private readonly result: ProcessResult;

  constructor(result: ProcessResult) {
    this.result = result;
  }

  async run(command: string, args: string[], options: { cwd: string }): Promise<ProcessResult> {
    this.calls.push({ command, args, cwd: options.cwd });
    return this.result;
  }
}

async function fixtureProject(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "openspec-adapter-"));
  await cp(path.resolve("tests", "fixtures", "openspec-project"), projectRoot, { recursive: true });
  return projectRoot;
}

test("valid change is validated, normalized, and emits before/after events", async () => {
  const projectRoot = await fixtureProject();
  const runner = new FakeProcessRunner({
    exitCode: 0,
    stdout: JSON.stringify({ ok: true }),
    stderr: "",
  });
  const bus = new MiddlewareBus();
  const events: string[] = [];

  bus.use("spec.validate.before", {
    id: "before-observer",
    type: "observer",
    priority: 1,
    handler(context) {
      events.push(context.event.name);
    },
  });
  bus.use("spec.validate.after", {
    id: "after-observer",
    type: "observer",
    priority: 1,
    handler(context) {
      events.push(context.event.name);
      assert.equal((context.metadata.spec as { changeName: string }).changeName, "add-health-check");
    },
  });

  const adapter = new OpenSpecAdapter({ bus, processRunner: runner });
  const result = await adapter.inspect({ projectRoot, changeName: "add-health-check" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "valid");
  assert.equal(result.context?.system, "openspec");
  assert.equal(result.context?.metadata?.schema, "1.0.0");
  assert.equal(result.context?.metadata?.created, "2026-09-05");
  assert.equal(result.context?.metadata?.goal, "Add a simple health check capability.");
  assert.deepEqual(result.context?.metadata?.affectedAreas, ["api", "ops"]);
  assert.equal(result.context?.metadata?.skipSpecs, false);
  assert.equal(result.context?.artifacts.proposal?.path, "openspec/changes/add-health-check/proposal.md");
  assert.equal(result.context?.artifacts.design?.path, "openspec/changes/add-health-check/design.md");
  assert.equal(result.context?.artifacts.tasks?.path, "openspec/changes/add-health-check/tasks.md");
  assert.equal(result.context?.artifacts.metadata?.path, "openspec/changes/add-health-check/.openspec.yaml");
  assert.deepEqual(
    result.context?.artifacts.specs.map((artifact) => artifact.path),
    ["openspec/changes/add-health-check/specs/health-check/spec.md"],
  );
  assert.deepEqual(result.context?.taskProgress, { completed: 1, total: 2 });
  assert.deepEqual(events, ["spec.validate.before", "spec.validate.after"]);
  assert.deepEqual(runner.calls[0]?.args, ["validate", "add-health-check", "--json", "--no-interactive"]);
  assert.equal(runner.calls[0]?.cwd, projectRoot);
});

test("invalid change returns validation failure and still emits after event", async () => {
  const projectRoot = await fixtureProject();
  const runner = new FakeProcessRunner({
    exitCode: 1,
    stdout: JSON.stringify({ errors: [{ message: "invalid change" }] }),
    stderr: "invalid change",
  });
  const bus = new MiddlewareBus();
  const events: string[] = [];

  bus.use("spec.validate.after", {
    id: "after-observer",
    type: "observer",
    priority: 1,
    handler(context) {
      events.push(context.event.name);
    },
  });

  const adapter = new OpenSpecAdapter({ bus, processRunner: runner });
  const result = await adapter.inspect({ projectRoot, changeName: "add-health-check" });

  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid");
  assert.equal(result.context?.validation.valid, false);
  assert.equal(result.context?.validation.exitCode, 1);
  assert.equal(result.context?.validation.stderr, "invalid change");
  assert.deepEqual(result.context?.validation.findings, [{ errors: [{ message: "invalid change" }] }]);
  assert.deepEqual(events, ["spec.validate.after"]);
});

test("missing change is distinct from invalid spec", async () => {
  const projectRoot = await fixtureProject();
  const runner = new FakeProcessRunner({ exitCode: 0, stdout: "", stderr: "" });
  const adapter = new OpenSpecAdapter({ processRunner: runner });

  const result = await adapter.inspect({ projectRoot, changeName: "missing-change" });

  assert.equal(result.ok, false);
  assert.equal(result.status, "missing-change");
  assert.equal(result.context, undefined);
  assert.equal(runner.calls.length, 0);
});

test("uninitialized project is reported before invoking CLI", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "plain-project-"));
  const runner = new FakeProcessRunner({ exitCode: 0, stdout: "", stderr: "" });
  const adapter = new OpenSpecAdapter({ processRunner: runner });

  const result = await adapter.inspect({ projectRoot, changeName: "add-health-check" });

  assert.equal(result.status, "project-not-initialized");
  assert.equal(runner.calls.length, 0);
});

test("OpenSpec CLI unavailable is a distinct error", async () => {
  const projectRoot = await fixtureProject();
  const runner = new FakeProcessRunner({
    exitCode: -1,
    stdout: "",
    stderr: "",
    error: Object.assign(new Error("not found"), { code: "ENOENT" }),
  });
  const adapter = new OpenSpecAdapter({ processRunner: runner });

  const result = await adapter.inspect({ projectRoot, changeName: "add-health-check" });

  assert.equal(result.status, "cli-unavailable");
  assert.match(result.error?.message ?? "", /OpenSpec CLI is unavailable/);
});

test("middleware deny before validation prevents CLI execution", async () => {
  const projectRoot = await fixtureProject();
  const runner = new FakeProcessRunner({ exitCode: 0, stdout: "", stderr: "" });
  const bus = new MiddlewareBus();

  bus.use("spec.validate.before", {
    id: "deny",
    type: "policy",
    priority: 1,
    handler() {
      return { action: "deny", reason: "blocked" };
    },
  });

  const adapter = new OpenSpecAdapter({ bus, processRunner: runner });
  const result = await adapter.inspect({ projectRoot, changeName: "add-health-check" });

  assert.equal(result.status, "middleware-denied");
  assert.equal(result.error?.message, "blocked");
  assert.equal(runner.calls.length, 0);
});

test("middleware require-human before validation prevents CLI execution", async () => {
  const projectRoot = await fixtureProject();
  const runner = new FakeProcessRunner({ exitCode: 0, stdout: "", stderr: "" });
  const bus = new MiddlewareBus();

  bus.use("spec.validate.before", {
    id: "human",
    type: "policy",
    priority: 1,
    handler() {
      return { action: "require-human", reason: "review first" };
    },
  });

  const adapter = new OpenSpecAdapter({ bus, processRunner: runner });
  const result = await adapter.inspect({ projectRoot, changeName: "add-health-check" });

  assert.equal(result.status, "requires-human");
  assert.equal(result.error?.message, "review first");
  assert.equal(runner.calls.length, 0);
});

test("middleware ordering is preserved for OpenSpec events", async () => {
  const projectRoot = await fixtureProject();
  const runner = new FakeProcessRunner({ exitCode: 0, stdout: "", stderr: "" });
  const bus = new MiddlewareBus();
  const calls: string[] = [];

  bus.use("spec.validate.before", {
    id: "later",
    type: "observer",
    priority: 20,
    handler() {
      calls.push("later");
    },
  });
  bus.use("spec.validate.before", {
    id: "earlier",
    type: "observer",
    priority: 10,
    handler() {
      calls.push("earlier");
    },
  });

  await new OpenSpecAdapter({ bus, processRunner: runner }).inspect({ projectRoot, changeName: "add-health-check" });

  assert.deepEqual(calls, ["earlier", "later"]);
});

test("path traversal change names are rejected", async () => {
  const projectRoot = await fixtureProject();
  const runner = new FakeProcessRunner({ exitCode: 0, stdout: "", stderr: "" });
  const adapter = new OpenSpecAdapter({ processRunner: runner });

  const result = await adapter.inspect({ projectRoot, changeName: "../../something" });

  assert.equal(result.status, "path-rejected");
  assert.equal(runner.calls.length, 0);
});

test("metadata known fields normalize and unknown fields are ignored", async () => {
  const projectRoot = await fixtureProject();
  const runner = new FakeProcessRunner({ exitCode: 0, stdout: "", stderr: "" });
  const adapter = new OpenSpecAdapter({ processRunner: runner });

  const result = await adapter.inspect({ projectRoot, changeName: "add-health-check" });

  assert.deepEqual(result.context?.metadata, {
    schema: "1.0.0",
    created: "2026-09-05",
    goal: "Add a simple health check capability.",
    affectedAreas: ["api", "ops"],
    skipSpecs: false,
  });
});

test("optional design and specs artifacts can be absent", async () => {
  const projectRoot = await fixtureProject();
  const runner = new FakeProcessRunner({ exitCode: 0, stdout: "", stderr: "" });
  const adapter = new OpenSpecAdapter({ processRunner: runner });

  const result = await adapter.inspect({ projectRoot, changeName: "docs-only" });

  assert.equal(result.status, "valid");
  assert.equal(result.context?.artifacts.design, undefined);
  assert.deepEqual(result.context?.artifacts.specs, []);
});

test("real OpenSpec CLI fixture validation runs when CLI is available", async (t) => {
  const availability = await new NodeProcessRunner().run("openspec", ["--version"], { cwd: process.cwd(), timeoutMs: 5_000 });
  if (availability.error?.code === "ENOENT") {
    t.skip("openspec CLI is not installed");
    return;
  }

  const projectRoot = await fixtureProject();
  const result = await new OpenSpecAdapter().inspect({ projectRoot, changeName: "add-health-check" });

  assert.equal(result.middleware.before?.result.action, "continue");
  assert.equal(typeof result.context?.validation.exitCode, "number");
});
