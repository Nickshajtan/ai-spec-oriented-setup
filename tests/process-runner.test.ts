import assert from "node:assert/strict";
import test from "node:test";
import { NodeProcessRunner } from "../src/index.ts";

test("preserves a child termination signal", { skip: process.platform === "win32" }, async () => {
  const result = await new NodeProcessRunner().run(process.execPath, ["-e", 'process.kill(process.pid, "SIGTERM")'], {
    cwd: process.cwd(),
  });

  assert.equal(result.exitCode, -1);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.timedOut, false);
});

test("distinguishes timeout termination from user interruption", async () => {
  const result = await new NodeProcessRunner().run(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
    cwd: process.cwd(),
    timeoutMs: 20,
  });

  assert.equal(result.exitCode, -1);
  assert.equal(result.timedOut, true);
  if (process.platform !== "win32") assert.equal(result.signal, "SIGTERM");
});
