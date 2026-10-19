import assert from "node:assert/strict";
import { test } from "node:test";

import { ConfigError, loadConfig, resolveConfig } from "../src/config.ts";
import { tree } from "./helpers.ts";

const model = { provider: "openrouter", name: "test-model", apiKey: "zz-key-zz", maxInputTokens: 32768 };
const rule = { prompt: "Q?", values: [{ value: "TRUE", report: "r" }, { value: "FALSE" }] };

test("a minimal config resolves every rule's settings, with defaults", () => {
  const { rules, concurrency } = resolveConfig({ model, suites: { api: { files: ["src/**/*.py"], rules: { f: rule } } } });
  assert.equal(concurrency, 16);
  assert.deepEqual(rules, [
    {
      suite: "api",
      name: "f",
      prompt: "Q?",
      values: rule.values,
      model,
      modelAt: "config.model",
      files: ["src/**/*.py"],
      ignores: [],
      context: {},
      threshold: 0.7,
      unchecked: "warn",
    },
  ]);
});

test("the nearest level wins and context merges by name", () => {
  const schema = () => "schema";
  const newer = { ...model, name: "newer-model" };
  const { rules } = resolveConfig({
    model,
    context: { schema },
    unchecked: "warn",
    suites: {
      security: {
        files: ["src/**/*.py"],
        threshold: 0.7,
        unchecked: "error",
        context: { owners: "a" },
        rules: {
          broad: rule,
          strict: { ...rule, threshold: 0.85, files: ["src/db/**/*.py"], context: { owners: "b", extra: "c" }, model: newer },
        },
      },
    },
  });
  const [broad, strict] = rules;
  assert.deepEqual([broad.threshold, broad.files, broad.unchecked, broad.model.name], [0.7, ["src/**/*.py"], "error", "test-model"]);
  assert.deepEqual(broad.context, { schema, owners: "a" });
  assert.deepEqual([strict.threshold, strict.files, strict.model.name], [0.85, ["src/db/**/*.py"], "newer-model"]);
  assert.equal(strict.modelAt, "suites.security.rules.strict.model");
  assert.deepEqual(strict.context, { schema, owners: "b", extra: "c" });
});

test("--suite selects suites, and an unknown one fails", () => {
  const config = { model, files: ["*.py"], suites: { api: { rules: { f: rule } }, security: { rules: { g: rule } } } };
  assert.deepEqual(resolveConfig(config, ["security"]).rules.map((r) => r.name), ["g"]);
  assert.throws(() => resolveConfig(config, ["secrity"]), /no suite named secrity/);
});

const invalid: [string, unknown, string][] = [
  ["not an object", [], "config: must default-export an object"],
  ["no suites", { model }, "config.suites: must name at least one suite"],
  ["suite without rules", { model, suites: { api: { files: ["a"] } } }, "suites.api.rules: must name at least one rule"],
  ["no model", { suites: { api: { files: ["a"], rules: { f: rule } } } }, "suites.api.rules.f: no model is set"],
  ["no files", { model, suites: { api: { rules: { f: rule } } } }, "suites.api.rules.f: no files are set"],
  [
    "one value",
    { model, files: ["a"], suites: { api: { rules: { f: { prompt: "Q?", values: [{ value: "A" }] } } } } },
    "suites.api.rules.f.values: must list at least two values",
  ],
  [
    "duplicate value",
    { model, files: ["a"], suites: { api: { rules: { f: { prompt: "Q?", values: [{ value: "A" }, { value: "A" }] } } } } },
    "suites.api.rules.f.values: duplicate value 'A'",
  ],
  [
    "bad severity",
    { model, files: ["a"], suites: { api: { rules: { f: { prompt: "Q?", values: [{ value: "A", severity: "fatal" }, { value: "B" }] } } } } },
    "suites.api.rules.f.values.A.severity",
  ],
  [
    "bad threshold",
    { model, files: ["a"], suites: { api: { threshold: 1.5, rules: { f: rule } } } },
    "suites.api.threshold: must be a number in [0, 1]",
  ],
  [
    "misspelled setting",
    { model, files: ["a"], suites: { api: { rules: { f: { ...rule, values: [{ value: "TRUE", sevrity: "warn" }, { value: "FALSE" }] } } } } },
    "suites.api.rules.f.values.TRUE.sevrity: unknown setting",
  ],
  ["reserved context name", { model, files: ["a"], context: { content: "x" }, suites: { api: { rules: { f: rule } } } }, "config.context.content: 'content' is reserved"],
  ["bad unchecked", { model, files: ["a"], unchecked: "fail", suites: { api: { rules: { f: rule } } } }, "config.unchecked"],
];

for (const [name, config, message] of invalid) {
  test(`rejects ${name}`, () => {
    assert.throws(() => resolveConfig(config), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(error.message.includes(message), error.message);
      return true;
    });
  });
}

test("model errors name the setting, never the key", () => {
  for (const [bad, message] of [
    [{ ...model, provider: "openroutr" }, "suites.api.model.provider: must be one of openrouter"],
    [{ ...model, maxInputTokens: 0 }, "suites.api.model.maxInputTokens: must be a positive integer"],
    [{ ...model, apiKey: 42 }, "suites.api.model.apiKey: must be a string"],
    [{ ...model, url: "not a url" }, "suites.api.model.url: must be a URL"],
    [{ ...model, apikey: "x" }, "suites.api.model.apikey: unknown setting"],
  ] as const) {
    assert.throws(
      () => resolveConfig({ files: ["a"], suites: { api: { model: bad, rules: { f: rule } } } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.ok(error.message.includes(message), error.message);
        assert.ok(!error.message.includes(model.apiKey));
        return true;
      },
    );
  }
});

test("a config file loads with the suites it imports", async () => {
  const dir = await tree({
    "lint/security.ts": `export default { files: ["src/**/*.py"], rules: { q: { prompt: "Q?", values: [{ value: "TRUE" }, { value: "FALSE" }] } } };\n`,
    "lint/config.ts": `import type { Config } from "@getsentry/decision-model-linter";
import security from "./security.ts";
export default {
  model: { provider: "openrouter", name: "test-model", apiKey: process.env.NOT_SET_ANYWHERE, maxInputTokens: 32768 },
  suites: { security },
} satisfies Config;
`,
  });
  const { rules } = await loadConfig(`${dir}/lint/config.ts`);
  assert.deepEqual(rules.map((r) => [r.suite, r.name, r.model.apiKey]), [["security", "q", undefined]]);
});

test("a config that fails to load is reported by its first line only", async () => {
  const dir = await tree({ "config.ts": "export default {\n  apiKey: 'zz-key-zz',\n  oops oops\n};\n" });
  await assert.rejects(loadConfig(`${dir}/config.ts`), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /^cannot load .*config\.ts: /);
    assert.ok(!error.message.includes("\n"));
    assert.ok(!error.message.includes("zz-key-zz"));
    return true;
  });
});
