import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliOpenSpecGateway, NodeArtifactWriter } from "../src/index.ts";

const expectedVersion = process.env.OPENSPEC_VERSION ?? "1.12.0";
const projectRoot = await mkdtemp(path.join(process.cwd(), ".openspec-smoke-"));

try {
  await mkdir(path.join(projectRoot, "openspec"), { recursive: true });

  const gateway = new CliOpenSpecGateway();
  const writer = new NodeArtifactWriter();
  const version = await commandVersion();
  if (version !== expectedVersion) {
    throw new Error(`Expected OpenSpec ${expectedVersion}, got ${version}.`);
  }

  const changeName = "smoke";
  const created = await gateway.createChange({
    projectRoot,
    changeName,
    description: "OpenSpec smoke test",
    goal: "Verify machine-readable OpenSpec CLI contract",
    schema: "spec-driven",
  });
  assertOk(created.ok, "createChange failed");

  const initialStatus = await gateway.getStatus({ projectRoot, changeName });
  assertOk(initialStatus.ok, "getStatus failed");
  const proposal = initialStatus.context?.openspec.artifacts.find((artifact) => artifact.id === "proposal");
  assertOk(Boolean(proposal), "status did not include proposal artifact");
  assertOk(proposal?.authority === "workflow", "proposal artifact was not workflow-authoritative");
  assertOk(proposal?.state === "ready", `expected proposal to be ready, got ${proposal?.state}`);

  const metadataPath = path.join(projectRoot, "openspec", "changes", changeName, ".openspec.yaml");
  const metadata = await readFile(metadataPath, "utf8");
  await writeFile(metadataPath, `${metadata.trimEnd()}\nskip_specs: true\n`, "utf8");

  const proposalInstructions = await gateway.getArtifactInstructions({ projectRoot, changeName, artifactId: "proposal" });
  assertOk(proposalInstructions.ok, "proposal instructions failed");
  const proposalArtifact = proposalInstructions.context?.openspec.artifacts.find((artifact) => artifact.id === "proposal");
  assertOk(Boolean(proposalArtifact?.path), "proposal instructions did not expose a resolved path");
  assertOk(Boolean(proposalArtifact?.instructions), "proposal instructions did not expose instructions");

  await writer.write({
    projectRoot,
    path: proposalArtifact?.path ?? "openspec/changes/smoke/proposal.md",
    content: [
      "## Why",
      "",
      "Verify the OpenSpec CLI contract in CI.",
      "",
      "## What Changes",
      "",
      "- Add a smoke check for machine-readable OpenSpec commands.",
      "",
      "## Capabilities",
      "",
      "### New Capabilities",
      "",
      "### Modified Capabilities",
      "",
      "## Impact",
      "",
      "- CI only.",
      "",
    ].join("\n"),
  });

  await writer.write({
    projectRoot,
    path: path.join(projectRoot, "openspec", "changes", changeName, "design.md"),
    content: "## Design\n\nNo runtime design is needed for the CI smoke check.\n",
  });
  await writer.write({
    projectRoot,
    path: path.join(projectRoot, "openspec", "changes", changeName, "tasks.md"),
    content: "## Tasks\n\n- [ ] Confirm smoke test passes.\n",
  });

  const validation = await gateway.validate({ projectRoot, changeName });
  assertOk(validation.context?.openspec.validation !== undefined, "validate did not return validation context");
  assertOk(validation.context?.openspec.validation?.valid === true, validation.context?.openspec.validation?.stderr || "OpenSpec validation failed");

  console.log(`OpenSpec ${version} smoke passed.`);
} finally {
  await rm(projectRoot, { recursive: true, force: true });
}

async function commandVersion() {
  const { NodeProcessRunner } = await import("../src/index.ts");
  const result = await new NodeProcessRunner().run("openspec", ["--version"], { cwd: process.cwd(), timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || "openspec --version failed");
  return result.stdout.trim();
}

function assertOk(condition, message) {
  if (!condition) throw new Error(message);
}
