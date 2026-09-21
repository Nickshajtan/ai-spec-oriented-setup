import { runCoreCli } from "../../src/runtime/run-core-cli.ts";
import { createSpecifierRuntime } from "../../src/runtime/composition.ts";
import { DeterministicRuntimeModel } from "./deterministic-runtime-model.ts";

process.exitCode = await runCoreCli(process.argv.slice(2), undefined, {
  createRuntime: () => createSpecifierRuntime({ model: new DeterministicRuntimeModel() }),
});
