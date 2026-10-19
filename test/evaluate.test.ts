import assert from "node:assert/strict";
import { test } from "node:test";

import { WHOLE_FILE_INSTRUCTIONS, lint } from "../src/evaluate.ts";
import { type DecisionModel, ModelError } from "../src/models.ts";
import { FakeModel, MODEL, rule, tree } from "./helpers.ts";

test("rules of a suite that share a model and context share one call per file", async () => {
  const cwd = await tree({ "src/a/endpoints/x.py": "x", "src/a/other.py": "y", "src/a/tests/t.py": "t" });
  const rules = [
    rule("createsNewApiEndpoint", { files: ["src/**/endpoints/**/*.py"] }),
    rule("omits", { files: ["src/**/*.py"], ignores: ["**/tests/**"] }),
  ];
  const client = new FakeModel();
  const results = await lint(rules, ["src/a/endpoints/x.py", "src/a/other.py", "src/a/tests/t.py"], {
    cwd,
    connect: () => client,
  });
  assert.deepEqual(
    results.map((r) => [r.path, r.rules]),
    [
      ["src/a/endpoints/x.py", ["createsNewApiEndpoint", "omits"]],
      ["src/a/other.py", ["omits"]],
    ],
  );
  const endpointCall = client.calls.find((c) => c.state.path === "src/a/endpoints/x.py")!;
  assert.deepEqual(endpointCall.state, { path: "src/a/endpoints/x.py", content: "1\tx\n" });
  assert.deepEqual(Object.keys(endpointCall.questions), ["createsNewApiEndpoint", "omits"]);
});

test("an overridden context or model splits a rule into its own call, and suites never share one", async () => {
  const cwd = await tree({ "a.py": "x" });
  const rules = [
    rule("a"),
    rule("b"),
    rule("c", { context: { owners: "team" } }),
    rule("d", { model: { ...MODEL, name: "other-model" } }),
    rule("e", { suite: "security" }),
  ];
  const results = await lint(rules, ["a.py"], { cwd, connect: () => new FakeModel() });
  assert.deepEqual(
    results.map((r) => [r.suite, r.rules]).sort(),
    [
      ["api", ["a", "b"]],
      ["api", ["c"]],
      ["api", ["d"]],
      ["security", ["e"]],
    ],
  );
});

test("TRUE/FALSE rules are yes/no questions; others are multiple choice", async () => {
  const cwd = await tree({ "a.py": "x" });
  const rules = [
    rule("flag", { prompt: "Flag?", values: [{ value: "TRUE", description: "it is" }, { value: "FALSE" }] }),
    rule("plain", { prompt: "Plain?", values: [{ value: "TRUE" }, { value: "FALSE" }] }),
    rule("dup", {
      prompt: "Duplicate?",
      values: [{ value: "YES", description: "same as one" }, { value: "NO" }, { value: "NO_ENDPOINTS" }],
    }),
  ];
  const client = new FakeModel((_, q) =>
    q.type === "yesno"
      ? { type: "yesno", yes: 0.9 }
      : { type: "choice", probabilities: { YES: 0.1, NO: 0.8, NO_ENDPOINTS: 0.1 } },
  );
  const [result] = await lint(rules, ["a.py"], { cwd, connect: () => client });
  const { questions } = client.calls[0];
  const asked = (prompt: string) => `${WHOLE_FILE_INSTRUCTIONS}\n\nQuestion: ${prompt}`;
  assert.deepEqual(questions.flag, { type: "yesno", instructions: asked("Flag?"), criteria: { yes: "it is", no: "FALSE" } });
  assert.deepEqual(questions.plain, { type: "yesno", instructions: asked("Plain?") });
  assert.deepEqual(questions.dup, {
    type: "choice",
    instructions: asked("Duplicate?"),
    options: { YES: "same as one", NO: "NO", NO_ENDPOINTS: "NO_ENDPOINTS" },
  });
  assert.equal(result.answers.flag.TRUE, 0.9);
  assert.ok(Math.abs(result.answers.flag.FALSE - 0.1) < 1e-9);
  assert.deepEqual(result.answers.dup, { YES: 0.1, NO: 0.8, NO_ENDPOINTS: 0.1 });
});

