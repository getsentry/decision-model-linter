// Compares ways to cite a source line for a lint finding through the decisions API.
//
//   lines           PR #6 as written: one Choice whose options are `line_N: "Line N: <text>"` (+ none).
//   lines-windowed  lines, past the option limit: the same options in overlapping blocks (1-110, 100-210, ...).
//   digits          Content tagged `0042| ...`; one Choice per digit of the line number, options 0-9.
//                   Decoded greedily (argmax per digit) and constrained (best product over real lines).
//   ids             TypeSafe's line-search recipe: content tagged `L0042| ...`, options are bare ids with
//                   no description (+ none). Over 254 lines it fans out in one request: a
//                   window question plus one id question per 100-line window; read the chosen window's.
//   two-pass        End-to-end lint detection, followed by ids citation only when the rule flags.
//   combined        The same detection and speculative citation questions in one request.
// The unsupported cases (none-*) have no line behind the finding: the right answer is none.
//
// Usage:
//   node bench/citation-strategies.ts --dry                # request sizes only, no API calls
//   OPENROUTER_API_KEY=... node bench/citation-strategies.ts [--repeats 3] [--only digits,ids] [--cases none,edge]
//   MODEL=typesafe/jev-1.13 DECISIONS_URL=https://openrouter.ai/api/alpha/decisions (defaults)
//   OPENROUTER_API_KEY=... node bench/citation-strategies.ts --only two-pass,combined --repeats 5 --output results.json
// In GitHub Actions the output is also written to the job summary.
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collapseHiddenLines, linesToShow } from "../src/changed-lines.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing value for --${name}`);
  return args[i + 1];
};
const DRY = flag("dry");
const REPEATS = Number(option("repeats", "3"));
const ONLY = option("only", "lines,digits,ids").split(",");
const SIZES = option("sizes", "60,250,1000,2000").split(",").map(Number);
const CASE_PREFIXES = option("cases", "").split(",").filter(Boolean);
const MODEL = process.env.MODEL ?? "typesafe/jev-1.13";
const URL = process.env.DECISIONS_URL ?? "https://openrouter.ai/api/alpha/decisions";
const KEY = process.env.OPENROUTER_API_KEY ?? "";
const THRESHOLD = 0.7;
const MAX_OPTIONS = 255;
const WINDOW = 100;
const OVERLAP = 10;
const OUTPUT = option("output", "");
const NONE = 0; // the "line" of an unsupported finding, and what a strategy returns when it picks none
const NONE_OPTION = "No source line supports the reported answer and finding.";
const NONE_HINT = "Select none if the finding is unsupported.";
if (!DRY && !KEY.trim()) throw new Error("Set OPENROUTER_API_KEY, or pass --dry");
if (!Number.isInteger(REPEATS) || REPEATS < 1) throw new Error("--repeats must be a positive integer");
if (!SIZES.length || SIZES.some((size) => !Number.isInteger(size) || size < 2)) throw new Error("--sizes must list integers of at least 2");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dry") continue;
  if (!["--repeats", "--only", "--sizes", "--cases", "--output"].includes(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
  i++;
}

type Probabilities = Record<string, number>;
type Answers = Record<string, { probabilities?: Probabilities; noul?: number }>;
type Choice = { type: "choice"; instructions: string; criteria: Record<string, string | null> };
interface Case { name: string; path: string; source: string; line: number; prompt: string; value: string; message: string; changed?: number[] }
interface Outcome { line?: number; probability?: number; flagged?: boolean; decisionProbability?: number; citationError?: string; error?: string; calls: number; inputTokens: number; bytes: number; ms: number; extra?: string }
const newMeter = () => ({ calls: 0, plannedCalls: 0, bytes: 0, plannedBytes: 0, inputTokens: 0, outputTokens: 0, usageCalls: 0, cost: 0, costCalls: 0 });
let meter = newMeter();

// ---------- fixtures ----------
const SMALL: Case[] = [
  { name: "declaration", path: "a.py", source: "def greet(name):\n    return name\n", line: 1, prompt: "Does the code define a function without a return type annotation?", value: "TRUE", message: "Add a return type annotation." },
  { name: "print", path: "a.py", source: "def greet(name):\n    print(name)\n", line: 2, prompt: "Does the code call print?", value: "TRUE", message: "Remove the print call." },
  { name: "sql", path: "a.py", source: 'def get_user(request, db):\n    user_id = request.args["id"]\n    return db.execute("SELECT * FROM users WHERE id = " + user_id)\n', line: 3, prompt: "Does this code concatenate untrusted input into an SQL query?", value: "TRUE", message: "Use a parameterized SQL query." },
  { name: "unawaited", path: "a.js", source: "async function save(user) {\n  writeAudit(user);\n  await persist(user);\n}\n", line: 2, prompt: "Does this code call writeAudit without awaiting it?", value: "TRUE", message: "Await writeAudit." },
];
// The same findings on code that doesn't have the problem.
const SMALL_UNSUPPORTED: Case[] = [
  { name: "none-print", path: "a.py", source: "def greet(name):\n    return name\n", line: NONE, prompt: "Does the code call print?", value: "TRUE", message: "Remove the print call." },
  { name: "none-sql", path: "a.py", source: 'def get_user(request, db):\n    user_id = request.args["id"]\n    return db.execute("SELECT * FROM users WHERE id = %s", (user_id,))\n', line: NONE, prompt: "Does this code concatenate untrusted input into an SQL query?", value: "TRUE", message: "Use a parameterized SQL query." },
  { name: "none-unawaited", path: "a.js", source: "async function save(user) {\n  await writeAudit(user);\n  await persist(user);\n}\n", line: NONE, prompt: "Does this code call writeAudit without awaiting it?", value: "TRUE", message: "Await writeAudit." },
];

// Large files: this repo's own TypeScript, cycled to N lines, with one planted violation.
const corpus = ["src", "test"].flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "citation-bench.test.ts").sort()
  .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n")));
