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
    return new Response(JSON.stringify(typeof output === "function" ? output(sent.at(-1)!.body) : output), { status });
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

function choiceStub(picks: Record<string, string>, overrides: Record<string, Record<string, number>> = {}) {
  return stub((body: { questions: Record<string, { criteria: Record<string, string | null> }> }) => ({
    answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, {
      probabilities: overrides[id] ?? Object.fromEntries(Object.keys(question.criteria).map((option) => [
        option, option === (picks[id] ?? Object.keys(question.criteria)[0]) ? 1 : 0,
      ])),
    }])),
  }));
}

const manyLines = Array.from({ length: 300 }, (_, i) => `value_${i + 1} = 1`).join("\n");

test("selects a real changed source line and emits a whole-line annotation", async () => {
  const sent = stub({ answers: { f0: { probabilities: { none: 0.05, L002: 0.95 } } }, usage: { input_tokens: 120, output_tokens: 20 } });
  const results = await run({ changed: new Set([2]) });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://openrouter.ai/api/alpha/decisions");
  assert.deepEqual(sent[0].body.state, { path: "a.py", content: "L001| (context) old = query.get('old')\nL002| (new) new = query.get('new')" });
  assert.deepEqual(sent[0].body.questions.f0.criteria, { none: "No source line supports the reported answer and finding.", L002: null });
  assert.match(sent[0].body.questions.f0.instructions, /Does this file read query parameters with query.get/);
  assert.deepEqual(results[0].findings[0].locations, [{ line: 2, endLine: 2, col: 1, endColumn: 22 }]);
  assert.deepEqual(results[0].citation, { calls: 1, inputTokens: 120, outputTokens: 20 });
  assert.match(format(results, "github"), /file=a.py,line=2,endLine=2,col=1,endColumn=22/);
  assert.match(format(results, "github"), /citation: 1 calls, 120 input tokens/);
  assert.equal(exitCode(results), 0);
});

test("blank and unchanged lines cannot be selected, and Unicode columns exclude CRLF", async () => {
  const sent = stub({ answers: { f0: { probabilities: { none: 0.01, L003: 0.99 } } } });
  const results = await run({ source: "old\r\n  \r\n😀 target😀\r\n", changed: new Set([2, 3]) });
  assert.deepEqual(Object.keys(sent[0].body.questions.f0.criteria), ["none", "L003"]);
  assert.equal(sent[0].body.state.content, "L001| (context) old\nL002| (context)   \nL003| (new) 😀 target😀");
  assert.deepEqual(results[0].findings[0].locations, [{ line: 3, endLine: 3, col: 1, endColumn: 9 }]);
});

test("254 eligible lines fit one question with bare ids", async () => {
  const sent = choiceStub({ f0: "L254" });
  const results = await run({ source: manyLines, changed: new Set(Array.from({ length: 254 }, (_, i) => i + 1)) });
  assert.deepEqual(Object.keys(sent[0].body.questions), ["f0"]);
  assert.equal(Object.keys(sent[0].body.questions.f0.criteria).length, 255);
  assert.equal(sent[0].body.questions.f0.criteria.L254, null);
  assert.equal(results[0].findings[0].locations?.[0]?.line, 254);
});

for (const line of [100, 101, 200, 201, 255]) {
  test(`255 eligible lines cite physical line ${line} through one ranged request`, async () => {
    const range = `W${Math.floor((line - 1) / 100)}`;
    const sent = choiceStub({ f0: range, [`f0_${range}`]: `L${String(line).padStart(3, "0")}` });
    const results = await run({ source: manyLines, changed: new Set(Array.from({ length: 255 }, (_, i) => i + 1)) });
    assert.equal(sent.length, 1);
    assert.deepEqual(Object.keys(sent[0].body.questions), ["f0", "f0_W0", "f0_W1", "f0_W2"]);
    assert.deepEqual(sent[0].body.questions.f0.criteria, {
      none: "No source line supports the reported answer and finding.",
      W0: "lines L001 to L100", W1: "lines L101 to L200", W2: "lines L201 to L300",
    });
    for (const question of Object.keys(sent[0].body.questions)) {
      assert.ok(Object.keys(sent[0].body.questions[question].criteria).length <= 255);
    }
    assert.equal(Object.keys(sent[0].body.questions.f0_W2.criteria).length, 55);
    assert.equal(sent[0].body.questions.f0_W0.criteria.L101, undefined);
    assert.equal(results[0].findings[0].locations?.[0]?.line, line);
    assert.equal(results[0].citation?.calls, 1);
  });
}

