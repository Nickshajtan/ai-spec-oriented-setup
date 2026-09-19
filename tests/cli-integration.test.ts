import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

test("ai-spec detects a fake Codex executable and passes one literal Specifier instruction", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-spec-e2e-"));
  const executable = path.join(directory, "codex");
  const capture = path.join(directory, "args.json");
  const payload = '$(touch nope); "quotes" && echo unsafe';
  try {
    await writeFile(
      executable,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv[2] === "--version") { console.log("codex-fake 1.0"); process.exit(0); }
writeFileSync(process.env.AI_SPEC_CAPTURE, JSON.stringify(process.argv.slice(2)));
`,
      "utf8",
    );
    await chmod(executable, 0o755);

    const result = await run(process.execPath, ["bin/ai-spec.js", "--agent", "codex", "--project", directory, payload], {
      ...process.env,
      PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
      AI_SPEC_CAPTURE: capture,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const args = JSON.parse(await readFile(capture, "utf8")) as string[];
    assert.equal(args.length, 1);
    assert.match(args[0]!, /\$specifier/);
    assert.ok(args[0]!.includes(payload));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: process.cwd(), env, shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stderr }));
  });
}
