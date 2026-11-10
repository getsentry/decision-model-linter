import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { resolveConfig, type Citation, type Model } from "../src/config.ts";
import { lint } from "../src/evaluate.ts";
import { main } from "../src/cli.ts";
import { exitCode, format } from "../src/report.ts";
import { FakeModel, MODEL, configSource, rule, tree } from "./helpers.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const citation: Citation = { threshold: 0.7 };
const source = "old = query.get('old')\r\nnew = query.get('new')\r\n";

function stub(output: unknown, status = 200) {
  const sent: { url: string; body: any; headers: Headers }[] = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(output), { status });
  };
  return sent;
}

async function run(options: { changed?: Set<number>; citation?: Citation | false; model?: Model; yes?: number; source?: string } = {}) {
  const cwd = await tree({ "a.py": options.source ?? source });
  return lint([rule("query", { prompt: "Does this file read query parameters with query.get?", model: options.model ?? MODEL })], ["a.py"], {
    cwd, connect: () => new FakeModel(() => ({ type: "yesno", yes: options.yes ?? 0.9 })),
    citation: options.citation,
    newLines: options.changed ? new Map([["a.py", options.changed]]) : undefined,
  });
}

test("selects a real changed source line and emits a whole-line annotation", async () => {
  const sent = stub({ answers: { f0: { probabilities: { none: 0.05, line_2: 0.95 } } }, usage: { input_tokens: 120, output_tokens: 20 } });
  const results = await run({ changed: new Set([2]) });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://openrouter.ai/api/alpha/decisions");
  assert.deepEqual(sent[0].body.state, { path: "a.py", content: source });
  assert.deepEqual(sent[0].body.questions.f0.criteria, { none: "No source line supports the reported answer and finding.", line_2: "Line 2: new = query.get('new')" });
  assert.match(sent[0].body.questions.f0.instructions, /Does this file read query parameters with query.get/);
  assert.deepEqual(results[0].findings[0].locations, [{ line: 2, endLine: 2, col: 1, endColumn: 22 }]);
  assert.deepEqual(results[0].citation, { calls: 1, inputTokens: 120, outputTokens: 20 });
  assert.match(format(results, "github"), /file=a.py,line=2,endLine=2,col=1,endColumn=22/);
  assert.match(format(results, "github"), /citation: 1 calls, 120 input tokens/);
  assert.equal(exitCode(results), 0);
});

test("blank and unchanged lines cannot be selected, and Unicode columns exclude CRLF", async () => {
  const sent = stub({ answers: { f0: { probabilities: { none: 0.01, line_3: 0.99 } } } });
  const results = await run({ source: "old\r\n  \r\n😀 target😀\r\n", changed: new Set([2, 3]) });
  assert.deepEqual(Object.keys(sent[0].body.questions.f0.criteria), ["none", "line_3"]);
  assert.deepEqual(results[0].findings[0].locations, [{ line: 3, endLine: 3, col: 1, endColumn: 9 }]);
});

test("citation false skips requests and preserves the file-level finding", async () => {
  const sent = stub({});
  const results = await run({ citation: false });
  assert.equal(sent.length, 0);
  assert.equal(results[0].citation, undefined);
  assert.equal(results[0].findings.length, 1);
  assert.equal(results[0].findings[0].locations, undefined);
});

test("citation is skipped for clean files, no eligible lines, and inputs over budget", async () => {
  const sent = stub({});
  const clean = await run({ yes: 0.1 });
  assert.equal(clean[0].citation, undefined);
  const empty = await run({ source: " \n\t\n" });
  assert.deepEqual(empty[0].citation, { calls: 0 });
  const unchanged = await run({ changed: new Set([50]) });
  assert.deepEqual(unchanged[0].citation, { calls: 0 });
  const large = await run({ model: { ...MODEL, maxInputTokens: 1 } });
  assert.equal(large[0].citation?.calls, 0);
  assert.match(large[0].citation!.error!, /budget/);
  assert.equal(large[0].findings.length, 1);
  assert.equal(large[0].unchecked, undefined);
  assert.equal(sent.length, 0);
});

for (const [name, probabilities] of [
  ["no evidence", { none: 0.9, line_1: 0.05, line_2: 0.05 }],
  ["low probability", { none: 0.2, line_1: 0.4, line_2: 0.4 }],
  ["unknown line", { none: 0.05, line_1: 0.05, line_50: 0.9 }],
  ["missing probability", { line_1: 0.9 }],
  ["negative probability", { none: -0.1, line_1: 0.95, line_2: 0.15 }],
  ["probability over one", { none: 0, line_1: 1.1, line_2: 0 }],
  ["non-numeric probability", { none: 0, line_1: "0.9", line_2: 0.1 }],
  ["null probability", { none: 0, line_1: null, line_2: 0.9 }],
  ["empty probabilities", {}],
  ["overfull probabilities", { none: 0.8, line_1: 0.9, line_2: 0.7 }],
  ["underfull probabilities", { none: 0, line_1: 0.75, line_2: 0 }],
] as const) {
  test(`${name} retains the file-level finding`, async () => {
    stub({ answers: { f0: { probabilities } } });
    const results = await run();
    assert.equal(results[0].findings.length, 1);
    assert.equal(results[0].findings[0].locations, undefined);
    assert.equal(results[0].unchecked, undefined);
  });
}