test("sparse diffs omit empty ranges and preserve physical line ids", async () => {
  const sent = choiceStub({ f0: "W5", f0_W5: "L501" });
  const results = await run({
    source: Array.from({ length: 501 }, () => "x").join("\n"),
    changed: new Set([...Array.from({ length: 255 }, (_, i) => i + 1), 501]),
  });
  assert.deepEqual(Object.keys(sent[0].body.questions.f0.criteria), ["none", "W0", "W1", "W2", "W5"]);
  assert.equal(sent[0].body.questions.f0_W5, undefined);
  assert.equal(sent[0].body.questions.f0_W3, undefined);
  assert.equal(results[0].findings[0].locations?.[0]?.line, 501);
});

test("range questions can distinguish changed evidence from unchanged evidence", async () => {
  const source = Array.from({ length: 300 }, (_, i) => [49, 249].includes(i) ? "print(42)" : "x = 1").join("\n");
  const roots: unknown[] = [];
  for (const line of [50, 250]) {
    const id = `L${String(line).padStart(3, "0")}`;
    const range = line === 50 ? "W0" : "W2";
    const sent = choiceStub({ f0: range, [`f0_${range}`]: id });
    const changed = new Set(Array.from({ length: 300 }, (_, i) => i + 1).filter((n) => n !== (line === 50 ? 250 : 50)));
    const results = await run({ source, changed });
    const { state, questions } = sent[0].body;
    roots.push({ state, question: questions.f0 });
    assert.equal(state.content.split("\n")[line - 1], `${id}| (new) print(42)`);
    assert.match(questions.f0.instructions, /Only lines marked \(new\)/);
    assert.equal(results[0].findings[0].locations?.[0]?.line, line);
  }
  assert.notDeepEqual(roots[0], roots[1]);
});

test("a singleton final range resolves without a child question", async () => {
  const sent = choiceStub({ f0: "W3" });
  const results = await run({ source: `${manyLines}\nlast = 1` });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.questions.f0_W3, undefined);
  assert.equal(results[0].findings[0].locations?.[0]?.line, 301);
});

test("joint confidence includes the exact decimal threshold", async () => {
  for (const [range, line, threshold, expected] of [
    [0.7, 0.7, 0.49, 101],
    [0.7, 0.7, 0.49000000000000005, undefined],
    [0.75, 0.75, 0.5625000000000001, undefined],
    [0.74, 0.96, 0.7104, 101],
    [0.7000000000000001, 0.8, 0.5600000000000002, undefined],
    [0.7, 0.7, 1e-7, 101],
    [1, 0.7, 0.7000000000000001, undefined],
    [0.7, 1, 0.7000000000000001, undefined],
  ] as const) {
    const child = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`L${101 + i}`, 0]));
    Object.assign(child, { L101: line, L102: 1 - line });
    choiceStub({}, { f0: { none: 1 - range, W0: 0, W1: range, W2: 0 }, f0_W1: child });
    const results = await run({ source: manyLines, citation: { threshold } });
    assert.equal(results[0].findings[0].locations?.[0]?.line, expected, `${range} * ${line} at ${threshold}`);
  }
});