const PLANTS = [
  { code: '  const rows = await db.query("SELECT * FROM users WHERE email = \'" + req.query.email + "\'");', prompt: "Does this code concatenate untrusted input into an SQL query?", message: "Use a parameterized SQL query." },
  { code: "  console.log(`login ok for ${user.email} with password ${user.password}`);", prompt: "Does this code log a password or other secret?", message: "Do not log secrets." },
];
// Deterministic, spread across the file, never on line 1 and never a round number (unless `at` is given; NONE plants nothing).
function large(size: number, seed: number, at = Math.min(size, Math.max(2, Math.floor(size * [0.37, 0.83, 0.12, 0.61][seed % 4]) + 3)), name = `large-${size}-${seed}`): Case {
  const plant = PLANTS[seed % PLANTS.length];
  const lines = Array.from({ length: size }, (_, i) => corpus[(i + seed * 997) % corpus.length]);
  if (at !== NONE) lines[at - 1] = plant.code;
  return { name, path: "src/big.ts", source: lines.join("\n") + "\n", line: at, prompt: plant.prompt, value: "TRUE", message: plant.message };
}

function executableFixture(c: Case): Case {
  if (c.path !== "src/big.ts") return c;
  const original = sourceLines(c.source);
  const lines = original.map(() => "  void 0;");
  lines[0] = "export {}; declare const db: { query(sql: string): Promise<unknown> }; declare const req: { query: { email: string } }; declare const user: { email: string; password: string }; async function scenario() {";
  if (c.line !== NONE) lines[c.line - 1] = original[c.line - 1];
  lines[lines.length - 1] += " }";
  return { ...c, source: lines.join("\n") + "\n" };
}
// Violations on block edges: 100 and 201 sit on ids' edges, 100-110 and 200-210 are lines-windowed's overlaps.
const EDGES = [[100, 0], [105, 1], [201, 0]].map(([at, seed]) => large(1000, seed, at, `edge-1000-at${at}`));
const UNSUPPORTED = [...SMALL_UNSUPPORTED, large(250, 1, NONE, "none-250"), large(1000, 0, NONE, "none-1000")];
const DIFFS: Case[] = [
  { ...SMALL[1], name: "diff-clean", source: "print('old')\nvalue = 1\n", line: NONE, changed: [2] },
  { ...SMALL[1], name: "diff-print", source: "print('old')\nprint('new')\n", line: 2, changed: [2] },
];
const CASES = [...SMALL, ...SIZES.flatMap((size) => [0, 1].map((seed) => large(size, seed))), ...EDGES, ...UNSUPPORTED, ...DIFFS]
  .filter((c) => !CASE_PREFIXES.length || CASE_PREFIXES.some((p) => c.name.startsWith(p)));
if (!CASES.length) throw new Error("--cases matched no fixtures");

