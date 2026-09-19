import type { ModelPort } from "../model/types.ts";
import type { GenerateArtifactInput, GeneratedArtifact, ModelArtifactGeneratorConfig } from "./types.ts";

export class ModelArtifactGenerator {
  private readonly model: ModelPort;
  private readonly config: ModelArtifactGeneratorConfig;

  constructor(model: ModelPort, config: ModelArtifactGeneratorConfig) {
    this.model = model;
    this.config = config;
  }

  async generate(input: GenerateArtifactInput): Promise<GeneratedArtifact> {
    const response = await this.model.complete({
      model: this.config.model,
      purpose: "artifact-generation",
      parameters: this.config.parameters,
      metadata: {
        mode: input.mode,
        artifactId: input.artifact.id,
        changeName: input.interview.changeName,
      },
      messages: [
        {
          role: "system",
          content: [
            "You generate one OpenSpec artifact.",
            "OpenSpec instructions, dependencies, paths, and validation expectations are authoritative.",
            "Use user facts as requirements. Treat accepted assumptions as assumptions, not user facts.",
            "Do not invent missing product decisions. Output only the complete artifact content.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify({
            mode: input.mode,
            artifact: input.artifact,
            instructions: input.instructions,
            roughIdea: input.interview.roughIdea,
            facts: input.interview.facts.filter((fact) => fact.supersededBy === undefined),
            acceptedAssumptions: input.interview.assumptions.filter((assumption) => assumption.status === "accepted"),
            choices: input.interview.choices,
            resolvedContradictions: input.interview.contradictions.filter((contradiction) => contradiction.status === "resolved"),
            dependencies: input.dependencies,
            currentContent: input.currentContent,
            findings: input.findings,
          }),
        },
      ],
    });

    return { artifactId: input.artifact.id, content: response.content.trim() };
  }
}
