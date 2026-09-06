import type { MiddlewareExecution } from "../types.ts";

export interface SpecInspectInput {
  projectRoot: string;
  changeName: string;
}

export interface ArtifactRef {
  kind: "proposal" | "design" | "tasks" | "spec" | "metadata";
  path: string;
  absolutePath: string;
}

export interface SpecContext {
  system: "openspec";
  changeName: string;
  projectRoot: string;
  metadata?: {
    schema?: string;
    created?: string;
    goal?: string;
    affectedAreas?: string[];
    skipSpecs?: boolean;
  };
  artifacts: {
    proposal?: ArtifactRef;
    design?: ArtifactRef;
    tasks?: ArtifactRef;
    metadata?: ArtifactRef;
    specs: ArtifactRef[];
  };
  validation: {
    valid: boolean;
    exitCode: number;
    findings?: unknown[];
    stdout: string;
    stderr: string;
  };
  taskProgress?: {
    completed: number;
    total: number;
  };
}

export type SpecInspectionStatus =
  | "valid"
  | "invalid"
  | "missing-change"
  | "project-not-initialized"
  | "cli-unavailable"
  | "command-failed"
  | "middleware-denied"
  | "requires-human"
  | "path-rejected";

export interface SpecInspectionError {
  code: SpecInspectionStatus;
  message: string;
  cause?: unknown;
}

export interface SpecInspectionResult {
  ok: boolean;
  status: SpecInspectionStatus;
  context?: SpecContext;
  error?: SpecInspectionError;
  middleware: {
    before?: MiddlewareExecution;
    after?: MiddlewareExecution;
  };
}

export interface SpecAdapter {
  inspect(input: SpecInspectInput): Promise<SpecInspectionResult>;
}