// ---------- shared ----------
const sourceLines = (source: string) => source.split("\n").map((raw) => raw.replace(/\r$/, "")).slice(0, source.endsWith("\n") ? -1 : undefined);
const instructions = (c: Case, tail: string) => [
  "Which source line is the strongest evidence for this lint finding?",
  "Select the line that needs to change to resolve the finding.",
  "For a missing safeguard, select the operation that needs it.",
  `Rule: ${c.prompt}`,
  `Reported answer: ${c.value}.`,
  `Finding: ${c.message}`,
  tail,
].filter(Boolean).join("\n");

async function decide(state: Record<string, string>, questions: Record<string, object>): Promise<{ answers: Answers; inputTokens: number; bytes: number; ms: number }> {
  const body = JSON.stringify({ model: MODEL, state, questions });
  const bytes = Buffer.byteLength(body);
  meter.plannedCalls++;
  meter.plannedBytes += bytes;
  if (DRY) return { answers: {}, inputTokens: 0, bytes, ms: 0 };
  const started = performance.now();
  for (let attempt = 0; ; attempt++) {
    meter.calls++;
    meter.bytes += bytes;
    let response: Response;
    try {
      response = await fetch(URL, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(120_000) });
    } catch { throw new Error("request failed or timed out"); }
    if (response.ok) {
      let payload: any;
      try { payload = await response.json(); } catch { throw new Error("invalid decisions response"); }
      const count = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0;
      const input = payload?.usage?.input_tokens;
      const output = payload?.usage?.output_tokens;
      if (count(input)) meter.inputTokens += input;
      if (count(output)) meter.outputTokens += output;
      if (count(input) && count(output)) meter.usageCalls++;
      const cost = payload?.usage?.cost;
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) { meter.cost += cost; meter.costCalls++; }
      return { answers: payload?.answers ?? {}, inputTokens: count(input) ? input : 0, bytes, ms: performance.now() - started };
    }
    await response.body?.cancel();
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt >= 2) throw new Error(`HTTP ${response.status}`);
    await new Promise((done) => setTimeout(done, 2000 * 2 ** attempt));
  }
}
const top = (p: Probabilities = {}) => Object.entries(p).sort((a, b) => b[1] - a[1]);