test("rounded probabilities still select a confident line", async () => {
  stub({ answers: { f0: { probabilities: { none: 0.0333333, line_1: 0.9333333, line_2: 0.0333333 } } } });
  const results = await run();
  assert.equal(results[0].findings[0].locations?.[0]?.line, 1);
});

test("citation threshold is configurable independently of the decision threshold", async () => {
  stub({ answers: { f0: { probabilities: { none: 0.1, line_1: 0.8, line_2: 0.1 } } } });
  const defaultThreshold = await run({ citation: {} });
  assert.equal(defaultThreshold[0].findings[0].locations?.[0]?.line, 1);
  const higherThreshold = await run({ citation: { threshold: 0.9 } });
  assert.equal(higherThreshold[0].findings.length, 1);
  assert.equal(higherThreshold[0].findings[0].locations, undefined);
  assert.equal(higherThreshold[0].findings[0].threshold, 0.7);
});

test("citation reuses the resolved rule model, API key, and endpoint", async () => {
  const sent = stub({ answers: { f0: { probabilities: { none: 0.01, line_1: 0.98, line_2: 0.01 } } } });
  const model = { ...MODEL, name: "rule-model", apiKey: "rule-test-key", url: "https://rule.example/decisions" };
  const cwd = await tree({ "a.py": source });
  const results = await lint([rule("query", { model })], ["a.py"], {
    cwd, connect: (configured) => { assert.deepEqual(configured, model); return new FakeModel(() => ({ type: "yesno", yes: 0.9 })); },
    citation: {},
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, model.url);
  assert.equal(sent[0].body.model, model.name);
  assert.equal(sent[0].headers.get("authorization"), `Bearer ${model.apiKey}`);
  assert.equal(results[0].findings[0].locations?.[0]?.line, 1);
});

test("citation uses resolved context and path to distinguish identical source", async () => {
  const cwd = await tree({ "a.py": "call_a()\ncall_b()\n" });
  for (const [forbidden, line] of [["call_a", 1], ["call_b", 2]] as const) {
    let contextCalls = 0;
    const sent: { state: Record<string, string> }[] = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      sent.push(body);
      const { state } = body;
      return new Response(JSON.stringify({ answers: { f0: { probabilities: {
        none: 0, line_1: state.forbidden === "call_a" ? 1 : 0, line_2: state.forbidden === "call_b" ? 1 : 0,
      } } } }));
    };
    const results = await lint([rule("forbidden", {
      prompt: "Does this file call the function named in forbidden?",
      context: { forbidden: async ({ path }) => { contextCalls++; assert.equal(path, "a.py"); return forbidden; } },
    })], ["a.py"], {
      cwd, connect: () => new FakeModel(() => ({ type: "yesno", yes: 0.9 })), citation,
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].state.path, "a.py");
    assert.equal(sent[0].state.forbidden, forbidden);
    assert.equal(results[0].findings[0].locations?.[0]?.line, line);
    assert.equal(contextCalls, 1);
    assert.equal(results[0].unchecked, undefined);
  }
});

test("citation budget includes resolved context", async () => {
  const sent = stub({});
  const cwd = await tree({ "a.py": source });
  const results = await lint([rule("query", { model: { ...MODEL, maxInputTokens: 8192 }, context: { reference: "x".repeat(23_500) } })], ["a.py"], {
    cwd, connect: () => new FakeModel(() => ({ type: "yesno", yes: 0.9 })), citation,
  });
  assert.equal(sent.length, 0);
  assert.equal(results[0].citation?.calls, 0);
  assert.match(results[0].citation!.error!, /budget/);
  assert.equal(results[0].findings.length, 1);
  assert.equal(results[0].unchecked, undefined);
});

test("a malformed distribution does not discard another finding's valid citation", async () => {
  stub({ answers: {
    f0: { probabilities: { none: 0.8, line_1: 0.9, line_2: 0.7 } },
    f1: { probabilities: { none: 0.01, line_1: 0.01, line_2: 0.98 } },
  } });
  const cwd = await tree({ "a.py": source });
  const results = await lint([rule("old"), rule("new")], ["a.py"], {
    cwd, connect: () => new FakeModel(() => ({ type: "yesno", yes: 0.9 })), citation,
  });
  assert.equal(results[0].findings.length, 2);
  assert.equal(results[0].findings[0].locations, undefined);
  assert.equal(results[0].findings[1].locations?.[0]?.line, 2);
  assert.equal(results[0].unchecked, undefined);
});

