import type { ModelPort, ModelRequest, ModelResponse } from "../model/types.ts";

export class DeterministicRuntimeModel implements ModelPort {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.purpose === "interview") return response(interviewPlan(request));
    if (request.purpose === "spec-review") return response(review(request));
    return response(artifact(request));
  }
}

function interviewPlan(request: ModelRequest): string {
  const payload = parsePayload(request);
  const facts = Array.isArray(payload.session?.facts) ? payload.session.facts : [];
  const hasAnswer = facts.some((fact) => isObject(fact) && typeof fact.label === "string" && fact.label.startsWith("answer:"));
  if (!hasAnswer) {
    return JSON.stringify({
      missingMaterialInfo: true,
      nextQuestion: {
        text: "What should happen when the new capability is unavailable?",
        why: "Failure behavior is a material implementation decision.",
        gapId: "availability-fallback",
      },
      readiness: {
        ready: false,
        reason: "Fallback behavior is required before artifact generation.",
        blockingGaps: ["availability-fallback"],
        unresolvedContradictions: [],
      },
    });
  }

  return JSON.stringify({
    missingMaterialInfo: false,
    readiness: {
      ready: true,
      reason: "The deterministic test model has enough information.",
      blockingGaps: [],
      unresolvedContradictions: [],
    },
  });
}

function artifact(request: ModelRequest): string {
  const payload = parsePayload(request);
  const mode = payload.mode === "revise" ? "Revised" : "Generated";
  const artifactId = stringValue(payload.artifact?.id) ?? "artifact";
  if (artifactId === "proposal") {
    return [
      "## Why",
      "",
      "Capture a deterministic feature specification through the runtime bridge.",
      "",
      "## What Changes",
      "",
      `- ${mode} proposal content for the requested capability.`,
      "- Include the user's fallback behavior answer.",
      "",
      "## Capabilities",
      "",
      "### New Capabilities",
      "",
      "### Modified Capabilities",
      "",
      "## Impact",
      "",
      "- Runtime E2E only.",
      mode === "Revised" ? "Reviewed update." : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (artifactId === "tasks") {
    return ["## Tasks", "", "- [ ] Implement the specified behavior.", mode === "Revised" ? "- [ ] Apply reviewer update." : ""]
      .filter(Boolean)
      .join("\n");
  }
  if (artifactId === "design") {
    return ["## Design", "", `${mode} design for the requested capability.`, mode === "Revised" ? "Reviewed update." : ""]
      .filter(Boolean)
      .join("\n");
  }
  return [`# ${artifactId}`, "", `${mode} content for ${artifactId}.`, mode === "Revised" ? "Reviewed update." : ""]
    .filter(Boolean)
    .join("\n");
}

function review(request: ModelRequest): string {
  const payload = parsePayload(request);
  const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
  const firstArtifact = artifacts.find(isObject);
  const hasReviewedUpdate = artifacts.some((item) => isObject(item) && stringValue(item.content)?.includes("Reviewed update."));
  if (!hasReviewedUpdate && firstArtifact) {
    return JSON.stringify({
      verdict: "needs_revision",
      findings: [
        {
          id: "deterministic-review",
          severity: "error",
          artifactId: stringValue(firstArtifact.artifactId),
          issue: "Exercise revision loop.",
          reason: "The deterministic runtime E2E requires one safe artifact revision.",
        },
      ],
    });
  }
  return JSON.stringify({ verdict: "pass", findings: [], summary: "Deterministic review passed." });
}

function parsePayload(request: ModelRequest): Record<string, any> {
  const message = request.messages.findLast((item) => item.role === "user");
  if (!message) return {};
  try {
    const parsed = JSON.parse(message.content);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function response(content: string): ModelResponse {
  return { content, model: "deterministic-runtime-model" };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