function isDistribution(value: unknown, choices: Record<string, unknown> | undefined): value is Probabilities {
  if (!choices || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === Object.keys(choices).length
    && entries.every(([id, p]) => Object.hasOwn(choices, id) && typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1)
    && Math.abs(entries.reduce((sum, [, p]) => sum + p, 0) - 1) <= 1e-6;
}

// ---------- strategies ----------
async function linesStrategy(c: Case): Promise<Outcome> {
  const options: Record<string, string> = { none: NONE_OPTION };
  sourceLines(c.source).forEach((text, i) => { if (text.trim()) options[`line_${i + 1}`] = `Line ${i + 1}: ${text}`; });
  const r = await decide({ path: c.path, content: c.source }, { f0: { type: "choice", instructions: instructions(c, NONE_HINT), criteria: options } });
  const extra = Object.keys(options).length > MAX_OPTIONS ? `${Object.keys(options).length} options > ${MAX_OPTIONS} limit` : undefined;
  const probabilities = r.answers.f0?.probabilities;
  if (!DRY && !isDistribution(probabilities, options)) throw new Error("missing or malformed citation answer");
  const [id, probability] = top(probabilities)[0] ?? [];
  return { line: id === "none" ? NONE : id?.startsWith("line_") ? Number(id.slice(5)) : undefined, probability, calls: 1, inputTokens: r.inputTokens, bytes: r.bytes, ms: r.ms, extra };
}

async function digitsStrategy(c: Case, mode: "greedy" | "constrained"): Promise<Outcome> {
  const lines = sourceLines(c.source);
  const width = String(lines.length).length;
  const content = lines.map((text, i) => `${String(i + 1).padStart(width, "0")}| ${text}`).join("\n");
  const digits = Object.fromEntries(Array.from({ length: 10 }, (_, d) => [String(d), `digit ${d}`]));
  const ordinal = ["1st", "2nd", "3rd", "4th", "5th", "6th"];
  const questions = Object.fromEntries(Array.from({ length: width }, (_, k) => [`d${k}`, {
    type: "choice",
    instructions: instructions(c, `Every line in content starts with its ${width}-digit, zero-padded line number and "| ". What is the ${ordinal[k]} digit (from the left) of that line's number?`),
    criteria: digits,
  }]));
  const r = await decide({ path: c.path, content }, questions);
  const base = { calls: 1, inputTokens: r.inputTokens, bytes: r.bytes, ms: r.ms };
  if (DRY) return base;
  const dist = Array.from({ length: width }, (_, k) => {
    const probabilities = r.answers[`d${k}`]?.probabilities;
    if (!isDistribution(probabilities, digits)) throw new Error("missing or malformed digit answer");
    return probabilities;
  });
  if (mode === "greedy") {
    const picks = dist.map((p) => top(p)[0] ?? ["?", 0]);
    const line = Number(picks.map(([d]) => d).join(""));
    const probability = picks.reduce((product, [, p]) => product * p, 1);
    const valid = line >= 1 && line <= lines.length && !!lines[line - 1]?.trim();
    return { ...base, line: valid ? line : undefined, probability, extra: valid ? `digits ${picks.map(([d, p]) => `${d}@${p.toFixed(2)}`).join(" ")}` : `invalid line ${line}` };
  }
  // Constrained: the best joint (product of independent digit probabilities) over real, non-blank lines.
  let best = { line: 0, probability: -1 }, total = 0;
  lines.forEach((text, i) => {
    if (!text.trim()) return;
    const p = String(i + 1).padStart(width, "0").split("").reduce((product, d, k) => product * (dist[k][d] ?? 0), 1);
    total += p;
    if (p > best.probability) best = { line: i + 1, probability: p };
  });
  return { ...base, line: best.line || undefined, probability: total ? best.probability / total : 0, extra: "renormalized over real lines" };
}

function idsSource(c: Case) {
  const lines = sourceLines(c.source);
  const width = Math.max(3, String(lines.length).length);
  const id = (n: number) => `L${String(n).padStart(width, "0")}`;
  const changed = c.changed ? new Set(c.changed) : undefined;
  const tagged = lines.map((text, i) => `${id(i + 1)}| ${changed ? changed.has(i + 1) && text.trim() ? "(new) " : "(context) " : ""}${text}`);
  const content = (changed ? collapseHiddenLines(tagged, linesToShow(c.source, changed, c.path)) : tagged).join("\n");
  const state = { path: c.path, content };
  const real = lines.flatMap((text, i) => text.trim() && (!changed || changed.has(i + 1)) ? [i + 1] : []);
  return { state, real, id, changed };
}

function idsRequest(c: Case, source: ReturnType<typeof idsSource>, hypothetical = false) {
  const { state, real, id, changed } = source;
  const eligible = new Map(real.map((n) => [id(n), n]));
  const scope = changed ? "Only lines marked (new) immediately after the id and | are eligible evidence. " : "";
  const ask = (tail: string) => `${hypothetical ? `Assume the reported answer ${c.value} applies; this is a conditional evidence question.\n` : ""}${scope}${instructions(c, tail)}`;
  const questions: Record<string, Choice> = {};
  const windows = new Map<string, number[]>();
  if (real.length < MAX_OPTIONS) {
    questions.f0 = {
      type: "choice", instructions: ask(`Every line in content starts with its id and "| ". Answer with that line's id. ${NONE_HINT}`),
      criteria: { none: NONE_OPTION, ...Object.fromEntries(real.map((n) => [id(n), null])) },
    };
  } else {
    for (const n of real) {
      const key = `W${Math.floor((n - 1) / WINDOW)}`;
      if (!windows.has(key)) windows.set(key, []);
      windows.get(key)!.push(n);
    }
    if (windows.size >= MAX_OPTIONS) throw new Error("citation range option limit exceeded");
    questions.window = {
      type: "choice", instructions: ask(`Every line in content starts with its id. Which range contains the evidence? ${NONE_HINT}`),
      criteria: { none: NONE_OPTION, ...Object.fromEntries([...windows].map(([key, ns]) => [key, `lines ${id(ns[0])} to ${id(ns.at(-1)!)}`])) },
    };
    for (const [key, ns] of windows) {
      if (ns.length === 1) continue;
      questions[key] = {
        type: "choice", instructions: ask(`Assuming the evidence is between ${id(ns[0])} and ${id(ns.at(-1)!)}, answer with its id.`),
        criteria: Object.fromEntries(ns.map((n) => [id(n), null])),
      };
    }
  }
  const select = (answers: Answers) => {
    const choose = (key: string) => {
      const choices = questions[key]?.criteria;
      const probabilities = answers[key]?.probabilities;
      if (!isDistribution(probabilities, choices)) return;
      const entries = top(probabilities);
      return { id: entries[0][0], probability: entries[0][1], tied: entries[0][1] === entries[1]?.[1] };
    };
    const root = choose(windows.size ? "window" : "f0");
    if (!root) return { citationError: "missing or malformed citation answer" };
    if (root.tied) return { probability: root.probability };
    if (root.id === "none") return { line: NONE, probability: root.probability };
    const ns = windows.get(root.id);
    const child = ns ? ns.length === 1 ? { id: id(ns[0]), probability: 1, tied: false } : choose(root.id) : root;
    if (!child || !eligible.has(child.id)) return { citationError: "missing or malformed citation answer" };
    const probability = root.probability * (ns ? child.probability : 1);
    return child.tied ? { probability } : { line: eligible.get(child.id), probability };
  };
  return { state, questions, select };
}

async function idsStrategy(c: Case): Promise<Outcome> {
  const request = idsRequest(c, idsSource(c));
  const r = await decide(request.state, request.questions);
  return { calls: 1, inputTokens: r.inputTokens, bytes: r.bytes, ms: r.ms, ...(DRY ? {} : request.select(r.answers)) };
}

async function detectionAndCitation(c: Case, combined: boolean): Promise<Outcome> {
  const source = idsSource(c);
  const request = combined ? idsRequest(c, source, true) : undefined;
  const scope = c.changed ? "Evaluate only the (new) lines; other lines and omitted regions do not count. " : "Evaluate the whole file. ";
  const detection = { violation: { type: "noul", instructions: `content has line-id prefixes, not part of the source. ${scope}${c.prompt}` } };
  const response = await decide(source.state, request ? { ...detection, ...request.questions } : detection);
  const base = { calls: 1, inputTokens: response.inputTokens, bytes: response.bytes, ms: response.ms };
  if (DRY) {
    if (!request) await decide(source.state, idsRequest(c, source, true).questions);
    return base;
  }
  const p = response.answers.violation?.noul;
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) throw new Error("missing or malformed lint answer");
  const decision = { flagged: p >= THRESHOLD, decisionProbability: p };
  if (!decision.flagged) return { ...base, ...decision, line: NONE, probability: 1 - p };
  try {
    const citation = request ?? idsRequest(c, source, true);
    const output = request ? response : await decide(source.state, citation.questions);
    return { ...base, ...decision, ...citation.select(output.answers) };
  } catch { return { ...base, ...decision, citationError: "citation request failed" }; }
}

