import assert from "node:assert/strict";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CliOpenSpecGateway, MiddlewareBus, NodeProcessRunner } from "../src/index.ts";
import type { ProcessResult, ProcessRunner } from "../src/index.ts";

class FakeProcessRunner implements ProcessRunner {
  calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  private readonly results: ProcessResult[];

  constructor(...results: ProcessResult[]) {
    this.results = results;
  }

  async run(command: string, args: string[], options: { cwd: string }): Promise<ProcessResult> {
    this.calls.push({ command, args, cwd: options.cwd });
    return this.results.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
  }
}

async function fixtureProject(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "openspec-gateway-"));
  await cp(path.resolve("tests", "fixtures", "openspec-project"), projectRoot, { recursive: true });
  return projectRoot;
}

test("validate uses verified OpenSpec CLI command and preserves raw output", async () => {
  const projectRoot = await fixtureProject();
  const raw = { items: [{ id: "add-health-check", valid: true, message: "ok" }] };
  const runner = new FakeProcessRunner({ exitCode: 0, stdout: JSON.stringify(raw), stderr: "" });
  const bus = new MiddlewareBus();
  const events: string[] = [];

  bus.use("openspec.validate.before", {
    id: "before-observer",
    type: "observer",
    priority: 1,
    handler(context) {
      events.push(context.event.name);
    },
  });
  bus.use("openspec.validate.after", {
    id: "after-observer",
    type: "observer",
    priority: 1,
    handler(context) {
      events.push(context.event.name);
      assert.equal((context.metadata.specContext as { changeName: string }).changeName, "add-health-check");
    },
  });

  const result = await new CliOpenSpecGateway({ bus, processRunner: runner }).validate({ projectRoot, changeName: "add-health-check" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "valid");
  assert.deepEqual(result.context?.openspec.validation?.raw, raw);
  assert.deepEqual(result.context?.openspec.validation?.findings, [{ message: "ok", raw: raw.items[0] }]);
  assert.deepEqual(events, ["openspec.validate.before", "openspec.validate.after"]);
  assert.deepEqual(runner.calls[0]?.args, ["validate", "add-health-check", "--json", "--no-interactive"]);
});

test("status normalizes generic artifacts without standard artifact assumptions", async () => {
  const projectRoot = await fixtureProject();
  const raw = {
    artifacts: [
      {
        id: "capability-brief",
        path: "openspec/changes/add-health-check/capability.md",
        status: "missing",
        dependencies: ["context-note"],
        metadata: { custom: true },
      },
    ],
    metadata: { schema: "custom-flow" },
    extra: { retained: true },
  };
  const runner = new FakeProcessRunner({ exitCode: 0, stdout: JSON.stringify(raw), stderr: "" });

  const result = await new CliOpenSpecGateway({ processRunner: runner }).getStatus({ projectRoot, changeName: "add-health-check" });

  assert.equal(result.status, "status-read");
  assert.deepEqual(result.context?.openspec.status?.raw, raw);
  assert.equal(result.context?.openspec.artifacts[0]?.id, "capability-brief");
  assert.equal(result.context?.openspec.artifacts[0]?.authority, "workflow");
  assert.equal(result.context?.openspec.artifacts[0]?.state, "pending");
  assert.deepEqual(result.context?.openspec.artifacts[0]?.dependencies, ["context-note"]);
  assert.deepEqual(result.context?.openspec.metadata, { schema: "custom-flow" });
  assert.deepEqual(runner.calls[0]?.args, ["status", "--change", "add-health-check", "--json"]);
});

test("instructions preserve raw structured information and merge generic artifact data", async () => {
  const projectRoot = await fixtureProject();
  const raw = {
    artifact: {
      id: "acceptance-matrix",
      path: "openspec/changes/add-health-check/acceptance.md",
      instructions: { sections: ["Behavior", "Failure"] },
      dependsOn: ["capability-brief"],
    },
    metadata: { source: "openspec" },
  };
  const runner = new FakeProcessRunner({ exitCode: 0, stdout: JSON.stringify(raw), stderr: "" });

  const result = await new CliOpenSpecGateway({ processRunner: runner }).getInstructions({ projectRoot, changeName: "add-health-check" });

  assert.equal(result.status, "instructions-read");
  assert.deepEqual(result.context?.openspec.instructions?.raw, raw);
  assert.equal(result.context?.openspec.artifacts[0]?.id, "acceptance-matrix");
  assert.equal(result.context?.openspec.artifacts[0]?.authority, "workflow");
  assert.deepEqual(result.context?.openspec.artifacts[0]?.dependencies, ["capability-brief"]);
  assert.deepEqual(runner.calls[0]?.args, ["instructions", "--change", "add-health-check", "--json"]);
});

test("compatibility artifact discoveries are separated from workflow authority", async () => {
  const projectRoot = await fixtureProject();
  const raw = {
    nested: {
      inferred: {
        id: "legacy-note",
        path: "openspec/changes/add-health-check/legacy.md",
        status: "complete",
      },
    },
  };
  const runner = new FakeProcessRunner({ exitCode: 0, stdout: JSON.stringify(raw), stderr: "" });

  const result = await new CliOpenSpecGateway({ processRunner: runner }).getStatus({ projectRoot, changeName: "add-health-check" });

  const legacy = result.context?.openspec.artifacts.find((artifact) => artifact.id === "legacy-note");
  assert.equal(legacy?.authority, "compatibility");
  assert.equal(legacy?.state, "complete");
});

test("create change uses verified openspec new change command", async () => {
  const projectRoot = await fixtureProject();
  const runner = new FakeProcessRunner({ exitCode: 0, stdout: JSON.stringify({ change: "new-change" }), stderr: "" });

  const result = await new CliOpenSpecGateway({ processRunner: runner }).createChange({
    projectRoot,
    changeName: "new-change",
    description: "Create a capability",
    goal: "Capture requirements",
    schema: "spec-driven",
  });

  assert.equal(result.status, "created");
  assert.deepEqual(runner.calls[0]?.args, [
    "new",
    "change",
    "new-change",
    "--json",
    "--description",
    "Create a capability",
    "--goal",
    "Capture requirements",
    "--schema",
    "spec-driven",
  ]);
});

test("missing change is distinct from invalid OpenSpec validation", async () => {
  const projectRoot = await fixtureProject();
  const runner = new FakeProcessRunner({ exitCode: 0, stdout: "", stderr: "" });

  const result = await new CliOpenSpecGateway({ processRunner: runner }).validate({ projectRoot, changeName: "missing-change" });

  assert.equal(result.ok, false);
  assert.equal(result.status, "missing-change");
  assert.equal(result.context, undefined);
  assert.equal(runner.calls.length, 0);
});

test("middleware deny before validation prevents CLI execution", async () => {
  const projectRoot = await fixtureProject();
  const runner = new FakeProcessRunner({ exitCode: 0, stdout: "", stderr: "" });
  const bus = new MiddlewareBus();

  bus.use("openspec.validate.before", {
    id: "deny",
    type: "policy",
    priority: 1,
    handler() {
      return { action: "deny", reason: "blocked" };
    },
  });

  const result = await new CliOpenSpecGateway({ bus, processRunner: runner }).validate({ projectRoot, changeName: "add-health-check" });

  assert.equal(result.status, "middleware-denied");
  assert.equal(result.error?.message, "blocked");
  assert.equal(runner.calls.length, 0);
});

test("path traversal change names are rejected", async () => {
  const projectRoot = await fixtureProject();
  const runner = new FakeProcessRunner({ exitCode: 0, stdout: "", stderr: "" });

  const result = await new CliOpenSpecGateway({ processRunner: runner }).validate({ projectRoot, changeName: "../../something" });

  assert.equal(result.status, "path-rejected");
  assert.equal(runner.calls.length, 0);
});

test("OpenSpec CLI unavailable is normalized", async () => {
  const projectRoot = await fixtureProject();
  const runner = new FakeProcessRunner({
    exitCode: -1,
    stdout: "",
    stderr: "",
    error: Object.assign(new Error("not found"), { code: "ENOENT" }),
  });

  const result = await new CliOpenSpecGateway({ processRunner: runner }).validate({ projectRoot, changeName: "add-health-check" });

  assert.equal(result.status, "cli-unavailable");
});

test("real OpenSpec CLI fixture validation runs when CLI is available", async (t) => {
  const availability = await new NodeProcessRunner().run("openspec", ["--version"], { cwd: process.cwd(), timeoutMs: 5_000 });
  if (availability.error?.code === "ENOENT") {
    t.skip("openspec CLI is not installed");
    return;
  }

  const projectRoot = await fixtureProject();
  const result = await new CliOpenSpecGateway().validate({ projectRoot, changeName: "add-health-check" });

  assert.equal(result.middleware.before?.result.action, "continue");
  assert.equal(typeof result.context?.openspec.validation?.exitCode, "number");
});
