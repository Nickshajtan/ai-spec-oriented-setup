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
