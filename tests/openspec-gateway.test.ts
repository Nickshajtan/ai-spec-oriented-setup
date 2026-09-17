import assert from "node:assert/strict";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CliOpenSpecGateway, MiddlewareBus, NodeProcessRunner } from "../src/index.ts";
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
  const projectRoot = await mkdtemp(path.join(tmpdir(), "openspec-gateway-"));
  await cp(path.resolve("tests", "fixtures", "openspec-project"), projectRoot, { recursive: true });
  return projectRoot;
}

test("valid change is validated through official CLI and emits OpenSpec events", async () => {
  const projectRoot = await fixtureProject();
  const runner = new FakeProcessRunner({ exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: "" });
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
  assert.equal(result.context?.system, "openspec");
  assert.equal(result.context?.openspec.metadata?.known?.schema, "1.0.0");
  assert.match(result.context?.openspec.metadata?.raw ?? "", /goal:/);
  assert.equal(result.context?.openspec.artifacts.proposal?.path, "openspec/changes/add-health-check/proposal.md");
  assert.deepEqual(
    result.context?.openspec.artifacts.specs.map((artifact) => artifact.path),
    ["openspec/changes/add-health-check/specs/health-check/spec.md"],
  );
  assert.deepEqual(result.context?.openspec.validation?.output, { ok: true });
  assert.deepEqual(events, ["openspec.validate.before", "openspec.validate.after"]);
  assert.deepEqual(runner.calls[0]?.args, ["validate", "add-health-check", "--json", "--no-interactive"]);
});

test("invalid change preserves CLI validation output", async () => {
  const projectRoot = await fixtureProject();
  const runner = new FakeProcessRunner({
    exitCode: 1,
    stdout: JSON.stringify({ errors: [{ message: "invalid change" }] }),
    stderr: "invalid change",
  });

  const result = await new CliOpenSpecGateway({ processRunner: runner }).validate({ projectRoot, changeName: "add-health-check" });

  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid");
  assert.equal(result.context?.openspec.validation?.valid, false);
  assert.deepEqual(result.context?.openspec.validation?.output, { errors: [{ message: "invalid change" }] });
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

test("status and instructions preserve machine-readable CLI output", async () => {
  const projectRoot = await fixtureProject();
  const runner = new FakeProcessRunner({ exitCode: 0, stdout: JSON.stringify({ artifactGraph: ["proposal", "tasks"] }), stderr: "" });
  const gateway = new CliOpenSpecGateway({ processRunner: runner });

  const status = await gateway.getStatus({ projectRoot, changeName: "add-health-check" });
  const instructions = await gateway.getInstructions({ projectRoot, changeName: "add-health-check" });

  assert.equal(status.status, "status-read");
  assert.deepEqual(status.context?.openspec.status, { artifactGraph: ["proposal", "tasks"] });
  assert.equal(instructions.status, "instructions-read");
  assert.deepEqual(instructions.context?.openspec.instructions, { artifactGraph: ["proposal", "tasks"] });
});

test("path traversal change names are rejected", async () => {
  const projectRoot = await fixtureProject();
  const runner = new FakeProcessRunner({ exitCode: 0, stdout: "", stderr: "" });

  const result = await new CliOpenSpecGateway({ processRunner: runner }).validate({ projectRoot, changeName: "../../something" });

  assert.equal(result.status, "path-rejected");
  assert.equal(runner.calls.length, 0);
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
