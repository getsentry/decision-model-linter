import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

type Request = { state: { content: string }; questions: Record<string, { type: string; criteria?: Record<string, unknown> }> };
type Report = { dry: boolean; rows: { strategy: string; case: string; run: number; truth: number; o: {
  calls: number; plannedCalls: number; inputTokens: number; outputTokens: number; missingUsageCalls: number;
  cost?: number; missingCostCalls: number; flagged?: boolean; line?: number; citationError?: string; error?: string;
} }[]; summaries: { strategy: string; group: string; detection?: { falseNegatives: number; falsePositives: number }; errors: number; citationErrors: number; latencyMs: { samples: number } }[] };

async function run(args: string[], respond: (body: Request, index: number) => { status?: number; body: unknown }) {
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "citation-bench-"));
  const output = join(directory, "results.json");
  const requests: Request[] = [];
  let serverFailure: unknown;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body: Request = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    try {
      const answer = respond(body, requests.length - 1);
      response.writeHead(answer.status ?? 200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer.body));
    } catch (error) {
      serverFailure = error;
      response.writeHead(400).end();
    }
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const child = spawn(process.execPath, ["bench/citation-strategies.ts", ...args, "--output", output], {
      cwd, env: { ...process.env, OPENROUTER_API_KEY: "synthetic", DECISIONS_URL: `http://127.0.0.1:${address.port}` },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code] = await once(child, "close");
    if (serverFailure) throw serverFailure;
    const json = await readFile(output, "utf8").catch(() => undefined);
    return { code, stdout, stderr, requests, report: json ? JSON.parse(json) as Report : undefined };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

function reply(request: Request, flag = /print\(/.test(request.state.content), evidenceId?: string) {
  const lines = request.state.content.split("\n");
  const evidence = lines.find((line) => /^L\d+\| (?:\(new\) )?.*print\(/.test(line));
  const id = evidenceId ?? evidence?.split("|")[0];
  const line = id ? Number(id.slice(1)) : 0;
  return { body: {
    answers: Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
      if (question.type === "noul") return [key, { noul: flag ? 0.95 : 0.05 }];
      const criteria = question.criteria!;
      const pick = key === "window" ? `W${Math.floor((line - 1) / 100)}` : id;
      const selected = pick && Object.hasOwn(criteria, pick) ? pick : Object.hasOwn(criteria, "none") ? "none" : Object.keys(criteria)[0];
      return [key, { probabilities: Object.fromEntries(Object.keys(criteria).map((option) => [option, Number(option === selected)])) }];
    })),
    usage: { input_tokens: 100, output_tokens: 5, cost: 0.01 },
  } };
}

test("paired variants gate clean findings and alternate request order", async () => {
  const result = await run(["--only", "two-pass,combined", "--cases", "print,none-print", "--repeats", "2"], (request) => reply(request));
  assert.equal(result.code, 0, result.stderr);
  const rows = result.report!.rows;
  assert.deepEqual(rows.slice(0, 4).map((row) => row.strategy), ["two-pass", "combined", "combined", "two-pass"]);
  assert.equal(rows[4].strategy, "combined");
  assert.deepEqual(rows.filter((row) => row.case === "print").map((row) => [row.strategy, row.o.calls, row.o.line]), [
    ["two-pass", 2, 2], ["combined", 1, 2], ["combined", 1, 2], ["two-pass", 2, 2],
  ]);
  assert.ok(rows.filter((row) => row.case === "none-print").every((row) => row.o.calls === 1 && row.o.flagged === false && row.o.line === 0));
  assert.ok(rows.every((row) => row.o.inputTokens === row.o.calls * 100 && row.o.outputTokens === row.o.calls * 5 && row.o.cost === row.o.calls * 0.01));
});

test("clean two-pass trials do not build unsupported citation ranges", async () => {
  const result = await run(["--only", "two-pass", "--sizes", "26000", "--cases", "large-26000", "--repeats", "1"], (request) => reply(request, false));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.report!.rows.length, 2);
  assert.ok(result.report!.rows.every((row) => row.o.calls === 1 && row.o.flagged === false && !row.o.error));
});

test("historical strategies reject missing distributions rather than timing them as successes", async () => {
  const result = await run(["--only", "lines,digits", "--cases", "declaration", "--repeats", "1"], () => ({ body: { answers: {} } }));
  assert.equal(result.code, 1);
  assert.ok(result.report!.rows.every((row) => row.o.error));
  assert.ok(result.report!.summaries.every((summary) => summary.latencyMs.samples === 0));
});

test("a negative lint answer ignores a confident speculative citation", async () => {
  const result = await run(["--only", "combined", "--cases", "print", "--repeats", "1"], (request) => reply(request, false));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.report!.rows[0].o.line, 0);
  assert.equal(result.report!.rows[0].o.flagged, false);
  assert.equal(result.report!.summaries.find((summary) => summary.group === "all")!.detection?.falseNegatives, 1);
});

test("paired changeset questions share a filtered view and preserve original ids", async () => {
  const result = await run(["--only", "two-pass,combined", "--cases", "diff-", "--repeats", "1"], (request) => reply(request));
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.requests.every((request) => !request.state.content.includes("print('old')")));
  assert.ok(result.report!.rows.filter((row) => row.case === "diff-clean").every((row) => row.o.flagged === false));
  assert.ok(result.report!.rows.filter((row) => row.case === "diff-print").every((row) => row.o.line === 2));
});

