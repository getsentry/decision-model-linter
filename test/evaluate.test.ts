import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { Entry, Suite } from "../src/suites.ts";
import { WHOLE_FILE_INSTRUCTIONS, lint } from "../src/evaluate.ts";
import { type Answer, type Decision, type JevClient, type Question, type State, JevError } from "../src/jev.ts";

const suite = (entries: Entry[]): Suite[] => [{ name: "api", entries }];

class FakeJev implements JevClient {
  calls: { state: State; questions: Record<string, Question> }[] = [];
  answer: (id: string, question: Question, attempt: number) => Answer;

  constructor(answer: (id: string, question: Question, attempt: number) => Answer) {
    this.answer = answer;
  }

  async decide(state: State, questions: Record<string, Question>): Promise<Decision> {
    this.calls.push({ state, questions });
    const attempt = this.calls.length;
    const answers = Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, this.answer(id, q, attempt)]));
    return { answers, inputTokens: 10, outputTokens: 2, cost: 0.001, durationMs: 5 };
  }
}

async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "decision-model-linter-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const booleanField = {
  prompt: "Defines endpoints?",
  values: [{ value: "TRUE", severity: "warn" as const, report: "Extend instead." }, { value: "FALSE" }],
};

test("one call per file per matching entry, with the entry's fields as questions", async () => {
  const cwd = await tree({ "src/a/endpoints/x.py": "x", "src/a/other.py": "y", "src/a/tests/t.py": "t" });
  const config: Entry[] = [
    { files: ["src/**/endpoints/**/*.py"], fields: { createsNewApiEndpoint: booleanField } },
    { files: ["src/**/*.py"], ignores: ["**/tests/**"], fields: { omits: booleanField } },
  ];
  const client = new FakeJev(() => ({ type: "noul", noul: 0.1 }));
  const results = await lint(suite(config), ["src/a/endpoints/x.py", "src/a/other.py", "src/a/tests/t.py"], { cwd, client });
  assert.deepEqual(
    results.map((r) => [r.path, r.entry]),
    [
      ["src/a/endpoints/x.py", 0],
      ["src/a/endpoints/x.py", 1],
      ["src/a/other.py", 1],
    ],
  );
  // Calls run concurrently, so find the endpoint entry's call by its question.
  const endpointCall = client.calls.find((c) => "createsNewApiEndpoint" in c.questions)!;
  assert.deepEqual(endpointCall.state, { path: "src/a/endpoints/x.py", content: "1\tx\n" });
  assert.deepEqual(Object.keys(endpointCall.questions), ["createsNewApiEndpoint"]);
});

test("TRUE/FALSE fields are nouls; other fields are choices", async () => {
  const cwd = await tree({ "a.py": "x" });
  const config: Entry[] = [
    {
      files: ["*.py"],
      fields: {
        flag: { prompt: "Flag?", values: [{ value: "TRUE", description: "it is" }, { value: "FALSE" }] },
        plain: { prompt: "Plain?", values: [{ value: "TRUE" }, { value: "FALSE" }] },
        dup: {
          prompt: "Duplicate?",
          values: [{ value: "YES", description: "same as one" }, { value: "NO" }, { value: "NO_ENDPOINTS" }],
        },
      },
    },
  ];
  const client = new FakeJev((_, q) =>
    q.type === "noul"
      ? { type: "noul", noul: 0.9 }
      : { type: "choice", choice: "NO", probabilities: { YES: 0.1, NO: 0.8, NO_ENDPOINTS: 0.1 } },
  );
  const [result] = await lint(suite(config), ["a.py"], { cwd, client });
  const questions = client.calls[0].questions;
  const asked = (prompt: string) => `${WHOLE_FILE_INSTRUCTIONS}\n\nQuestion: ${prompt}`;
  assert.deepEqual(questions.flag, {
    type: "noul",
    instructions: asked("Flag?"),
    criteria: { true: "it is", false: "FALSE" },
  });
  assert.deepEqual(questions.plain, { type: "noul", instructions: asked("Plain?") });
  assert.deepEqual(questions.dup, {
    type: "choice",
    instructions: asked("Duplicate?"),
    criteria: { YES: "same as one", NO: "NO", NO_ENDPOINTS: "NO_ENDPOINTS" },
  });
  assert.equal(result.fields.flag.TRUE, 0.9);
  assert.ok(Math.abs(result.fields.flag.FALSE - 0.1) < 1e-9);
  assert.deepEqual(result.fields.dup, { YES: 0.1, NO: 0.8, NO_ENDPOINTS: 0.1 });
});

