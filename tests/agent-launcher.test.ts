import assert from "node:assert/strict";
import test from "node:test";
import { DefaultAgentLauncher } from "../src/index.ts";
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from "../src/index.ts";

test("detects Codex and Claude executables independently", async () => {
  const runner = new FakeRunner({ codex: success("codex-cli 0.143.0\n"), claude: success("2.1.268\n") });
  const detected = await new DefaultAgentLauncher(runner).detect();

  assert.deepEqual(
    detected.map(({ agent, available, version }) => ({ agent, available, version })),
    [
      { agent: "codex", available: true, version: "codex-cli 0.143.0" },
      { agent: "claude", available: true, version: "2.1.268" },
    ],
  );
});

test("reports when no supported agent is installed", async () => {
  const result = await new DefaultAgentLauncher(new FakeRunner()).launch({ projectRoot: "/project", idea: "idea" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, "no-agent");
});

test("explicit Codex selection launches Codex", async () => {
  const runner = new FakeRunner({ codex: success("codex 1") });
  const result = await new DefaultAgentLauncher(runner).launch({ projectRoot: "/project", agent: "codex", idea: "cache" });
  assert.equal(result.ok, true);
  assert.equal(runner.calls.at(-1)?.command, "codex");
});

test("explicit Claude selection launches Claude", async () => {
  const runner = new FakeRunner({ claude: success("claude 1") });
  const result = await new DefaultAgentLauncher(runner).launch({ projectRoot: "/project", agent: "claude", idea: "cache" });
  assert.equal(result.ok, true);
  assert.equal(runner.calls.at(-1)?.command, "claude");
});

test("explicit unavailable agent fails without substitution", async () => {
  const runner = new FakeRunner({ claude: success("claude 1") });
  const result = await new DefaultAgentLauncher(runner).launch({ projectRoot: "/project", agent: "codex", idea: "cache" });
  assert.equal(result.ok, false);
  assert.equal(runner.calls.filter((call) => call.options.stdio === "inherit").length, 0);
});

test("prefers Codex deterministically when both agents are installed", async () => {
  const runner = new FakeRunner({ codex: success("codex 1"), claude: success("claude 1") });
  await new DefaultAgentLauncher(runner).launch({ projectRoot: "/project", idea: "cache" });
  assert.equal(runner.calls.at(-1)?.command, "codex");
});

test("passes project root and hostile-looking idea as literal argument data", async () => {
  const runner = new FakeRunner({ codex: success("codex 1") });
  const payload = '$(touch /tmp/pwned); "quoted" && rm -rf /';
  await new DefaultAgentLauncher(runner).launch({
    projectRoot: "/safe/project",
    agent: "codex",
    changeName: "redis-cache",
    idea: payload,
  });

  const call = runner.calls.at(-1)!;
  assert.equal(call.options.cwd, "/safe/project");
  assert.equal(call.options.stdio, "inherit");
  assert.equal(call.args.length, 1);
  assert.match(call.args[0]!, /\$specifier/);
  assert.match(call.args[0]!, /Change: redis-cache/);
  assert.ok(call.args[0]!.includes(payload));
});

test("uses Claude's explicit slash skill invocation", async () => {
  const runner = new FakeRunner({ claude: success("claude 1") });
  await new DefaultAgentLauncher(runner).launch({ projectRoot: "/project", agent: "claude" });
  assert.match(runner.calls.at(-1)!.args[0]!, /\/specifier/);
});

test("surfaces non-zero exits and interruption exit codes", async () => {
  const failedRunner = new FakeRunner({ codex: [success("codex 1"), failure(7, "boom")] });
  const failed = await new DefaultAgentLauncher(failedRunner).launch({ projectRoot: "/project", agent: "codex" });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.status, "agent-failed");

  const interruptedRunner = new FakeRunner({ codex: [success("codex 1"), failure(130)] });
  const interrupted = await new DefaultAgentLauncher(interruptedRunner).launch({ projectRoot: "/project", agent: "codex" });
  assert.equal(interrupted.ok, false);
  if (!interrupted.ok) assert.equal(interrupted.status, "interrupted");
});

class FakeRunner implements ProcessRunner {
  readonly calls: Array<{ command: string; args: string[]; options: ProcessRunOptions }> = [];
  private readonly responses: Record<string, ProcessResult[]>;

  constructor(responses: Record<string, ProcessResult | ProcessResult[]> = {}) {
    this.responses = Object.fromEntries(
      Object.entries(responses).map(([command, response]) => [command, Array.isArray(response) ? [...response] : [response, success()]]),
    );
  }

  async run(command: string, args: string[], options: ProcessRunOptions): Promise<ProcessResult> {
    this.calls.push({ command, args, options });
    return this.responses[command]?.shift() ?? { exitCode: -1, stdout: "", stderr: "", error: { code: "ENOENT" } };
  }
}

function success(stdout = ""): ProcessResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failure(exitCode: number, stderr = ""): ProcessResult {
  return { exitCode, stdout: "", stderr };
}
