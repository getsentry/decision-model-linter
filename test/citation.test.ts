import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { resolveConfig, type Citation } from "../src/config.ts";
import { lint } from "../src/evaluate.ts";
import { main } from "../src/cli.ts";
import { validatedOffsets } from "../src/citation.ts";
import { exitCode, format } from "../src/report.ts";
import { FakeModel, MODEL, configSource, rule, tree } from "./helpers.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const citation: Citation = {
  provider: "openrouter",
  name: "cloudflare/clairic",
  apiKey: "citation-test-key",
  maxInputTokens: 8192,
};
const source = "old = query.get('old')\r\nnew = query.get('new')\r\n";

function evidence(state: string, values: string[], confidence = 0.95) {
  return {
    type: "list", confidence, value: values,
    spans: values.map((value) => [state.indexOf(value), state.indexOf(value) + value.length]),
  };
}

function stub(output: unknown, status = 200) {
  const sent: any[] = [];
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(output), { status });
  };
  return sent;
}

async function run(options: { changed?: Set<number>; citation?: Citation; yes?: number } = {}) {
  const cwd = await tree({ "a.py": source });
  return lint([rule("query", { citationPrompt: "Select query.get calls." })], ["a.py"], {
    cwd, connect: () => new FakeModel(() => ({ type: "yesno", yes: options.yes ?? 0.9 })),
    citation: options.citation ?? citation,
    newLines: options.changed ? new Map([["a.py", options.changed]]) : undefined,
  });
}

test("extracts repeated evidence with CRLF coordinates and filters to changed lines", async () => {
  const sent = stub({
    state_text: source, answers: { f0: evidence(source, ["query.get('old')", "query.get('new')", "query.get('new')"]) },
    usage: { input_tokens: 120, output_tokens: 0 }, truncated: false,
  });
  const results = await run({ changed: new Set([2]) });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].state, source);
  assert.equal(sent[0].model, "cloudflare/clairic");
  assert.match(sent[0].fields.f0.instructions, /Select query.get calls/);
  assert.match(sent[0].fields.f0.instructions, /changed source lines.*2/);
  assert.deepEqual(results[0].findings[0].locations, [{ line: 2, endLine: 2, col: 7, endColumn: 22 }]);
  assert.deepEqual(results[0].citation, { calls: 1, inputTokens: 120, outputTokens: 0 });
  assert.match(format(results, "github"), /file=a.py,line=2,endLine=2,col=7,endColumn=22/);
  assert.match(format(results, "github"), /citation: 1 calls, 120 input tokens/);
  assert.equal(exitCode(results), 0);
});

test("emits an annotation per occurrence, omitting columns for multiline spans", async () => {
  stub({ answers: { f0: evidence(source, ["query.get('old')", "query.get('new')", source]) } });
  const results = await run();
  const annotations = format(results, "github").split("\n").filter((line) => line.startsWith("::warning"));
  assert.equal(annotations.length, 3);
  assert.match(annotations[0], /line=1,endLine=1,col=7,endColumn=22/);
  assert.match(annotations[2], /line=1,endLine=2,title=/);
});

test("citation is skipped for clean files and inputs over budget", async () => {
  const sent = stub({});
  const clean = await run({ yes: 0.1 });
  assert.equal(clean[0].citation, undefined);
  const large = await run({ citation: { ...citation, maxInputTokens: 1 } });
  assert.equal(large[0].citation?.calls, 0);
  assert.match(large[0].citation!.error!, /budget/);
  assert.equal(large[0].findings.length, 1);
  assert.equal(large[0].unchecked, undefined);
  assert.equal(sent.length, 0);
});

for (const [name, output, status] of [
  ["unavailable extraction model", { error: { message: "Model cloudflare/clairic does not exist" } }, 400],
  ["HTTP failure", { detail: "private source or credentials" }, 503],
  ["truncation", { truncated: true, answers: { f0: evidence(source, [source]) } }, 200],
  ["different state", { state_text: "different", answers: { f0: evidence(source, [source]) } }, 200],
  ["missing answers", {}, 200],
] as const) {
  test(`${name} preserves the decision and reports a safe citation diagnostic`, async () => {
    stub(output, status);
    const cwd = await tree({ "a.py": source });
    const results = await lint([rule("query", {
      values: [{ value: "TRUE", severity: "error", report: "Fix." }, { value: "FALSE" }],
    })], ["a.py"], {
      cwd, connect: () => new FakeModel(() => ({ type: "yesno", yes: 0.9 })), citation,
    });
    assert.equal(results[0].findings.length, 1);
    assert.equal(results[0].findings[0].locations, undefined);
    assert.equal(results[0].unchecked, undefined);
    assert.equal(exitCode(results), 1);
    assert.ok(results[0].citation?.error);
    assert.doesNotMatch(JSON.stringify(results), /private|citation-test-key/);
    assert.match(format(results, "github"), /retaining file-level findings/);
  });
}