test("literal source markers cannot impersonate changed evidence", async () => {
  const source = Array.from({ length: 300 }, (_, i) => i === 49 ? "(new) risky()" : i === 249 ? "risky()" : "safe()").join("\n");
  stub((body: { state: { content: string }; questions: Record<string, { criteria: Record<string, unknown> }> }) => {
    const id = body.state.content.split("\n").find((line) => /^L\d+\| \(new\) risky\(\)$/.test(line))!.split("|")[0];
    const range = `W${Math.floor((Number(id.slice(1)) - 1) / 100)}`;
    return { answers: Object.fromEntries(Object.entries(body.questions).map(([key, question]) => {
      const pick = key === "f0" ? range : Object.hasOwn(question.criteria, id) ? id : Object.keys(question.criteria)[0];
      return [key, { probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, Number(option === pick)])) }];
    })) };
  });
  const changed = new Set(Array.from({ length: 300 }, (_, i) => i + 1).filter((line) => line !== 50));
  const results = await run({ source, changed });
  assert.equal(results[0].findings[0].locations?.[0]?.line, 250);
});

test("direct and singleton probabilities strictly below the threshold remain file-level", async () => {
  for (const probability of [0.7, 1 - Number.EPSILON / 2]) {
    const threshold = probability === 0.7 ? 0.7000000000000001 : 1;
    choiceStub({}, { f0: { none: 1 - probability, L001: probability, L002: 0 } });
    const direct = await run({ citation: { threshold } });
    assert.equal(direct[0].findings[0].locations, undefined);
    choiceStub({}, { f0: { none: 1 - probability, W0: 0, W1: 0, W2: 0, W3: probability } });
    const singleton = await run({ source: `${manyLines}\nlast = 1`, citation: { threshold } });
    assert.equal(singleton[0].findings[0].locations, undefined);
  }
});

for (const [name, root, child, threshold] of [
  ["no supporting range", { none: 1, W0: 0, W1: 0, W2: 0 }, undefined, 0.7],
  ["tied ranges", { none: 0, W0: 0.5, W1: 0.5, W2: 0 }, undefined, 0.4],
  ["unknown range", { none: 0, W0: 0, W9: 1, W2: 0 }, undefined, 0.7],
  ["unnormalized range", { none: 0, W0: 0, W1: 0.9, W2: 0 }, undefined, 0.7],
  ["joint confidence below threshold", { none: 0.2, W0: 0, W1: 0.8, W2: 0 }, { L101: 0.8, L102: 0.2 }, 0.7],
  ["unknown line in chosen range", { none: 0, W0: 0, W1: 1, W2: 0 }, { L001: 1 }, 0.7],
  ["tied lines in chosen range", { none: 0, W0: 0, W1: 1, W2: 0 }, { L101: 0.5, L102: 0.5 }, 0.4],
] as const) {
  test(`${name} retains a ranged finding at file level`, async () => {
    const probabilities: Record<string, number> = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`L${101 + i}`, 0]));
    if (child && "L001" in child) delete probabilities.L101;
    Object.assign(probabilities, child);
    choiceStub({ f0: "W1", f0_W1: "L101" }, { f0: root, ...(child ? { f0_W1: probabilities } : {}) });
    const results = await run({ source: manyLines, citation: { threshold } });
    assert.equal(results[0].findings.length, 1);
    assert.equal(results[0].findings[0].locations, undefined);
    assert.equal(results[0].unchecked, undefined);
  });
}

test("ranged findings select their own windows and ignore unused malformed distributions", async () => {
  const sent = choiceStub({ f0: "W0", f0_W0: "L100", f1: "W2", f1_W2: "L201" }, { f0_W2: {} });
  const cwd = await tree({ "a.py": manyLines });
  const results = await lint([rule("first"), rule("second")], ["a.py"], {
    cwd, connect: () => new FakeModel(() => ({ type: "yesno", yes: 0.9 })), citation,
  });
  assert.equal(sent.length, 1);
  assert.equal(Object.keys(sent[0].body.questions).length, 8);
  assert.deepEqual(results[0].findings.map((finding) => finding.locations?.[0]?.line), [100, 201]);
});

test("tagged source and every range question count toward the citation budget", async () => {
  const sent = choiceStub({ f0: "W1", f0_W1: "L101" });
  await run({ source: manyLines });
  const { state, questions } = sent[0].body;
  const length = JSON.stringify(state).length + JSON.stringify(questions).length + 512;
  const model = { ...MODEL, maxInputTokens: Math.floor(length / 3) - 1 };
  assert.ok(JSON.stringify({ path: "a.py", content: manyLines }).length + JSON.stringify(questions).length + 512 < model.maxInputTokens * 3);
  const results = await run({ source: manyLines, model });
  assert.equal(sent.length, 1);
  assert.equal(results[0].citation?.calls, 0);
  assert.match(results[0].citation!.error!, /budget/);
  assert.equal(results[0].findings[0].locations, undefined);
});