test("combined requests keep range questions bounded and validate selected distributions", async () => {
  const result = await run(["--only", "combined", "--cases", "large-300", "--sizes", "300", "--repeats", "1"], (request) => {
    for (const question of Object.values(request.questions)) {
      if (question.criteria) assert.ok(Object.keys(question.criteria).length <= 255);
    }
    assert.ok(request.questions.window);
    const evidence = request.state.content.split("\n").find((line) => line.includes('const rows = await db.query("SELECT * FROM users WHERE email') || line.includes('console.log(`login ok for'));
    assert.ok(evidence);
    return reply(request, true, evidence.split("|")[0]);
  });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.report!.rows.every((row) => row.o.calls === 1 && row.o.line === row.truth));
  const malformed = await run(["--only", "combined", "--cases", "print", "--repeats", "1"], () => ({ body: { answers: { violation: { noul: 0.95 }, f0: { probabilities: { L002: 1 } } } } }));
  assert.equal(malformed.code, 1);
  assert.equal(malformed.report!.rows[0].o.flagged, true);
  assert.match(malformed.report!.rows[0].o.citationError!, /malformed/);
  assert.equal(malformed.report!.summaries[0].latencyMs.samples, 0);
});

test("end-to-end large fixtures are valid TypeScript with stable evidence positions", async () => {
  const result = await run(["--only", "combined", "--cases", "large-,edge-,none-250,none-1000", "--sizes", "2,60,250,1000,2000", "--repeats", "1"], (request) => reply(request, false));
  assert.equal(result.code, 0, result.stderr);
  const directory = await mkdtemp(join(tmpdir(), "citation-source-"));
  try {
    const paths: string[] = [];
    for (const [index, request] of result.requests.entries()) {
      const row = result.report!.rows[index];
      const lines = request.state.content.replace(/^L\d+\| /gm, "").split("\n");
      assert.equal(lines.length, Number(row.case.split("-")[1]));
      if (row.truth) assert.match(lines[row.truth - 1], /db\.query\(|console\.log\(/);
      const path = join(directory, `source-${index}.ts`);
      await writeFile(path, lines.join("\n"));
      paths.push(path);
    }
    const cwd = fileURLToPath(new URL("../", import.meta.url));
    execFileSync(join(cwd, "node_modules/.bin/tsc"), ["--ignoreConfig", "--noEmit", "--target", "es2024", "--lib", "es2024,dom", "--skipLibCheck", ...paths], { cwd, encoding: "utf8" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a failed second call retains detection and partial usage, without leaking provider details", async () => {
  const result = await run(["--only", "two-pass", "--cases", "print", "--repeats", "1"], (request, index) => index === 0 ? reply(request) : { status: 422, body: { error: "private source synthetic" } });
  assert.equal(result.code, 1);
  const row = result.report!.rows[0].o;
  assert.deepEqual([row.calls, row.flagged, row.inputTokens, row.outputTokens, row.cost, row.missingUsageCalls, row.missingCostCalls], [2, true, 100, 5, 0.01, 1, 1]);
  assert.match(row.citationError!, /request failed/);
  assert.doesNotMatch(JSON.stringify(result.report), /private source|synthetic/);
});

test("uncertain citations are valid model outcomes rather than fast API errors", async () => {
  const result = await run(["--only", "combined", "--cases", "print", "--repeats", "1"], () => ({ body: {
    answers: { violation: { noul: 0.95 }, f0: { probabilities: { none: 0, L001: 0.5, L002: 0.5 } } },
    usage: { input_tokens: 100, output_tokens: 5 },
  } }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.report!.rows[0].o.line, undefined);
  assert.equal(result.report!.rows[0].o.flagged, true);
  assert.equal(result.report!.rows[0].o.citationError, undefined);
  assert.equal(result.report!.summaries[0].latencyMs.samples, 1);
});

test("HTTP retries are included in request counts and missing usage", async () => {
  const result = await run(["--only", "combined", "--cases", "print", "--repeats", "1"], (request, index) => index === 0 ? { status: 429, body: {} } : reply(request));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.report!.rows[0].o.calls, 2);
  assert.equal(result.report!.rows[0].o.missingUsageCalls, 1);
});

test("dry runs have planned shapes rather than model results and invalid selectors fail", async () => {
  const dry = await run(["--dry", "--only", "two-pass,combined", "--cases", "print"], () => { throw new Error("dry run sent a request"); });
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(dry.report!.dry, true);
  assert.equal(dry.requests.length, 0);
  assert.deepEqual(dry.report!.rows.map((row) => [row.o.calls, row.o.plannedCalls]), [[0, 2], [0, 1]]);
  assert.deepEqual(dry.report!.summaries, []);
  const constrained = await run(["--dry", "--only", "digits-constrained", "--cases", "print"], () => { throw new Error("dry run sent a request"); });
  assert.equal(constrained.code, 0, constrained.stderr);
  assert.equal(constrained.report!.rows.length, 1);
  assert.equal(constrained.report!.rows[0].o.plannedCalls, 1);
  for (const args of [["--only", "typo"], ["--repeats", "0"], ["--sizes", "bad"], ["--cases", "missing-case"]]) {
    const invalid = await run(args, () => { throw new Error("invalid arguments sent a request"); });
    assert.notEqual(invalid.code, 0);
    assert.equal(invalid.requests.length, 0);
  }
});
