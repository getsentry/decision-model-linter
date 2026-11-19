import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { ModelError } from "../src/models.ts";
import { DECISIONS_URL, openRouter } from "../src/openrouter.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replaces fetch with one that records each request and returns `respond`'s response. */
function stubFetch(respond: () => Response): { url: string; headers: Headers; body: any }[] {
  const sent: { url: string; headers: Headers; body: any }[] = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return respond();
  };
  return sent;
}

test("questions are sent as nouls and choices, and answers come back in the engine's form", async () => {
  const sent = stubFetch(
    () =>
      new Response(
        JSON.stringify({
          answers: { flag: { noul: 0.8 }, kind: { choice: "A", probabilities: { A: 0.7, B: 0.3 } } },
          usage: { input_tokens: 50, output_tokens: 3, cost: 0.00002 },
          model: "test-model-2026",
        }),
      ),
  );
  const model = openRouter({ name: "test-model", apiKey: "test" });
  const decision = await model.decide(
    { path: "a.py", content: "x" },
    {
      flag: { type: "yesno", instructions: "Flag?", criteria: { yes: "it is", no: "it is not" } },
      kind: { type: "choice", instructions: "Kind?", options: { A: "first", B: "second" } },
    },
  );
  assert.equal(sent[0].url, DECISIONS_URL);
  assert.equal(sent[0].headers.get("authorization"), "Bearer test");
  assert.deepEqual(sent[0].body, {
    model: "test-model",
    state: { path: "a.py", content: "x" },
    questions: {
      flag: { type: "noul", instructions: "Flag?", criteria: { true: "it is", false: "it is not" } },
      kind: { type: "choice", instructions: "Kind?", criteria: { A: "first", B: "second" } },
    },
  });
  assert.deepEqual(decision.answers, {
    flag: { type: "yesno", yes: 0.8 },
    kind: { type: "choice", probabilities: { A: 0.7, B: 0.3 } },
  });
  assert.deepEqual([decision.inputTokens, decision.outputTokens, decision.cost, decision.model], [50, 3, 0.00002, "test-model-2026"]);
});

test("a url overrides the endpoint", async () => {
  const sent = stubFetch(() => new Response(JSON.stringify({ answers: { f: { noul: 0.1 } } })));
  await openRouter({ name: "test-model", apiKey: "test", url: "https://decisions.example/v1" }).decide(
    {},
    { f: { type: "yesno", instructions: "Q?" } },
  );
  assert.equal(sent[0].url, "https://decisions.example/v1");
});

test("max_tokens_exceeded is a too-large error, and is not retried", async () => {
  const sent = stubFetch(() => new Response('{"error":{"code":"max_tokens_exceeded"}}', { status: 400 }));
  await assert.rejects(
    openRouter({ name: "test-model", apiKey: "test" }).decide({}, { f: { type: "yesno", instructions: "Q?" } }),
    (error: unknown) => error instanceof ModelError && error.tooLarge,
  );
  assert.equal(sent.length, 1);
});

test("a missing answer is an error", async () => {
  stubFetch(() => new Response(JSON.stringify({ answers: {} })));
  await assert.rejects(
    openRouter({ name: "test-model", apiKey: "test" }).decide({}, { f: { type: "yesno", instructions: "Q?" } }),
    /no answer for: f/,
  );
});

test("an account error does not repeat the response, which names the workspace and key", async () => {
  const sent = stubFetch(
    () =>
      new Response(
        '{"error":{"message":"Key limit exceeded (total limit). Manage it using https://openrouter.ai/workspaces/some-workspace/keys/abc123","code":403}}',
        { status: 403 },
      ),
  );
  await assert.rejects(
    openRouter({ name: "test-model", apiKey: "test" }).decide({}, { f: { type: "yesno", instructions: "Q?" } }),
    (error: unknown) =>
      error instanceof ModelError &&
      error.message === "HTTP 403: OpenRouter refused the API key, such as for a spent key limit" &&
      !error.tooLarge,
  );
  assert.equal(sent.length, 1);
});

test("links are removed from other errors", async () => {
  stubFetch(() => new Response('{"error":{"message":"Bad request, see https://openrouter.ai/docs/x"}}', { status: 400 }));
  await assert.rejects(
    openRouter({ name: "test-model", apiKey: "test" }).decide({}, { f: { type: "yesno", instructions: "Q?" } }),
    (error: unknown) => error instanceof ModelError && /see <link removed>/.test(error.message) && !/openrouter\.ai/.test(error.message),
  );
});
