import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const roots = ["src", "tests"];
const files = roots.flatMap((root) => collectTsFiles(path.resolve(root)));

let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--check", file], {
    encoding: "utf8",
    stdio: "pipe",
  });

  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr);
    process.stderr.write(result.stdout);
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} TypeScript files.`);
}

function collectTsFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(absolutePath));
      continue;
    }

    if (entry.isFile() && absolutePath.endsWith(".ts") && statSync(absolutePath).size > 0) {
      files.push(absolutePath);
    }
  }

  return files;
}