test("range selectors respect the 255-option limit even with sparse changed lines", async () => {
  const sent = choiceStub({ f0: "W253", f0_W253: "L25301" });
  const source = Array.from({ length: 25_401 }, () => "x").join("\n");
  const changed = new Set([2, ...Array.from({ length: 254 }, (_, i) => i * 100 + 1)]);
  const model = { ...MODEL, maxInputTokens: 1_000_000 };
  const allowed = await run({ source, changed, model });
  assert.equal(sent.length, 1);
  assert.equal(Object.keys(sent[0].body.questions.f0.criteria).length, 255);
  assert.equal(allowed[0].findings[0].locations?.[0]?.line, 25_301);
  changed.add(25_401);
  const skipped = await run({ source, changed, model });
  assert.equal(sent.length, 1);
  assert.deepEqual(skipped[0].citation, { calls: 0, error: "source exceeds the citation range option limit; retaining file-level findings" });
  assert.equal(skipped[0].findings[0].locations, undefined);
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
  ["no evidence", { none: 0.9, L001: 0.05, L002: 0.05 }],
  ["low probability", { none: 0.2, L001: 0.4, L002: 0.4 }],
  ["unknown line", { none: 0.05, L001: 0.05, L050: 0.9 }],
  ["missing probability", { L001: 0.9 }],
  ["negative probability", { none: -0.1, L001: 0.95, L002: 0.15 }],
  ["probability over one", { none: 0, L001: 1.1, L002: 0 }],
  ["non-numeric probability", { none: 0, L001: "0.9", L002: 0.1 }],
  ["null probability", { none: 0, L001: null, L002: 0.9 }],
  ["empty probabilities", {}],
  ["overfull probabilities", { none: 0.8, L001: 0.9, L002: 0.7 }],
  ["underfull probabilities", { none: 0, L001: 0.75, L002: 0 }],
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
  stub({ answers: { f0: { probabilities: { none: 0.0333333, L001: 0.9333333, L002: 0.0333333 } } } });
  const results = await run();
  assert.equal(results[0].findings[0].locations?.[0]?.line, 1);
});

test("citation threshold is configurable independently of the decision threshold", async () => {
  stub({ answers: { f0: { probabilities: { none: 0.1, L001: 0.8, L002: 0.1 } } } });
  const defaultThreshold = await run({ citation: {} });
  assert.equal(defaultThreshold[0].findings[0].locations?.[0]?.line, 1);
  const higherThreshold = await run({ citation: { threshold: 0.9 } });
  assert.equal(higherThreshold[0].findings.length, 1);
  assert.equal(higherThreshold[0].findings[0].locations, undefined);
  assert.equal(higherThreshold[0].findings[0].threshold, 0.7);
});

test("citation reuses the resolved rule model, API key, and endpoint", async () => {
  const sent = stub({ answers: { f0: { probabilities: { none: 0.01, L001: 0.98, L002: 0.01 } } } });
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
        none: 0, L001: state.forbidden === "call_a" ? 1 : 0, L002: state.forbidden === "call_b" ? 1 : 0,
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
    f0: { probabilities: { none: 0.8, L001: 0.9, L002: 0.7 } },
    f1: { probabilities: { none: 0.01, L001: 0.01, L002: 0.98 } },
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
  stub({ answers: { f0: { probabilities: { none: 0, L001: 0.5, L002: 0.5 } } } });
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
    const sent = stub({ answers: { f0: { probabilities: { none: 0.1, L001: 0.8, L002: 0.1 } } } });
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
    f0: { probabilities: { none: 0.01, L001: 0.98, L002: 0.01 } },
    f1: { probabilities: { none: 0.01, L001: 0.01, L002: 0.98 } },
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
