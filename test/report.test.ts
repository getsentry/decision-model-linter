import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { main } from "../src/cli.ts";
import type { CallResult } from "../src/evaluate.ts";
import { type CommentApi, upsertComment } from "../src/github.ts";
import { COMMENT_MARKER, cleanComment, describeUsage, exitCode, format, prComment, summary, usage } from "../src/report.ts";

function call(path: string, findings: Partial<CallResult["findings"][number]>[], error?: string): CallResult {
  return {
    suite: "api",
    path,
    entry: 0,
    mode: "file",
    fields: {},
    findings: findings.map((f) => ({
      suite: "api",
      path,
      field: "createsNewApiEndpoint",
      value: "TRUE",
      probability: 0.97,
      threshold: 0.7,
      severity: "warn",
      message: "Extend the existing operation.",
      ...f,
    })),
    truncated: false,
    shrunk: false,
    ...(error ? { error } : {}),
  };
}

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

test("github annotations escape workflow-command characters", () => {
  const output = format([call("a,b.py", [{ severity: "error", message: "100% sure:\nyes" }])], "github");
  assert.equal(
    output,
    "::error file=a%2Cb.py,title=decision-model-linter api/createsNewApiEndpoint::100%25 sure: yes\n" +
      "::notice title=decision-model-linter usage::1 call on 1 file, 0 input tokens, $0\n",
  );
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

test("files not fully checked are reported in every format instead of reading as clean", () => {
  const results = [call("a.py", [], "HTTP 500: boom"), { ...call("big.py", []), truncated: true }, call("ok.py", [])];

  const body = prComment(results);
  assert.ok(body?.startsWith(COMMENT_MARKER));
  assert.match(
    body!,
    /### Not fully checked\n\nFindings may be missing for these files:\n\n- `a\.py` \(api\): not checked: HTTP 500: boom\n- `big\.py` \(api\): too large for one call, so the end was not checked/,
  );
  assert.doesNotMatch(body!, /No findings/);

  const annotations = format(results, "github");
  assert.match(annotations, /^::warning file=a\.py,title=decision-model-linter api::not checked: HTTP 500: boom$/m);
  assert.match(annotations, /^::warning file=big\.py,title=decision-model-linter api::too large for one call, so the end was not checked$/m);

  assert.match(format(results, "stylish"), /^big\.py\n {2}warn {3}api: too large for one call/m);
});

test("exit codes", () => {
  assert.equal(exitCode([call("a.py", [{}])]), 0);
  assert.equal(exitCode([call("a.py", [{ severity: "error" }])]), 1);
  assert.equal(exitCode([call("a.py", [{ severity: "error" }]), call("b.py", [], "HTTP 500")]), 1);
  assert.equal(exitCode([call("b.py", [], "HTTP 500")]), 0);
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

test("CLI lints matching files and exits by severity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "decision-model-linter-"));
  await writeFile(join(cwd, "a.py"), "x");
  await writeFile(join(cwd, "skip.txt"), "x");
  await mkdir(join(cwd, "decision-model-linter"));
  await writeFile(
    join(cwd, "decision-model-linter", "api.ts"),
    `export default [{ files: ["*.py"], fields: { f: { prompt: "Q?", values: [{ value: "TRUE", severity: "error", report: "Fix." }, { value: "FALSE" }] } } }];\n`,
  );
  let output = "";
  const asked: string[] = [];
  const code = await main(["."], {
    cwd,
    env: {},
    write: (text) => (output += text),
    client: {
      async decide(state) {
        asked.push(state.path);
        return { answers: { f: { type: "noul", noul: 0.95 } }, durationMs: 1 };
      },
    },
  });
  assert.equal(code, 1);
  assert.deepEqual(asked, ["a.py"]);
  assert.match(output, /error {2}api\/f = TRUE \(0\.95\) {2}Fix\./);
  assert.match(output, /^decision-model-linter: 1 call on 1 file, /m);
});

test("CLI treats everything after -- as a path, even one that looks like an option", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "decision-model-linter-"));
  await writeFile(join(cwd, "--suites=elsewhere.py"), "x");
  await mkdir(join(cwd, "decision-model-linter"));
  await writeFile(
    join(cwd, "decision-model-linter", "api.ts"),
    `export default [{ files: ["*.py"], fields: { f: { prompt: "Q?", values: [{ value: "TRUE" }, { value: "FALSE" }] } } }];\n`,
  );
  const asked: string[] = [];
  const code = await main(["--", "--suites=elsewhere.py"], {
    cwd,
    env: {},
    write: () => {},
    client: {
      async decide(state) {
        asked.push(state.path);
        return { answers: { f: { type: "noul", noul: 0.1 } }, durationMs: 1 };
      },
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(asked, ["--suites=elsewhere.py"]);
});

test("usage names every model version that answered", () => {
  const results = [
    { ...call("a.py", []), inputTokens: 10, cost: 0.0001, model: "typesafe/jev-1.13-20260917" },
    { ...call("b.py", []), inputTokens: 10, cost: 0.0001, model: "typesafe/jev-1.13-20260917" },
  ];
  assert.match(describeUsage(usage(results)), /, model typesafe\/jev-1\.13-20260917$/);
});

test("CLI --model and --url choose the model and endpoint", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "decision-model-linter-"));
  await writeFile(join(cwd, "a.py"), "x");
  await mkdir(join(cwd, "decision-model-linter"));
  await writeFile(
    join(cwd, "decision-model-linter", "api.ts"),
    `export default [{ files: ["*.py"], fields: { f: { prompt: "Q?", values: [{ value: "TRUE" }, { value: "FALSE" }] } } }];\n`,
  );
  const sent: { url: string; model: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), model: JSON.parse(String(init?.body)).model });
    const body = { answers: { f: { type: "noul", noul: 0.1 } }, usage: { input_tokens: 5, output_tokens: 1, cost: 0.00001 }, model: "typesafe/jev-1.14-preview" };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  let output = "";
  try {
    const code = await main(["--model", "typesafe/jev-1.14", "--url", "https://jev.example/decisions", "a.py"], {
      cwd,
      env: { OPENROUTER_API_KEY: "key" },
      write: (text) => (output += text),
    });
    assert.equal(code, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(sent, [{ url: "https://jev.example/decisions", model: "typesafe/jev-1.14" }]);
  assert.match(output, /model typesafe\/jev-1\.14-preview/);
});

test("CLI reports a broken suite and exits 2", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "decision-model-linter-"));
  await mkdir(join(cwd, "decision-model-linter"));
  await writeFile(join(cwd, "decision-model-linter", "api.ts"), "export default [{ files: [] }];\n");
  let output = "";
  const code = await main([], { cwd, env: {}, write: (text) => (output += text) });
  assert.equal(code, 2);
  assert.match(output, /decision-model-linter suites: suite api: entry 0.files: must not be empty/);
});
