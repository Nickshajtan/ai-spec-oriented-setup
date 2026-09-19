import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const thresholds = {
  lines: 80,
  branches: 73,
  functions: 80,
};

const testFiles = readdirSync(path.join(process.cwd(), "tests"))
  .filter((file) => file.endsWith(".test.ts"))
  .map((file) => path.join("tests", file));

const result = spawnSync(process.execPath, ["--test", "--experimental-strip-types", "--experimental-test-coverage", ...testFiles], {
  cwd: process.cwd(),
  encoding: "utf8",
});

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(output);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const match = /all files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)/.exec(output);
if (!match) {
  console.error("Could not parse Node test coverage summary.");
  process.exit(1);
}

const actual = {
  lines: Number(match[1]),
  branches: Number(match[2]),
  functions: Number(match[3]),
};

const failures = Object.entries(thresholds).filter(([key, threshold]) => actual[key] < threshold);
if (failures.length > 0) {
  for (const [key, threshold] of failures) {
    console.error(`Coverage threshold failed for ${key}: ${actual[key].toFixed(2)}% < ${threshold}%`);
  }
  process.exit(1);
}

console.log(
  `Coverage thresholds passed: lines ${actual.lines.toFixed(2)}%, branches ${actual.branches.toFixed(
    2,
  )}%, functions ${actual.functions.toFixed(2)}%.`,
);
