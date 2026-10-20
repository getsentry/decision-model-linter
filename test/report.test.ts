import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { main } from "../src/cli.ts";
import type { CallResult } from "../src/evaluate.ts";
import { describeUsage, exitCode, format, usage } from "../src/report.ts";
import { FakeModel, configSource, tree } from "./helpers.ts";

function call(path: string, findings: Partial<CallResult["findings"][number]>[], gap: Partial<CallResult> = {}): CallResult {
  return {
    suite: "api",
    path,
    rules: ["createsNewApiEndpoint"],
    mode: "file",
    answers: {},
    findings: findings.map((f) => ({
      suite: "api",
      path,
      rule: "createsNewApiEndpoint",
      value: "TRUE",
      probability: 0.97,
      threshold: 0.7,
      severity: "warn",
      message: "Extend the existing operation.",
      ...f,
    })),
    truncated: false,
    shrunk: false,
    provider: "openrouter",
    ...gap,
  };
}

const failed = (path: string, unchecked: "warn" | "error" = "warn") => call(path, [], { error: "HTTP 500: boom", unchecked });

test("stylish groups findings by file and counts them", () => {
  const output = format([call("b.py", [{ severity: "error", message: "Bad." }]), call("a.py", [{}]), call("c.py", [])], "stylish");
  assert.equal(
    output,
    [
      "a.py",
      "  warn   api/createsNewApiEndpoint = TRUE (0.97)  Extend the existing operation.",
      "",
      "b.py",
      "  error  api/createsNewApiEndpoint = TRUE (0.97)  Bad.",
      "",
      "✖ 2 problems (1 error, 1 warning)",
      "decision-model-linter: 3 calls on 3 files, 0 input tokens, $0",
      "",
    ].join("\n"),
  );
  assert.equal(format([call("c.py", [])], "stylish"), "decision-model-linter: 1 call on 1 file, 0 input tokens, $0\n");
});

test("usage adds up tokens and cost across calls", () => {
  const priced = { ...call("a.py", []), inputTokens: 9000, outputTokens: 40, cost: 0.00038 };
  const alsoPriced = { ...call("b.py", []), inputTokens: 812, outputTokens: 30, cost: 0.00003 };
  const unpriced = { ...call("b.py", []), suite: "security", inputTokens: 100, outputTokens: 5 };
  const results = [priced, alsoPriced, unpriced];
  const { cost, ...counts } = usage(results);
  assert.deepEqual(counts, { calls: 3, files: 2, inputTokens: 9912, outputTokens: 75, unpriced: 1, models: [] });
  assert.ok(Math.abs(cost - 0.00041) < 1e-12);
  assert.equal(describeUsage(usage(results)), "3 calls on 2 files, 9,912 input tokens, $0.00041, cost missing for 1");
});

test("usage names every model version that answered", () => {
  const results = [
    { ...call("a.py", []), inputTokens: 10, cost: 0.0001, model: "test-model-2026" },
    { ...call("b.py", []), inputTokens: 10, cost: 0.0001, model: "test-model-2026" },
  ];
  assert.match(describeUsage(usage(results)), /, model test-model-2026$/);
});

test("github annotations escape workflow-command characters", () => {
  const output = format([call("a,b.py", [{ severity: "error", message: "100% sure:\nyes" }])], "github");
  assert.equal(
    output,
    "::error file=a%2Cb.py,title=decision-model-linter api/createsNewApiEndpoint::100%25 sure: yes\n" +
      "::notice title=decision-model-linter usage::1 call on 1 file, 0 input tokens, $0\n",
  );
});

test("json names the provider and model, and every rule's probabilities", () => {
  const result = { ...call("a.py", []), answers: { createsNewApiEndpoint: { TRUE: 0.2, FALSE: 0.8 } }, model: "test-model-2026" };
  const [parsed] = JSON.parse(format([result], "json"));
  assert.deepEqual([parsed.provider, parsed.model, parsed.answers], ["openrouter", "test-model-2026", result.answers]);
});

