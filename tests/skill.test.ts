import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const canonicalPath = new URL("../skills/specifier/SKILL.md", import.meta.url);
const codexPath = new URL("../.agents/skills/specifier/SKILL.md", import.meta.url);
const claudePath = new URL("../.claude/skills/specifier/SKILL.md", import.meta.url);

test("agent skill representations exactly match the canonical source", async () => {
  const [canonical, codex, claude] = await Promise.all([
    readFile(canonicalPath, "utf8"),
    readFile(codexPath, "utf8"),
    readFile(claudePath, "utf8"),
  ]);
  assert.equal(codex, canonical);
  assert.equal(claude, canonical);
});

test("skill has portable metadata and delegates all lifecycle authority to Core", async () => {
  const skill = await readFile(canonicalPath, "utf8");
  assert.match(skill, /^---\nname: specifier\ndescription: .+\n---\n/);
  assert.match(skill, /SpecificationWorkflow/);
  assert.match(skill, /SpecificationWorkflow\.answer/);
  assert.match(skill, /Never decide readiness/);
  assert.match(skill, /Do not replace or modify existing `opsx:\*`/);
  assert.doesNotMatch(skill, /proposal\.md|design\.md|tasks\.md/);
});