test("a tie remains file-level even when both lines exceed the threshold", async () => {
  stub({ answers: { f0: { probabilities: { none: 0, line_1: 0.5, line_2: 0.5 } } } });
  const results = await run({ citation: { threshold: 0.4 } });
  assert.equal(results[0].findings[0].locations, undefined);
});

for (const [name, output, status] of [
  ["HTTP failure", { detail: "private source or credentials" }, 503],
  ["missing answers", {}, 200],
  ["wrong answer type", { answers: { f0: { noul: 0.9 } } }, 200],
] as const) {
  test(`${name} preserves severity and reports a safe citation diagnostic without retries`, async () => {
    const sent = stub(output, status);
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
    assert.equal(sent.length, 1);
  });
}

test("network failures leave file findings intact", async () => {
  globalThis.fetch = async () => { throw new Error("private provider details"); };
  const results = await run();
  assert.equal(results[0].findings.length, 1);
  assert.equal(results[0].unchecked, undefined);
  assert.match(results[0].citation!.error!, /request failed/);
  assert.doesNotMatch(JSON.stringify(results), /private/);
});

test("config resolves citation settings and the shared model key is required", async () => {
  const config = configSource().replace("citation: false", `citation: ${JSON.stringify(citation)}`).replace('apiKey: "test"', 'apiKey: ""');
  const cwd = await tree({ "decision-model-linter.config.ts": config, "a.py": "x" });
  let error = "";
  const client = new FakeModel();
  const code = await main(["a.py"], { cwd, write: () => {}, writeError: (text) => { error += text; }, connect: () => client });
  assert.equal(code, 2);
  assert.match(error, /config.model.apiKey/);
  assert.equal(client.calls.length, 0);
  const minimal = { model: MODEL, files: ["*.py"], suites: { api: { rules: { f: { prompt: "Q?", values: [{ value: "TRUE", report: "Fix" }, { value: "FALSE" }] } } } } };
  assert.deepEqual(resolveConfig({ ...minimal, citation }).citation, citation);
  assert.deepEqual(resolveConfig({ ...minimal, citation: {} }).citation, {});
  assert.equal(resolveConfig({ ...minimal, citation: false }).citation, false);
  for (const invalid of [null, true, { threshold: -1 }, { threshold: 2 }, { threshold: NaN }, { threshold: Infinity }, { threshold: "0.7" }, { model: MODEL }, { apiKey: "unused" }, { maxInputTokens: 8192 }, { provider: "openrouter" }, { unknown: true }]) {
    assert.throws(() => resolveConfig({ ...minimal, citation: invalid }), /config.citation/);
  }
});

for (const [name, setting, expectedLine] of [
  ["omitted", undefined, 1],
  ["empty settings", {}, 1],
  ["disabled", false, undefined],
  ["higher threshold", { threshold: 0.9 }, undefined],
] as const) {
  test(`CLI citation ${name}`, async () => {
    const sent = stub({ answers: { f0: { probabilities: { none: 0.1, line_1: 0.8, line_2: 0.1 } } } });
    const config = {
      model: MODEL, citation: setting, files: ["*.py"], suites: { api: { rules: {
        query: { prompt: "Q?", values: [{ value: "TRUE", report: "Fix." }, { value: "FALSE" }] },
      } } },
    };
    const cwd = await tree({ "decision-model-linter.config.ts": `export default ${JSON.stringify(config)};`, "a.py": source });
    let output = "";
    const code = await main(["--format", "json", "a.py"], {
      cwd, write: (text) => { output += text; }, writeError: () => {},
      connect: () => new FakeModel(() => ({ type: "yesno", yes: 0.9 })),
    });
    const [result] = JSON.parse(output);
    assert.equal(code, 0);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].locations?.[0]?.line, expectedLine);
    assert.equal(sent.length, setting === false ? 0 : 1);
    if (setting === false) assert.equal(result.citation, undefined);
  });
}

test("CLI batches findings into one citation call and annotates their selected lines", async () => {
  const sent = stub({ answers: {
    f0: { probabilities: { none: 0.01, line_1: 0.98, line_2: 0.01 } },
    f1: { probabilities: { none: 0.01, line_1: 0.01, line_2: 0.98 } },
  } });
  const config = {
    model: { ...MODEL, name: "shared-model", url: "https://citation.example/decisions" }, citation, files: ["*.py"], suites: { api: { rules: {
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
  assert.equal(sent[0].url, "https://citation.example/decisions");
  assert.equal(sent[0].body.model, "shared-model");
  assert.deepEqual(Object.keys(sent[0].body.questions), ["f0", "f1"]);
  assert.match(output, /line=1,endLine=1,col=1,endColumn=22/);
  assert.match(output, /line=2,endLine=2,col=1,endColumn=22/);
});
