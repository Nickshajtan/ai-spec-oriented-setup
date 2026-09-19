import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "skills", "specifier", "SKILL.md");
const targets = [
  path.join(root, ".agents", "skills", "specifier", "SKILL.md"),
  path.join(root, ".claude", "skills", "specifier", "SKILL.md"),
];
const expected = await readFile(source, "utf8");

if (process.argv.includes("--write")) {
  for (const target of targets) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, expected, "utf8");
  }
  console.log("Agent skill representations synchronized.");
} else if (process.argv.includes("--check")) {
  for (const target of targets) {
    const actual = await readFile(target, "utf8").catch(() => undefined);
    if (actual !== expected) {
      console.error(`${path.relative(root, target)} is not synchronized with skills/specifier/SKILL.md.`);
      process.exitCode = 1;
    }
  }
  if (!process.exitCode) console.log("Agent skill representations are synchronized.");
} else {
  console.error("Usage: node scripts/sync-agent-skills.mjs --write|--check");
  process.exitCode = 2;
}
