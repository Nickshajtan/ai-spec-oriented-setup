import path from "node:path";
import type { ModelPort, ModelRequest, ModelResponse } from "../../src/model/types.ts";

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
      "REST responses need deterministic cache behavior without changing failure semantics.",
      "",
      "## What Changes",
      "",
      `- ${mode} proposal content for cached REST responses.`,
      "- Cache eligible REST responses.",
      "- Fall back to the uncached database path when the cache is unavailable.",
      "",
      "## Capabilities",
      "",
      "### New Capabilities",
      "- `redis-rest-cache`: REST response caching behavior.",
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
  if (artifactId === "specs") {
    return JSON.stringify({
      path: concreteSpecPath(payload),
      content: [
        "## Purpose",
        "",
        "Defines how eligible REST responses are cached while preserving existing fallback behavior when caching is unavailable.",
        "",
        "## ADDED Requirements",
        "",
        "### Requirement: Cached REST responses",
        "The system SHALL cache eligible REST responses and preserve the current uncached database behavior when the cache cannot be used.",
        "",
        "#### Scenario: Redis unavailable",
        "- **WHEN** Redis is unavailable",
        "- **THEN** the system falls back to the current uncached database path",
        "",
        "#### Scenario: Eligible response cached",
        "- **WHEN** an eligible REST response is requested repeatedly",
        "- **THEN** the system returns the cached response according to the cache policy",
        "",
        mode === "Revised" ? "Reviewed update." : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  if (artifactId === "tasks") {
    return [
      "## 1. Runtime E2E",
      "",
      "- [ ] 1.1 Implement cached REST response behavior and verify runtime E2E generated artifacts remain valid",
      mode === "Revised" ? "- [ ] 1.2 Apply reviewer update and verify OpenSpec validation passes" : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (artifactId === "design") {
    return [
      "## Context",
      "",
      "See proposal.md for motivation. The cache must be optional at runtime.",
      "",
      "## Goals / Non-Goals",
      "",
      "**Goals:** Preserve fallback behavior when Redis is unavailable.",
      "",
      "**Non-Goals:** Change database semantics.",
      "",
      "## Decisions",
      "",
      `${mode} design keeps cache reads behind the existing REST response path with database fallback.`,
      "",
      "## Risks / Trade-offs",
      "",
      "Cache outage -> fall back to the uncached database path.",
      "",
      mode === "Revised" ? "Reviewed update." : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [`# ${artifactId}`, "", `${mode} content for ${artifactId}.`, mode === "Revised" ? "Reviewed update." : ""]
    .filter(Boolean)
    .join("\n");
}

function concreteSpecPath(payload: Record<string, any>): string {
  const artifactPath = stringValue(payload.artifact?.path) ?? "openspec/changes/redis-rest-cache/specs/**/*.md";
  const normalized = artifactPath.replace(/\\/g, "/");
  const prefix = normalized.split("/specs/")[0] ?? "openspec/changes/redis-rest-cache";
  return path.posix.join(prefix, "specs", "redis-rest-cache", "spec.md");
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
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
