import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { NodeProcessRunner } from "../src/index.ts";

test("ai-spec-core start and answer cross process and persisted-session boundaries", async (t) => {
  const availability = await new NodeProcessRunner().run("openspec", ["--version"], { cwd: process.cwd(), timeoutMs: 5_000 });
  if (availability.error?.code === "ENOENT") {
    t.skip("openspec CLI is not installed");
    return;
  }

  const projectRoot = await mkdtemp(path.join(process.cwd(), ".runtime-e2e-"));
  try {
    await mkdir(path.join(projectRoot, "openspec"), { recursive: true });

    const start = await runCore("start", {
      projectRoot,
      changeName: "redis-rest-cache",
      roughIdea: "Add Redis caching to REST responses.",
      schema: "spec-driven",
    });

    assert.equal(start.exitCode, 0, start.stderr);
    assert.equal(start.json.status, "needs-input");
    assert.match(start.json.question.text, /unavailable/i);
    assert.equal(typeof start.json.sessionId, "string");

    const answer = await runCore("answer", {
      projectRoot,
      sessionId: start.json.sessionId,
      answer: "Fall back to the current uncached database path.",
    });

    assert.equal(answer.exitCode, 0, answer.stderr || answer.stdout);
    assert.equal(answer.json.status, "ready");
    assert.equal(answer.json.validation.valid, true);
    assert.equal(answer.json.review.verdict, "pass");
    assert.ok(answer.json.artifacts.length > 0);

    const changePath = path.join(projectRoot, "openspec", "changes", "redis-rest-cache");
    const proposal = await readFile(path.join(changePath, "proposal.md"), "utf8");
    const spec = await readFile(path.join(changePath, "specs", "redis-rest-cache", "spec.md"), "utf8");
    const design = await readFile(path.join(changePath, "design.md"), "utf8");
    const tasks = await readFile(path.join(changePath, "tasks.md"), "utf8");
    assert.match(proposal, /Reviewed update/);
    assert.match(spec, /Redis unavailable/);
    assert.match(design, /fallback/i);
    assert.match(tasks, /- \[ \] 1\.1/);
    assert.deepEqual(answer.json.artifacts.map((artifact: { artifactId: string }) => artifact.artifactId).sort(), [
      "design",
      "proposal",
      "specs",
      "tasks",
    ]);

    const status = await runCore("status", { projectRoot, sessionId: start.json.sessionId });
    assert.equal(status.exitCode, 0, status.stderr);
    assert.equal(status.json.status, "ready");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

function runCore(command: string, input: unknown): Promise<{ exitCode: number; stdout: string; stderr: string; json: any }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "tests/support/runtime-test-cli.ts", command], {
      cwd: process.cwd(),
      env: { ...process.env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.end(JSON.stringify(input));
    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr, json: stdout.trim() ? JSON.parse(stdout) : undefined });
    });
  });
}
