import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseCliArguments } from "../src/cli/arguments.ts";
import { runCli, type CliIo } from "../src/cli/run-cli.ts";
import type { AgentLauncher, LaunchAgentInput, LaunchAgentResult } from "../src/index.ts";

test("parses the intentionally small CLI surface", () => {
  const expectedProjectPath = path.resolve("/work", "app");
  assert.deepEqual(parseCliArguments(["--agent", "codex", "--change", "cache", "--project", "./app", "rough", "idea"], "/work"), {
    agent: "codex",
    changeName: "cache",
    projectPath: expectedProjectPath,
    idea: "rough idea",
    help: false,
    version: false,
  });
});

test("help and version do not launch an agent", async () => {
  const launcher = new RecordingLauncher();
  assert.equal(await runCli(["--help"], { launcher, io: quietIo }), 0);
  assert.equal(await runCli(["--version"], { launcher, io: quietIo, version: "9.9.9" }), 0);
  assert.equal(launcher.inputs.length, 0);
});

test("resolves and validates project root before launch", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-spec-cli-"));
  const launcher = new RecordingLauncher();
  try {
    assert.equal(await runCli(["--project", directory, "idea"], { launcher, io: quietIo }), 0);
    assert.equal(launcher.inputs[0]?.projectRoot, await realpath(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects missing projects and invalid options without launching", async () => {
  const launcher = new RecordingLauncher();
  assert.equal(await runCli(["--project", "/definitely/missing/ai-spec", "idea"], { launcher, io: quietIo }), 2);
  assert.equal(await runCli(["--agent", "other", "idea"], { launcher, io: quietIo }), 2);
  assert.equal(launcher.inputs.length, 0);
});

class RecordingLauncher implements AgentLauncher {
  readonly inputs: LaunchAgentInput[] = [];
  async detect() {
    return [];
  }
  async launch(input: LaunchAgentInput): Promise<LaunchAgentResult> {
    this.inputs.push(input);
    return { ok: true, agent: input.agent ?? "codex", exitCode: 0 };
  }
}

const quietIo: CliIo = { stdout() {}, stderr() {} };