for (const [name, answer] of [
  ["null value with a guessed span", { ...evidence(source, [source]), value: null }],
  ["low confidence", evidence(source, [source], 0.2)],
  ["missing confidence", { type: "list", value: [source], spans: [[0, source.length]] }],
  ["mismatched source text", { ...evidence(source, [source]), value: ["invented"] }],
  ["invalid span", { ...evidence(source, [source]), spans: [[-1, source.length]] }],
  ["mismatched list lengths", { ...evidence(source, [source]), spans: [] }],
] as const) {
  test(`${name} falls back to a file finding`, async () => {
    stub({ answers: { f0: answer } });
    const results = await run();
    assert.equal(results[0].findings.length, 1);
    assert.equal(results[0].findings[0].locations, undefined);
  });
}

test("validates Unicode code-point and UTF-16 spans and rejects ambiguous or invalid ranges", () => {
  const text = "😀 target";
  assert.deepEqual(validatedOffsets(text, [2, 8], "target"), [3, 9]);
  assert.deepEqual(validatedOffsets(text, [3, 9], "target"), [3, 9]);
  assert.equal(validatedOffsets("😀aaa", [2, 3], "a"), undefined);
  assert.equal(validatedOffsets(text, [2, 100], "target"), undefined);
  assert.equal(validatedOffsets(text, [1.5, 3], "x"), undefined);
});

test("Unicode offsets map to character columns", async () => {
  const content = "😀 target😀\n";
  stub({ answers: { f0: { type: "list", value: ["target😀"], spans: [[2, 9]], confidence: 0.99 } } });
  const cwd = await tree({ "a.py": content });
  const results = await lint([rule("query")], ["a.py"], {
    cwd, connect: () => new FakeModel(() => ({ type: "yesno", yes: 0.9 })), citation,
  });
  assert.deepEqual(results[0].findings[0].locations, [{ line: 1, col: 3, endLine: 1, endColumn: 9 }]);
});

test("config resolves citation and a missing extraction key fails before model calls", async () => {
  // Use config-file source so normal CLI loading and validation are exercised together.
  const source = configSource().replace("export default {", `export default { citation: ${JSON.stringify({ ...citation, apiKey: "" })},`);
  const cwd = await tree({ "decision-model-linter.config.ts": source, "a.py": "x" });
  let error = "";
  const client = new FakeModel();
  const code = await main(["a.py"], { cwd, write: () => {}, writeError: (text) => { error += text; }, connect: () => client });
  assert.equal(code, 2);
  assert.match(error, /config.citation.apiKey/);
  assert.equal(client.calls.length, 0);
  // Config validation rejects unknown fields and invalid limits without revealing values.
  const minimal = { model: MODEL, files: ["*.py"], suites: { api: { rules: { f: { prompt: "Q?", values: [{ value: "TRUE", report: "Fix" }, { value: "FALSE" }] } } } } };
  assert.deepEqual(resolveConfig({ ...minimal, citation }).citation, citation);
  for (const invalid of [{ ...citation, maxInputTokens: 0 }, { ...citation, threshold: 2 }, { ...citation, provider: "unknown" }, { ...citation, unknown: true }]) {
    assert.throws(() => resolveConfig({ ...minimal, citation: invalid }), /config.citation/);
  }
});

test("CLI forwards citation config and batches findings into one extraction request", async () => {
  const sent = stub({ answers: {
    f0: evidence(source, ["query.get('old')"]),
    f1: evidence(source, ["query.get('new')"]),
  } });
  const config = {
    model: MODEL, citation, files: ["*.py"], suites: { api: { rules: {
      old: { prompt: "Old query?", values: [{ value: "TRUE", report: "Old." }, { value: "FALSE" }] },
      new: { prompt: "New query?", values: [{ value: "TRUE", report: "New." }, { value: "FALSE" }] },
    } } },
  };
  const cwd = await tree({ "decision-model-linter.config.ts": `export default ${JSON.stringify(config)};`, "a.py": source });
  let output = "";
  const code = await main(["--format", "github", "a.py"], {
    cwd, write: (text) => { output += text; }, writeError: () => {},
    connect: () => new FakeModel(() => ({ type: "yesno", yes: 0.9 })),
  });
  assert.equal(code, 0);
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0].fields), ["f0", "f1"]);
  assert.match(output, /line=1,endLine=1,col=7,endColumn=22/);
  assert.match(output, /line=2,endLine=2,col=7,endColumn=22/);
});

test("network failures leave file findings intact", async () => {
  globalThis.fetch = async () => { throw new Error("private provider details"); };
  const results = await run();
  assert.equal(results[0].findings.length, 1);
  assert.equal(results[0].unchecked, undefined);
  assert.match(results[0].citation!.error!, /request failed/);
  assert.doesNotMatch(JSON.stringify(results), /private/);
});


test("a null optional state_text does not discard valid citations", async () => {
  stub({ state_text: null, answers: { f0: evidence(source, ["query.get('new')"]) } });
  const results = await run();
  assert.equal(results[0].findings[0].locations?.[0].line, 2);
});
