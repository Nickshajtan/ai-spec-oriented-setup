import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MiddlewareBus, NodeArtifactWriter } from "../src/index.ts";
import type { ArtifactWriterFileSystem } from "../src/index.ts";

async function projectRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "artifact-writer-"));
}

test("writes UTF-8 artifact and creates parent directories", async () => {
  const root = await projectRoot();
  const result = await new NodeArtifactWriter().write({
    projectRoot: root,
    path: "openspec/changes/example/custom.md",
    content: "Hello, Привіт",
  });

  assert.equal(result.status, "written");
  assert.equal(await readFile(path.join(root, "openspec", "changes", "example", "custom.md"), "utf8"), "Hello, Привіт");
});

test("rejects path traversal", async () => {
  const root = await projectRoot();
  const result = await new NodeArtifactWriter().write({ projectRoot: root, path: "../escape.md", content: "bad" });

  assert.equal(result.status, "path-rejected");
});

test("does not overwrite by default and overwrites only when explicit", async () => {
  const root = await projectRoot();
  const writer = new NodeArtifactWriter();

  assert.equal((await writer.write({ projectRoot: root, path: "artifact.md", content: "one" })).status, "written");
  assert.equal((await writer.write({ projectRoot: root, path: "artifact.md", content: "two" })).status, "conflict");
  assert.equal((await writer.write({ projectRoot: root, path: "artifact.md", content: "two", overwrite: true })).status, "written");
  assert.equal(await readFile(path.join(root, "artifact.md"), "utf8"), "two");
});

test("failed overwrite replacement preserves existing artifact and cleans temp file", async () => {
  const root = await projectRoot();
  const artifactPath = path.join(root, "artifact.md");
  await writeFile(artifactPath, "stable", "utf8");
  const writer = new NodeArtifactWriter({ fileSystem: failingRenameFileSystem() });

  await assert.rejects(
    writer.write({
      projectRoot: root,
      path: "artifact.md",
      content: "replacement",
      overwrite: true,
    }),
    /rename failed/,
  );

  assert.equal(await readFile(artifactPath, "utf8"), "stable");
  const files = await readdir(root);
  assert.deepEqual(files, ["artifact.md"]);
});

test("emits before and after middleware events", async () => {
  const root = await projectRoot();
  const bus = new MiddlewareBus();
  const events: string[] = [];

  bus.use("artifact.write.before", {
    id: "before",
    type: "observer",
    priority: 1,
    handler(context) {
      events.push(context.event.name);
    },
  });
  bus.use("artifact.write.after", {
    id: "after",
    type: "observer",
    priority: 1,
    handler(context) {
      events.push(context.event.name);
      assert.equal(context.metadata.path, "artifact.md");
    },
  });

  await new NodeArtifactWriter({ bus }).write({ projectRoot: root, path: "artifact.md", content: "text" });

  assert.deepEqual(events, ["artifact.write.before", "artifact.write.after"]);
});

test("middleware deny and require-human prevent writes", async () => {
  const denyRoot = await projectRoot();
  const denyBus = new MiddlewareBus();
  denyBus.use("artifact.write.before", {
    id: "deny",
    type: "policy",
    priority: 1,
    handler() {
      return { action: "deny", reason: "blocked" };
    },
  });

  assert.equal(
    (await new NodeArtifactWriter({ bus: denyBus }).write({ projectRoot: denyRoot, path: "artifact.md", content: "text" })).status,
    "middleware-denied",
  );

  const humanRoot = await projectRoot();
  const humanBus = new MiddlewareBus();
  humanBus.use("artifact.write.before", {
    id: "human",
    type: "policy",
    priority: 1,
    handler() {
      return { action: "require-human", reason: "approve write" };
    },
  });

  assert.equal(
    (await new NodeArtifactWriter({ bus: humanBus }).write({ projectRoot: humanRoot, path: "artifact.md", content: "text" })).status,
    "requires-human",
  );
});

function failingRenameFileSystem(): ArtifactWriterFileSystem {
  return {
    access,
    mkdir,
    async rename() {
      throw new Error("rename failed");
    },
    rm,
    writeFile,
  };
}
