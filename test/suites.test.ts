import assert from "node:assert/strict";
import { test } from "node:test";

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SuiteError, loadSuites, validateEntries } from "../src/suites.ts";

const field = { prompt: "Q?", values: [{ value: "TRUE", report: "r" }, { value: "FALSE" }] };

test("a minimal suite validates", () => {
  const config = [{ files: ["src/**/*.py"], fields: { f: field } }];
  assert.equal(validateEntries(config), config);
});

const invalid: [string, unknown, string][] = [
  ["not an array", {}, "non-empty array"],
  ["entry without fields", [{ files: ["a"] }], "entry 0: missing fields"],
  ["entry without files", [{ fields: { f: field } }], "entry 0.files: must be a list of strings"],
  ["one value", [{ files: ["a"], fields: { f: { prompt: "Q?", values: [{ value: "A" }] } } }], "at least two values"],
  [
    "duplicate value",
    [{ files: ["a"], fields: { f: { prompt: "Q?", values: [{ value: "A" }, { value: "A" }] } } }],
    "duplicate value 'A'",
  ],
  [
    "bad severity",
    [{ files: ["a"], fields: { f: { prompt: "Q?", values: [{ value: "A", severity: "fatal" }, { value: "B" }] } } }],
    "entry 0.fields.f.A: severity",
  ],
  [
    "bad threshold",
    [{ files: ["a"], fields: { f: { prompt: "Q?", values: [{ value: "A", threshold: 1.5 }, { value: "B" }] } } }],
    "entry 0.fields.f.A: threshold",
  ],
  ["reserved context key", [{ files: ["a"], context: { content: "x" }, fields: { f: field } }], "reserved"],
];

for (const [name, config, message] of invalid) {
  test(`rejects ${name}`, () => {
    assert.throws(() => validateEntries(config), (error: unknown) => {
      assert.ok(error instanceof SuiteError);
      assert.match(error.message, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    });
  });
}

test("every suite file in the directory loads, named by its file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decision-model-linter-suites-"));
  const suite = `export default [{ files: ["*.py"], fields: { f: { prompt: "Q?", values: [{ value: "A" }, { value: "B" }] } } }];\n`;
  await writeFile(join(dir, "security.ts"), suite);
  await writeFile(join(dir, "api-quality.mts"), suite);
  await mkdir(join(dir, "helpers"));
  await writeFile(join(dir, "helpers", "helper.ts"), "export const x = 1;\n");
  await writeFile(join(dir, "types.d.ts"), "export {};\n");

  assert.deepEqual((await loadSuites(dir)).map((s) => s.name), ["api-quality", "security"]);
  assert.deepEqual((await loadSuites(dir, ["security"])).map((s) => s.name), ["security"]);
  await assert.rejects(loadSuites(dir, ["perf"]), /no suite named perf/);
});

test("a broken suite is named in the error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decision-model-linter-suites-"));
  await writeFile(join(dir, "security.ts"), "export default [{ files: [] }];\n");
  await assert.rejects(loadSuites(dir), /suite security: entry 0.files: must not be empty/);
});
