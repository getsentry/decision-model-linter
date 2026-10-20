import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { main } from "../src/cli.ts";
import type { CallResult } from "../src/evaluate.ts";
import { type CommentApi, upsertComment } from "../src/github.ts";
import { COMMENT_MARKER, cleanComment, describeUsage, exitCode, format, prComment, summary, usage } from "../src/report.ts";
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
  assert.match(summary(results), /\| api \| 2 \| 9,812 \| \$0\.00041 \|\n\| security \| 1 \| 100 \| \$0 \|/);
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

test("PR comment lists findings by file, or is null when there are none", () => {
  const body = prComment([call("a.py", [{}]), call("b.py", [])]);
  assert.ok(body?.startsWith(COMMENT_MARKER));
  assert.match(body!, /### api\n\n\*\*`a.py`\*\*\n\n- \*\*warn\*\* `createsNewApiEndpoint = TRUE` \(0.97\): Extend the existing operation./);
  assert.ok(!body!.includes("`b.py`"));
  assert.match(body!, /<sub>decision-model-linter on this commit: 2 calls on 2 files, 0 input tokens, \$0<\/sub>\n$/);
  assert.equal(prComment([call("b.py", [])]), null);
  assert.match(cleanComment([call("b.py", [])]), /No findings on the latest commit\.\n\n<sub>decision-model-linter on this commit: 1 call/);
});

test("unchecked files are reported at their severity in every format instead of reading as clean", () => {
  const results = [failed("a.py"), call("big.py", [], { truncated: true, unchecked: "error" }), call("ok.py", [])];

  const body = prComment(results);
  assert.ok(body?.startsWith(COMMENT_MARKER));
  assert.match(
    body!,
    /### Not fully checked\n\nFindings may be missing for these files:\n\n- \*\*warn\*\* `a\.py` \(api\): not checked: HTTP 500: boom\n- \*\*error\*\* `big\.py` \(api\): too large for one call, so the end was not checked/,
  );
  assert.doesNotMatch(body!, /No findings/);

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

class FakeComments implements CommentApi {
  existing: number | null;
  actions: [string, number, string][] = [];

  constructor(existing: number | null) {
    this.existing = existing;
  }
  async findComment() {
    return this.existing;
  }
  async createComment(pr: number, body: string) {
    this.actions.push(["create", pr, body]);
  }
  async updateComment(id: number, body: string) {
    this.actions.push(["update", id, body]);
  }
}

test("PR comment lifecycle", async () => {
  const first = new FakeComments(null);
  assert.equal(await upsertComment(first, 7, "findings", "clean"), "created");
  assert.deepEqual(first.actions, [["create", 7, "findings"]]);

  const later = new FakeComments(42);
  assert.equal(await upsertComment(later, 7, "new findings", "clean"), "updated");
  assert.deepEqual(later.actions, [["update", 42, "new findings"]]);

  const resolved = new FakeComments(42);
  assert.equal(await upsertComment(resolved, 7, null, "clean"), "cleared");
  assert.deepEqual(resolved.actions, [["update", 42, "clean"]]);

  const clean = new FakeComments(null);
  assert.equal(await upsertComment(clean, 7, null, "clean"), "none");
  assert.deepEqual(clean.actions, []);
});

test("CLI lints matching files with the config and exits by severity", async () => {
  const cwd = await tree({ "a.py": "x", "skip.txt": "x", "decision-model-linter.config.ts": configSource() });
  let output = "";
  const client = new FakeModel(() => ({ type: "yesno", yes: 0.95 }));
  const code = await main(["."], { cwd, env: {}, write: (text) => (output += text), connect: () => client });
  assert.equal(code, 1);
  assert.deepEqual(client.calls.map((c) => c.state.path), ["a.py"]);
  assert.match(output, /error {2}api\/f = TRUE \(0\.95\) {2}Fix\./);
  assert.match(output, /^decision-model-linter: 1 call on 1 file, /m);
});

test("CLI --config points at a config anywhere", async () => {
  const cwd = await tree({ "a.py": "x", "lint/config.ts": configSource() });
  const client = new FakeModel();
  const code = await main(["--config", "lint/config.ts", "a.py"], { cwd, env: {}, write: () => {}, connect: () => client });
  assert.equal(code, 0);
  assert.equal(client.calls.length, 1);
});

test("CLI treats everything after -- as a path, even one that looks like an option", async () => {
  const cwd = await tree({ "--config=elsewhere.py": "x", "decision-model-linter.config.ts": configSource() });
  const client = new FakeModel();
  const code = await main(["--", "--config=elsewhere.py"], { cwd, env: {}, write: () => {}, connect: () => client });
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
    assert.equal(await main(["a.py"], { cwd, env: {}, write: (text) => (output += text) }), 0);
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
  const code = await main(["a.py"], { cwd, env: {}, write: (text) => (output += text), connect: () => client });
  assert.equal(code, 2);
  assert.equal(client.calls.length, 0);
  assert.match(output, /config\.model\.apiKey is empty/);
});

test("CLI reports a broken config and exits 2", async () => {
  const cwd = await tree({ "decision-model-linter.config.ts": "export default { suites: { api: { files: [] } } };\n" });
  let output = "";
  const code = await main([], { cwd, env: {}, write: (text) => (output += text) });
  assert.equal(code, 2);
  assert.match(output, /decision-model-linter config: suites\.api\.files: must not be empty/);
});

test("CLI exits 2 for an unknown suite", async () => {
  const cwd = await tree({ "decision-model-linter.config.ts": configSource() });
  let output = "";
  const code = await main(["--suite", "secrity"], { cwd, env: {}, write: (text) => (output += text) });
  assert.equal(code, 2);
  assert.match(output, /no suite named secrity/);
});

test("CLI refuses pull_request_target before loading the config", async () => {
  const cwd = await tree({ "decision-model-linter.config.ts": "throw new Error('the config must not load');\n" });
  let output = "";
  const code = await main([], { cwd, env: { GITHUB_EVENT_NAME: "pull_request_target" }, write: (text) => (output += text) });
  assert.equal(code, 2);
  assert.match(output, /refusing to run on pull_request_target/);
});

test("CLI appends the job summary when GITHUB_STEP_SUMMARY is set", async () => {
  const cwd = await tree({ "a.py": "x", "decision-model-linter.config.ts": configSource() });
  const summaryPath = join(cwd, "summary.md");
  await writeFile(summaryPath, "");
  await main(["a.py"], { cwd, env: { GITHUB_STEP_SUMMARY: summaryPath }, write: () => {}, connect: () => new FakeModel() });
  assert.match(await readFile(summaryPath, "utf8"), /### decision-model-linter\n\n1 call on 1 file/);
});

test("a failing run's comment says how the override label applies, and agents should not use it", () => {
  const failing = [call("a.py", [{ severity: "error" }])];
  const blocked = prComment(failing, { label: "Override lint", applied: false })!;
  assert.match(blocked, /### Failing the check\n\nThese errors fail the check; fix the code to resolve them\./);
  assert.match(blocked, /a person can add the `Override lint` label to pass the check/);
  assert.match(blocked, /Agents should never add this label\./);
  assert.match(format(failing, "github", { label: "Override lint", applied: false }), /^::notice title=decision-model-linter override::These errors fail the check/m);

  const overridden = prComment(failing, { label: "Override lint", applied: true })!;
  assert.match(overridden, /### Overridden\n\nThe `Override lint` label keeps these errors from failing the check\./);

  assert.doesNotMatch(prComment([call("a.py", [{}])], { label: "Override lint", applied: false })!, /Failing the check/);
  assert.doesNotMatch(prComment(failing)!, /Failing the check|Overridden/);
});

test("CLI passes a failing run when the pull request has the override label", async () => {
  const config = configSource().replace("suites:", 'overrideLabel: "Override lint",\n  suites:');
  const event = (labels: string[]) => JSON.stringify({ pull_request: { number: 7, labels: labels.map((name) => ({ name })) } });
  const cwd = await tree({ "a.py": "x", "decision-model-linter.config.ts": config, "labeled.json": event(["Override lint"]), "plain.json": event(["other"]) });
  const run = async (eventFile: string) => {
    let output = "";
    const code = await main(["--format", "github", "a.py"], {
      cwd,
      env: { GITHUB_EVENT_PATH: join(cwd, eventFile) },
      write: (text) => (output += text),
      connect: () => new FakeModel(() => ({ type: "yesno", yes: 0.95 })),
    });
    return { code, output };
  };
  const plain = await run("plain.json");
  assert.equal(plain.code, 1);
  assert.match(plain.output, /add the `Override lint` label/);
  const labeled = await run("labeled.json");
  assert.equal(labeled.code, 0);
  assert.match(labeled.output, /^::error file=a\.py/m);
  assert.match(labeled.output, /The `Override lint` label keeps these errors from failing the check/);
});