// lines, past the option limit: line-text options in overlapping blocks (1-110, 100-210, 200-310, ...), one request.
async function linesWindowedStrategy(c: Case): Promise<Outcome> {
  const lines = sourceLines(c.source);
  const real = lines.flatMap((text, i) => (text.trim() ? [i + 1] : []));
  if (real.length < MAX_OPTIONS) return linesStrategy(c);
  const width = String(lines.length).length;
  const content = lines.map((text, i) => `${String(i + 1).padStart(width, "0")}| ${text}`).join("\n");
  const windows = Array.from({ length: Math.ceil(lines.length / WINDOW) }, (_, w) => [Math.max(1, w * WINDOW), Math.min(lines.length, (w + 1) * WINDOW + OVERLAP)]);
  const questions: Record<string, Choice> = { window: {
    type: "choice",
    instructions: instructions(c, `Every line in content starts with its line number and "| ". Which range of line numbers contains that line? Ranges overlap; any range containing it is right. ${NONE_HINT}`),
    criteria: { none: NONE_OPTION, ...Object.fromEntries(windows.map(([a, b], w) => [`W${w}`, `lines ${a} to ${b}`])) },
  } };
  windows.forEach(([a, b], w) => {
    const ids = real.filter((n) => n >= a && n <= b);
    if (ids.length) questions[`w${w}`] = { type: "choice", instructions: instructions(c, `Every line in content starts with its line number and "| ". The line is between ${a} and ${b}.`), criteria: Object.fromEntries(ids.map((n) => [`line_${n}`, `Line ${n}: ${lines[n - 1]}`])) };
  });
  const r = await decide({ path: c.path, content }, questions);
  const base = { calls: 1, inputTokens: r.inputTokens, bytes: r.bytes, ms: r.ms };
  if (DRY) return { ...base, extra: `${Object.keys(questions).length} questions` };
  const root = r.answers.window?.probabilities;
  if (!isDistribution(root, questions.window.criteria)) throw new Error("missing or malformed range answer");
  const [w, pw] = top(root)[0];
  if (w === "none") return { ...base, line: NONE, probability: pw, extra: `window none@${(pw ?? 0).toFixed(2)}` };
  const childId = `w${w.slice(1)}`;
  const child = r.answers[childId]?.probabilities;
  if (!isDistribution(child, questions[childId]?.criteria)) throw new Error("missing or malformed citation answer");
  const [pick, pl] = top(child)[0];
  return { ...base, line: pick ? Number(pick.slice(5)) : undefined, probability: (pw ?? 0) * (pl ?? 0), extra: `window ${w}@${(pw ?? 0).toFixed(2)} line@${(pl ?? 0).toFixed(2)}` };
}

