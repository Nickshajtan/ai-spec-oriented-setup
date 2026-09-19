import { parseModelJson } from "../model/structured-output.ts";
import type { ModelPort } from "../model/types.ts";
import type { ModelSpecReviewerConfig, ReviewFinding, ReviewVerdict, SpecReview, SpecReviewInput } from "./types.ts";

export class ModelSpecReviewer {
  private readonly model: ModelPort;
  private readonly config: ModelSpecReviewerConfig;

  constructor(model: ModelPort, config: ModelSpecReviewerConfig) {
    this.model = model;
    this.config = config;
  }

  async review(input: SpecReviewInput): Promise<SpecReview> {
    const response = await this.model.complete({
      model: this.config.model,
      purpose: "spec-review",
      parameters: this.config.parameters,
      metadata: {
        changeName: input.changeName,
        artifactCount: input.artifacts.length,
      },
      messages: [
        {
          role: "system",
          content: [
            "You independently review a generated OpenSpec change in a fresh context.",
            "Return JSON only with verdict, findings, and optional summary.",
            "Use verdict pass only when validation is valid and artifacts are implementation-ready.",
            "Use needs_revision when known information is represented badly and no human product decision is needed.",
            "Use needs_input only for material product decisions that cannot safely be derived.",
            "Do not invent speculative requirements.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify({
            projectRoot: input.projectRoot,
            changeName: input.changeName,
            validation: input.validation,
            status: input.status,
            instructions: input.instructions,
            artifacts: input.artifacts,
            roughIdea: input.interview.roughIdea,
            facts: input.interview.facts.filter((fact) => fact.supersededBy === undefined),
            acceptedAssumptions: input.interview.assumptions.filter((assumption) => assumption.status === "accepted"),
            choices: input.interview.choices,
            unresolvedContradictions: input.interview.contradictions.filter((contradiction) => contradiction.status === "unresolved"),
          }),
        },
      ],
    });

    return normalizeReview(parseModelJson(response.content));
  }
}

function normalizeReview(value: Record<string, unknown>): SpecReview {
  const verdict = normalizeVerdict(value.verdict);
  const findings = Array.isArray(value.findings) ? value.findings.map(normalizeFinding) : [];
  const summary = typeof value.summary === "string" ? value.summary : undefined;
  return { verdict, findings, ...(summary ? { summary } : {}) };
}

function normalizeVerdict(value: unknown): ReviewVerdict {
  if (value === "pass" || value === "needs_revision" || value === "needs_input") return value;
  throw new Error("Model review JSON must include verdict pass, needs_revision, or needs_input.");
}

function normalizeFinding(value: unknown, index: number): ReviewFinding {
  const item = isObject(value) ? value : {};
  const severity = item.severity === "warning" ? "warning" : "error";
  return {
    id: stringValue(item.id) ?? `finding-${index + 1}`,
    severity,
    artifactId: stringValue(item.artifactId),
    issue: stringValue(item.issue) ?? "Review finding",
    reason: stringValue(item.reason) ?? "The reviewer reported an issue.",
    category: normalizeCategory(item.category),
    suggestedQuestion: stringValue(item.suggestedQuestion),
  };
}

function normalizeCategory(value: unknown): ReviewFinding["category"] {
  if (
    value === "missing-requirement" ||
    value === "contradiction" ||
    value === "ambiguity" ||
    value === "openspec-compliance" ||
    value === "implementation-readiness" ||
    value === "consistency"
  ) {
    return value;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
