import { runCoreCli } from "./run-core-cli.ts";

process.exitCode = await runCoreCli(process.argv.slice(2));