test("a reporting value at or above its threshold is a finding", async () => {
  const cwd = await tree({ "a.py": "x" });
  const rules = [
    rule("high"),
    rule("low"),
    rule("strict", { threshold: 0.85 }),
    rule("negative", {
      values: [{ value: "TRUE" }, { value: "FALSE", severity: "error", report: "Paginate.", threshold: 0.6 }],
    }),
  ];
  const yes: Record<string, number> = { high: 0.97, low: 0.6, strict: 0.8, negative: 0.3 };
  const [result] = await lint(rules, ["a.py"], { cwd, connect: () => new FakeModel((id) => ({ type: "yesno", yes: yes[id] })) });
  assert.deepEqual(
    result.findings.map((f) => [f.rule, f.value, f.severity, f.threshold, f.message]),
    [
      ["high", "TRUE", "warn", 0.7, "Fix."],
      ["negative", "FALSE", "error", 0.6, "Paginate."],
    ],
  );
});

test("context functions get the file and run at most once per file", async () => {
  const cwd = await tree({ "a.py": "1", "b.py": "2" });
  const runs: string[] = [];
  const schema = async ({ path }: { path: string }) => {
    runs.push(path);
    return `schema for ${path}`;
  };
  // Two models, so each file is sent in two calls that share the context.
  const rules = [rule("f", { context: { schema, note: "static" } }), rule("g", { context: { schema, note: "static" }, model: { ...MODEL, name: "other-model" } })];
  const client = new FakeModel();
  await lint(rules, ["a.py", "b.py"], { cwd, connect: () => client });
  assert.deepEqual(runs.sort(), ["a.py", "b.py"]);
  assert.equal(client.calls.length, 4);
  for (const call of client.calls) {
    assert.equal(call.state.schema, `schema for ${call.state.path}`);
    assert.equal(call.state.note, "static");
  }
});

test("content over the model's input limit is truncated with a marker, and the file is unchecked", async () => {
  const cwd = await tree({ "big.py": "line\n".repeat(5000) });
  const client = new FakeModel();
  const [result] = await lint([rule("f", { model: { ...MODEL, maxInputTokens: 500 } })], ["big.py"], { cwd, connect: () => client });
  assert.ok(result.truncated);
  assert.equal(result.unchecked, "warn");
  assert.match(client.calls[0].state.content, /\[decision-model-linter: truncated, \d+ of \d+ characters omitted\]\n$/);
  assert.ok(client.calls[0].state.content.length < 1500);
});

test("a call the provider rejects as too large is retried once at half the budget", async () => {
  const cwd = await tree({ "big.py": "line\n".repeat(5000) });
  const client = new FakeModel((_, __, attempt) => {
    if (attempt === 1) throw new ModelError("HTTP 400: too large", true);
    return { type: "yesno", yes: 0.9 };
  });
  const [result] = await lint([rule("f", { model: { ...MODEL, maxInputTokens: 2000 } })], ["big.py"], { cwd, connect: () => client });
  assert.ok(result.shrunk);
  assert.equal(result.error, undefined);
  assert.ok(client.calls[1].state.content.length < client.calls[0].state.content.length);
});

test("a failed call leaves its file unchecked without stopping the others", async () => {
  const cwd = await tree({ "a.py": "1", "b.py": "2" });
  const client = new FakeModel(() => ({ type: "yesno", yes: 0.9 }));
  const failing: DecisionModel = {
    decide: (state, questions) =>
      state.path === "a.py" ? Promise.reject(new ModelError("HTTP 500: boom")) : client.decide(state, questions),
  };
  const results = await lint([rule("f")], ["a.py", "b.py"], { cwd, connect: () => failing });
  assert.deepEqual([results[0].error, results[0].unchecked], ["HTTP 500: boom", "warn"]);
  assert.deepEqual([results[1].unchecked, results[1].findings.length], [undefined, 1]);
});

test("an unchecked file takes the most severe unchecked setting among the call's rules", async () => {
  const cwd = await tree({ "a.py": "1" });
  const failing: DecisionModel = { decide: () => Promise.reject(new ModelError("HTTP 500: boom")) };
  const rules = [rule("lenient"), rule("strict", { unchecked: "error" })];
  const [result] = await lint(rules, ["a.py"], { cwd, connect: () => failing });
  assert.deepEqual([result.rules, result.unchecked], [["lenient", "strict"], "error"]);
});

test("results name the provider and the model that answered", async () => {
  const cwd = await tree({ "a.py": "1" });
  const answered: DecisionModel = {
    decide: async () => ({ answers: { f: { type: "yesno", yes: 0.1 } }, durationMs: 1, model: "test-model-2026" }),
  };
  const [reported] = await lint([rule("f")], ["a.py"], { cwd, connect: () => answered });
  assert.deepEqual([reported.provider, reported.model], ["openrouter", "test-model-2026"]);
  const [fallback] = await lint([rule("f")], ["a.py"], { cwd, connect: () => new FakeModel() });
  assert.equal(fallback.model, "test-model");
});
