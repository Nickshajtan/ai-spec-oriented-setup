import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactReader, ReadArtifactInput, ReadArtifactResult } from "./types.ts";

export class NodeArtifactReader implements ArtifactReader {
  async read(input: ReadArtifactInput): Promise<ReadArtifactResult> {
    const resolved = resolveArtifactPath(input);
    if (!resolved.ok) return failure("path-rejected", resolved.message);

    if (!(await exists(resolved.absolutePath))) {
      return failure("not-found", `Artifact not found: ${input.path}`);
    }

    try {
      return {
        ok: true,
        status: "read",
        path: normalizePath(input.path),
        absolutePath: resolved.absolutePath,
        content: await readFile(resolved.absolutePath, "utf8"),
      };
    } catch (error) {
      return failure("read-failed", error instanceof Error ? error.message : "Artifact read failed.");
    }
  }
}

type ResolvedPath = { ok: true; absolutePath: string } | { ok: false; message: string };

function resolveArtifactPath(input: ReadArtifactInput): ResolvedPath {
  if (!input.projectRoot || !input.path) return { ok: false, message: "projectRoot and path are required" };
  if (path.isAbsolute(input.path) || input.path.includes("\0")) return { ok: false, message: `Unsafe artifact path: ${input.path}` };

  const projectRoot = path.resolve(input.projectRoot);
  const absolutePath = path.resolve(projectRoot, input.path);
  if (!isWithin(projectRoot, absolutePath)) return { ok: false, message: `Artifact path escapes project root: ${input.path}` };

  return { ok: true, absolutePath };
}

function failure(status: ReadArtifactResult["status"], message: string): ReadArtifactResult {
  return { ok: false, status, error: { code: status, message } };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}
