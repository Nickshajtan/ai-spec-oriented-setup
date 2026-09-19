import type { MiddlewareExecution } from "../middleware/types.ts";

export interface WriteArtifactInput {
  projectRoot: string;
  path: string;
  content: string;
  overwrite?: boolean;
}

export type WriteArtifactStatus = "written" | "conflict" | "path-rejected" | "middleware-denied" | "requires-human";

export interface WriteArtifactResult {
  ok: boolean;
  status: WriteArtifactStatus;
  path?: string;
  absolutePath?: string;
  bytesWritten?: number;
  error?: {
    code: WriteArtifactStatus;
    message: string;
  };
  middleware: {
    before?: MiddlewareExecution;
    after?: MiddlewareExecution;
  };
}

export interface ArtifactWriter {
  write(input: WriteArtifactInput): Promise<WriteArtifactResult>;
}

export interface ReadArtifactInput {
  projectRoot: string;
  path: string;
}

export type ReadArtifactStatus = "read" | "not-found" | "path-rejected" | "read-failed";

export interface ReadArtifactResult {
  ok: boolean;
  status: ReadArtifactStatus;
  path?: string;
  absolutePath?: string;
  content?: string;
  error?: {
    code: ReadArtifactStatus;
    message: string;
  };
}

export interface ArtifactReader {
  read(input: ReadArtifactInput): Promise<ReadArtifactResult>;
}
