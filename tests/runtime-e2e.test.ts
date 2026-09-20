import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

    const changePath = path.join(projectRoot, "openspec", "changes", "redis-rest-cache");
    await mkdir(changePath, { recursive: true });
    const metadataPath = path.join(changePath, ".openspec.yaml");
    const metadata = await readFile(metadataPath, "utf8").catch(() => "name: redis-rest-cache\n");
    await writeFile(metadataPath, `${metadata.trimEnd()}\n`, "utf8");
    const specPath = path.join(changePath, "specs", "redis-rest-cache", "spec.md");
    await mkdir(path.dirname(specPath), { recursive: true });
    await writeFile(
      specPath,
      [
        "# Redis REST Cache Spec",
        "",
        "## ADDED Requirements",
        "",
        "### Requirement: Cached REST responses",
        "",
        "The system SHALL cache eligible REST responses.",
        "",
        "#### Scenario: Redis unavailable",
        "",
        "- **WHEN** Redis is unavailable",
        "- **THEN** the system falls back to the uncached database path",
      ].join("\n"),
      "utf8",
    );

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

    const status = await runCore("status", { projectRoot, sessionId: start.json.sessionId });
    assert.equal(status.exitCode, 0, status.stderr);
    assert.equal(status.json.status, "ready");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

function runCore(command: string, input: unknown): Promise<{ exitCode: number; stdout: string; stderr: string; json: any }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["bin/ai-spec-core.js", command], {
      cwd: process.cwd(),
      env: { ...process.env, AI_SPEC_RUNTIME_TEST_MODEL: "1" },
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
