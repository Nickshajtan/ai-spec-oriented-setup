import assert from "node:assert/strict";
import test from "node:test";
import { parseModelJson } from "../src/model/structured-output.ts";

test("parses plain JSON model output", () => {
  assert.deepEqual(parseModelJson('{"ready":true}'), { ready: true });
});

test("parses fenced JSON and surrounding noise", () => {
  assert.deepEqual(parseModelJson('```json\n{"ready":false}\n```'), { ready: false });
  assert.deepEqual(parseModelJson('Here is the result:\n{"gap":"scale"}\nThanks'), { gap: "scale" });
});

test("rejects invalid model output", () => {
  assert.throws(() => parseModelJson("not json"), /JSON object/);
  assert.throws(() => parseModelJson("{broken"), /JSON object|invalid JSON/);
});