test("markdown lists findings by suite and file, and is empty when there is nothing to report", () => {
  const body = format([call("a.py", [{}]), call("b.py", [])], "markdown");
  assert.match(body, /^## decision-model-linter\n\n### api\n\n\*\*`a.py`\*\*\n\n- \*\*warn\*\* `createsNewApiEndpoint = TRUE` \(0.97\): Extend the existing operation./);
  assert.ok(!body.includes("`b.py`"));
  assert.match(body, /<sub>decision-model-linter: 2 calls on 2 files, 0 input tokens, \$0<\/sub>\n$/);
  assert.equal(format([call("b.py", [])], "markdown"), "");
});

test("unchecked files are reported at their severity in every format instead of reading as clean", () => {
  const results = [failed("a.py"), call("big.py", [], { truncated: true, unchecked: "error" }), call("ok.py", [])];

  const body = format(results, "markdown");
  assert.match(
    body,
    /### Not fully checked\n\nFindings may be missing for these files:\n\n- \*\*warn\*\* `a\.py` \(api\): not checked: HTTP 500: boom\n- \*\*error\*\* `big\.py` \(api\): too large for one call, so the end was not checked/,
  );

  const annotations = format(results, "github");
  assert.match(annotations, /^::warning file=a\.py,title=decision-model-linter api::not checked: HTTP 500: boom$/m);
  assert.match(annotations, /^::error file=big\.py,title=decision-model-linter api::too large for one call, so the end was not checked$/m);

  const stylish = format(results, "stylish");
  assert.match(stylish, /^big\.py\n {2}error {2}api: too large for one call/m);
  assert.match(stylish, /✖ 2 problems \(1 error, 1 warning\)/);
});

test("exit codes", () => {
  assert.equal(exitCode([call("a.py", [{}])]), 0);
  assert.equal(exitCode([call("a.py", [{ severity: "error" }])]), 1);
  assert.equal(exitCode([failed("b.py")]), 0);
  assert.equal(exitCode([failed("b.py", "error")]), 1);
});

test("CLI lints matching files with the config and exits by severity", async () => {
  const cwd = await tree({ "a.py": "x", "skip.txt": "x", "decision-model-linter.config.ts": configSource() });
  let output = "";
  const client = new FakeModel(() => ({ type: "yesno", yes: 0.95 }));
  const code = await main(["."], { cwd, write: (text) => (output += text), writeError: (text) => (output += text), connect: () => client });
  assert.equal(code, 1);
  assert.deepEqual(client.calls.map((c) => c.state.path), ["a.py"]);
  assert.match(output, /error {2}api\/f = TRUE \(0\.95\) {2}Fix\./);
  assert.match(output, /^decision-model-linter: 1 call on 1 file, /m);
});

test("CLI --config points at a config anywhere", async () => {
  const cwd = await tree({ "a.py": "x", "lint/config.ts": configSource() });
  const client = new FakeModel();
  const code = await main(["--config", "lint/config.ts", "a.py"], { cwd, write: () => {}, writeError: () => {}, connect: () => client });
  assert.equal(code, 0);
  assert.equal(client.calls.length, 1);
});

test("CLI treats everything after -- as a path, even one that looks like an option", async () => {
  const cwd = await tree({ "--config=elsewhere.py": "x", "decision-model-linter.config.ts": configSource() });
  const client = new FakeModel();
  const code = await main(["--", "--config=elsewhere.py"], { cwd, write: () => {}, writeError: () => {}, connect: () => client });
  assert.equal(code, 0);
  assert.deepEqual(client.calls.map((c) => c.state.path), ["--config=elsewhere.py"]);
});

test("CLI sends the configured model name to the configured url", async () => {
  const config = configSource().replace(
    `name: "test-model", apiKey: "test", maxInputTokens: 32768`,
    `name: "test-model-2", apiKey: "test", maxInputTokens: 32768, url: "https://decisions.example/v1"`,
  );
  const cwd = await tree({ "a.py": "x", "decision-model-linter.config.ts": config });
  const sent: { url: string; model: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), model: JSON.parse(String(init?.body)).model });
    const body = { answers: { f: { noul: 0.1 } }, usage: { input_tokens: 5, output_tokens: 1, cost: 0.00001 }, model: "test-model-2-2026" };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  let output = "";
  try {
    assert.equal(await main(["a.py"], { cwd, write: (text) => (output += text), writeError: (text) => (output += text) }), 0);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(sent, [{ url: "https://decisions.example/v1", model: "test-model-2" }]);
  assert.match(output, /model test-model-2-2026/);
});

test("CLI exits 2 before any call when a selected rule's key is empty, naming the setting", async () => {
  const config = configSource().replace(`apiKey: "test"`, `apiKey: process.env.NOT_SET_ANYWHERE`);
  const cwd = await tree({ "a.py": "x", "decision-model-linter.config.ts": config });
  const client = new FakeModel();
  let output = "";
  const code = await main(["a.py"], { cwd, write: (text) => (output += text), writeError: (text) => (output += text), connect: () => client });
  assert.equal(code, 2);
  assert.equal(client.calls.length, 0);
  assert.match(output, /config\.model\.apiKey is empty/);
});

test("CLI reports a broken config and exits 2", async () => {
  const cwd = await tree({ "decision-model-linter.config.ts": "export default { suites: { api: { files: [] } } };\n" });
  let output = "";
  const code = await main([], { cwd, write: (text) => (output += text), writeError: (text) => (output += text) });
  assert.equal(code, 2);
  assert.match(output, /decision-model-linter config: suites\.api\.files: must not be empty/);
});

test("CLI exits 2 for an unknown suite", async () => {
  const cwd = await tree({ "decision-model-linter.config.ts": configSource() });
  let output = "";
  const code = await main(["--suite", "secrity"], { cwd, write: (text) => (output += text), writeError: (text) => (output += text) });
  assert.equal(code, 2);
  assert.match(output, /no suite named secrity/);
});

test("CLI writes setup errors to stderr and nothing to stdout", async () => {
  const cwd = await tree({ "decision-model-linter.config.ts": "export default { suites: { api: { files: [] } } };\n" });
  let out = "";
  let err = "";
  const code = await main(["--format", "markdown"], { cwd, write: (text) => (out += text), writeError: (text) => (err += text) });
  assert.equal(code, 2);
  assert.equal(out, "");
  assert.match(err, /decision-model-linter config: suites\.api\.files: must not be empty/);
});

test("CLI exits 2, not 1, when it crashes", async () => {
  const cwd = await tree({ "a.py": "x", "decision-model-linter.config.ts": configSource() });
  let err = "";
  const code = await main(["a.py"], {
    cwd,
    write: () => {
      throw new Error("stdout closed");
    },
    writeError: (text) => (err += text),
    connect: () => new FakeModel(() => ({ type: "yesno", yes: 0.95 })),
  });
  assert.equal(code, 2);
  assert.match(err, /decision-model-linter: Error: stdout closed/);
});