const STRATEGIES: Record<string, (c: Case) => Promise<Outcome>> = {
  lines: linesStrategy,
  "lines-windowed": linesWindowedStrategy,
  "digits-greedy": (c) => digitsStrategy(c, "greedy"),
  "digits-constrained": (c) => digitsStrategy(c, "constrained"),
  ids: idsStrategy,
  "two-pass": (c) => detectionAndCitation(c, false),
  combined: (c) => detectionAndCitation(c, true),
};
const END_TO_END = new Set(["two-pass", "combined"]);
for (const selector of ONLY) {
  if (!selector || !Object.keys(STRATEGIES).some((name) => name.startsWith(selector))) throw new Error(`Unknown strategy selector: ${selector}`);
}
const matched = Object.entries(STRATEGIES).filter(([name]) => ONLY.some((prefix) => name.startsWith(prefix)));
const selected = DRY && matched.some(([name]) => name === "digits-greedy")
  ? matched.filter(([name]) => name !== "digits-constrained") : matched;
if (!CASES.some((c) => !c.changed || selected.some(([name]) => END_TO_END.has(name)))) throw new Error("Selected strategies do not support the selected fixtures");

interface Measurement extends Outcome {
  outputTokens: number;
  plannedCalls: number;
  plannedBytes: number;
  missingUsageCalls: number;
  cost?: number;
  missingCostCalls: number;
}
interface Row { strategy: string; scope: string; case: string; run: number; truth: number; expectedFinding: boolean; o: Measurement }
const log: string[] = [];
const out = (line: string) => { console.log(line); log.push(line); };
const rows: Row[] = [];
out(DRY ? "DRY RUN: planned request shapes only; two-pass assumes a finding. No model calls or accuracy/latency results." : `Model ${MODEL}; concurrency 1; up to 2 HTTP retries; 120-second request timeout. Citation-only and end-to-end scopes are not comparable.`);
for (const [caseIndex, c] of CASES.entries()) {
  const paired = executableFixture(c);
  for (let i = 0; i < (DRY ? 1 : REPEATS); i++) {
    const ordered = (i + caseIndex) % 2 ? [...selected].reverse() : selected;
    for (const [name, run] of ordered) {
      if (c.changed && !END_TO_END.has(name)) continue;
      meter = newMeter();
      const started = performance.now();
      let result: Outcome;
      try { result = await run(END_TO_END.has(name) ? paired : c); } catch (error) { result = { error: (error as Error).message, calls: 0, inputTokens: 0, bytes: 0, ms: 0 }; }
      const o: Measurement = {
        ...result, calls: meter.calls, inputTokens: meter.inputTokens, outputTokens: meter.outputTokens,
        bytes: meter.bytes, ms: DRY ? 0 : performance.now() - started,
        plannedCalls: meter.plannedCalls, plannedBytes: meter.plannedBytes,
        missingUsageCalls: meter.calls - meter.usageCalls,
        ...(meter.costCalls ? { cost: meter.cost } : {}), missingCostCalls: meter.calls - meter.costCalls,
      };
      const scope = END_TO_END.has(name) ? "end-to-end" : "citation-only";
      rows.push({ strategy: name, scope, case: c.name, run: i, truth: c.line, expectedFinding: c.line !== NONE, o });
      const correct = o.line === c.line && (!END_TO_END.has(name) || o.flagged === (c.line !== NONE));
      const verdict = DRY ? "" : o.error || o.citationError ? "ERROR" : correct ? "HIT" : "MISS";
      const shown = (line?: number) => line === NONE ? "none" : line ?? "-";
      out([name.padEnd(19), c.name.padEnd(18), `#${i}`, verdict,
        DRY ? `planned-calls=${o.plannedCalls} planned-bytes=${o.plannedBytes}` : `got=${shown(o.line)} want=${shown(c.line)} p=${o.probability?.toFixed(3) ?? "-"} calls=${o.calls} bytes=${o.bytes} input=${o.inputTokens} output=${o.outputTokens} ms=${Math.round(o.ms)}`,
        o.flagged === undefined ? "" : `flagged=${o.flagged} detection-p=${o.decisionProbability?.toFixed(3)}`,
        o.error ?? o.citationError ?? o.extra ?? ""].filter(Boolean).join("  "));
    }
  }
}