test("a reporting value at or above its threshold is a finding", async () => {
  const cwd = await tree({ "a.py": "x" });
  const config: Entry[] = [
    {
      files: ["*.py"],
      fields: {
        high: booleanField,
        low: booleanField,
        negative: {
          prompt: "Paginates?",
          values: [{ value: "TRUE" }, { value: "FALSE", severity: "error", report: "Paginate.", threshold: 0.6 }],
        },
      },
    },
  ];
  const noul: Record<string, number> = { high: 0.97, low: 0.6, negative: 0.3 };
  const [result] = await lint(suite(config), ["a.py"], { cwd, client: new FakeJev((id) => ({ type: "noul", noul: noul[id] })) });
  assert.deepEqual(
    result.findings.map((f) => [f.field, f.value, f.severity, f.message]),
    [
      ["high", "TRUE", "warn", "Extend instead."],
      ["negative", "FALSE", "error", "Paginate."],
    ],
  );
});

test("context functions run once and their results are in every call's state", async () => {
  const cwd = await tree({ "a.py": "1", "b.py": "2", "c.py": "3" });
  let runs = 0;
  const config: Entry[] = [
    {
      files: ["*.py"],
      context: { operations: async () => `ops ${++runs}`, note: "static" },
      fields: { f: booleanField },
    },
  ];
  const client = new FakeJev(() => ({ type: "noul", noul: 0.1 }));
  await lint(suite(config), ["a.py", "b.py", "c.py"], { cwd, client });
  assert.equal(runs, 1);
  for (const call of client.calls) {
    assert.equal(call.state.operations, "ops 1");
    assert.equal(call.state.note, "static");
  }
});

test("content over the budget is truncated with a marker", async () => {
  const cwd = await tree({ "big.py": "line\n".repeat(5000) });
  const config: Entry[] = [{ files: ["*.py"], fields: { f: booleanField } }];
  const client = new FakeJev(() => ({ type: "noul", noul: 0.1 }));
  const [result] = await lint(suite(config), ["big.py"], { cwd, client, callTokenLimit: 500 });
  assert.ok(result.truncated);
  assert.match(client.calls[0].state.content, /\[decision-model-linter: truncated, \d+ of \d+ characters omitted\]\n$/);
  assert.ok(client.calls[0].state.content.length < 1500);
});

test("a call rejected as too large is retried once at half the budget", async () => {
  const cwd = await tree({ "big.py": "line\n".repeat(5000) });
  const config: Entry[] = [{ files: ["*.py"], fields: { f: booleanField } }];
  const client = new FakeJev((_, __, attempt) => {
    if (attempt === 1) throw new JevError("HTTP 400: max_tokens_exceeded", true);
    return { type: "noul", noul: 0.9 };
  });
  const [result] = await lint(suite(config), ["big.py"], { cwd, client, callTokenLimit: 2000 });
  assert.ok(result.shrunk);
  assert.equal(result.error, undefined);
  assert.ok(client.calls[1].state.content.length < client.calls[0].state.content.length);
});

test("a failed call is reported without stopping the others", async () => {
  const cwd = await tree({ "a.py": "1", "b.py": "2" });
  const config: Entry[] = [{ files: ["*.py"], fields: { f: booleanField } }];
  const client = new FakeJev(() => ({ type: "noul", noul: 0.9 }));
  const failing: JevClient = {
    decide: (state, questions) =>
      state.path === "a.py" ? Promise.reject(new JevError("HTTP 500: boom")) : client.decide(state, questions),
  };
  const results = await lint(suite(config), ["a.py", "b.py"], { cwd, client: failing });
  assert.equal(results[0].error, "HTTP 500: boom");
  assert.equal(results[1].findings.length, 1);
});