const summaries = [];
if (!DRY) {
  out("\nsummary: detection is scored only for end-to-end variants; citations require a real line and p >= threshold; latency excludes transport/malformed-answer errors.");
  for (const [strategy] of selected) {
    const mine = rows.filter((r) => r.strategy === strategy);
    for (const group of END_TO_END.has(strategy) ? ["all", "clean", "flagged"] : ["all"]) {
      const groupRows = mine.filter((r) => group === "all" || r.expectedFinding === (group === "flagged"));
      if (!groupRows.length) continue;
      const completed = groupRows.filter((r) => !r.o.error && !r.o.citationError);
      const durations = completed.map((r) => r.o.ms).sort((a, b) => a - b);
      const median = durations.length ? (durations[Math.floor((durations.length - 1) / 2)] + durations[Math.floor(durations.length / 2)]) / 2 : null;
      const summary = {
        strategy, scope: END_TO_END.has(strategy) ? "end-to-end" : "citation-only", group, trials: groupRows.length,
        detection: END_TO_END.has(strategy) ? {
          truePositives: groupRows.filter((r) => r.expectedFinding && r.o.flagged === true).length,
          falsePositives: groupRows.filter((r) => !r.expectedFinding && r.o.flagged === true).length,
          trueNegatives: groupRows.filter((r) => !r.expectedFinding && r.o.flagged === false).length,
          falseNegatives: groupRows.filter((r) => r.expectedFinding && r.o.flagged === false).length,
          missing: groupRows.filter((r) => r.o.flagged === undefined).length,
        } : undefined,
        exactLines: groupRows.filter((r) => !r.o.error && !r.o.citationError && r.o.line === r.truth).length,
        correctCitations: groupRows.filter((r) => r.truth !== NONE && r.o.line === r.truth && (r.o.probability ?? 0) >= THRESHOLD).length,
        wrongCitations: groupRows.filter((r) => r.o.line !== undefined && r.o.line !== NONE && r.o.line !== r.truth && (r.o.probability ?? 0) >= THRESHOLD).length,
        errors: groupRows.filter((r) => r.o.error).length,
        citationErrors: groupRows.filter((r) => r.o.citationError).length,
        calls: groupRows.reduce((sum, r) => sum + r.o.calls, 0),
        inputTokens: groupRows.reduce((sum, r) => sum + r.o.inputTokens, 0),
        outputTokens: groupRows.reduce((sum, r) => sum + r.o.outputTokens, 0),
        missingUsageCalls: groupRows.reduce((sum, r) => sum + r.o.missingUsageCalls, 0),
        measuredCost: groupRows.some((r) => r.o.cost !== undefined) ? groupRows.reduce((sum, r) => sum + (r.o.cost ?? 0), 0) : null,
        missingCostCalls: groupRows.reduce((sum, r) => sum + r.o.missingCostCalls, 0),
        latencyMs: { samples: durations.length, median, min: durations[0] ?? null, max: durations.at(-1) ?? null },
      };
      summaries.push(summary);
      out(JSON.stringify(summary));
    }
  }
}
if (OUTPUT) writeFileSync(OUTPUT, JSON.stringify({ model: MODEL, pairedFixtureSet: "executable-v1", dry: DRY, repeats: DRY ? 1 : REPEATS, threshold: THRESHOLD, sizes: SIZES, rows, summaries }, null, 2) + "\n");
if (process.env.GITHUB_STEP_SUMMARY) {
  const title = `Citation strategies (${MODEL}, ${DRY ? "dry run" : `${REPEATS} repeats`})`;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${title}\n\n\`\`\`\n${log.join("\n")}\n\`\`\`\n`);
}
if (rows.some((r) => r.o.error || r.o.citationError)) process.exitCode = 1;
