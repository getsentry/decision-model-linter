// Compares three ways to cite a source line for a lint finding through the decisions API.
//
//   lines   PR #6 as written: one Choice whose options are `line_N: "Line N: <text>"` (+ none).
//   digits  Content tagged `0042| ...`; one Choice per digit of the line number, options 0-9.
//           Decoded greedily (argmax per digit) and constrained (best product over real lines).
//   ids     TypeSafe's line-search recipe: content tagged `L0042| ...`, options are bare ids with
//           no description. Over 254 lines it fans out in one request: a
//           window question plus one id question per 100-line window; read the chosen window's.
//
// Usage:
//   node bench/citation-strategies.ts --dry                # request sizes only, no API calls
//   OPENROUTER_API_KEY=... node bench/citation-strategies.ts [--repeats 3] [--only digits,ids]
//   MODEL=typesafe/jev-1.13 DECISIONS_URL=https://openrouter.ai/api/alpha/decisions (defaults)
// In GitHub Actions the output is also written to the job summary.
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const DRY = flag("dry");
const REPEATS = Number(option("repeats", "3"));
const ONLY = option("only", "lines,digits,ids").split(",");
const SIZES = option("sizes", "60,250,1000,2000").split(",").map(Number);
const MODEL = process.env.MODEL ?? "typesafe/jev-1.13";
const URL = process.env.DECISIONS_URL ?? "https://openrouter.ai/api/alpha/decisions";
const KEY = process.env.OPENROUTER_API_KEY ?? "";
const THRESHOLD = 0.7;
const MAX_OPTIONS = 255;
const WINDOW = 100;
if (!DRY && !KEY.trim()) throw new Error("Set OPENROUTER_API_KEY, or pass --dry");

type Probabilities = Record<string, number>;
interface Case { name: string; path: string; source: string; line: number; prompt: string; value: string; message: string }
interface Outcome { line?: number; probability?: number; error?: string; calls: number; inputTokens: number; bytes: number; ms: number; extra?: string }

// ---------- fixtures ----------
const SMALL: Case[] = [
  { name: "declaration", path: "a.py", source: "def greet(name):\n    return name\n", line: 1, prompt: "Does the code define a function without a return type annotation?", value: "TRUE", message: "Add a return type annotation." },
  { name: "print", path: "a.py", source: "def greet(name):\n    print(name)\n", line: 2, prompt: "Does the code call print?", value: "TRUE", message: "Remove the print call." },
  { name: "sql", path: "a.py", source: 'def get_user(request, db):\n    user_id = request.args["id"]\n    return db.execute("SELECT * FROM users WHERE id = " + user_id)\n', line: 3, prompt: "Does this code concatenate untrusted input into an SQL query?", value: "TRUE", message: "Use a parameterized SQL query." },
  { name: "unawaited", path: "a.js", source: "async function save(user) {\n  writeAudit(user);\n  await persist(user);\n}\n", line: 2, prompt: "Does this code call writeAudit without awaiting it?", value: "TRUE", message: "Await writeAudit." },
];

// Large files: this repo's own TypeScript, cycled to N lines, with one planted violation.
const corpus = ["src", "test"].flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()
  .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n")));
const PLANTS = [
  { code: '  const rows = await db.query("SELECT * FROM users WHERE email = \'" + req.query.email + "\'");', prompt: "Does this code concatenate untrusted input into an SQL query?", message: "Use a parameterized SQL query." },
  { code: "  console.log(`login ok for ${user.email} with password ${user.password}`);", prompt: "Does this code log a password or other secret?", message: "Do not log secrets." },
];
function large(size: number, seed: number): Case {
  const plant = PLANTS[seed % PLANTS.length];
  const lines = Array.from({ length: size }, (_, i) => corpus[(i + seed * 997) % corpus.length]);
  // Deterministic, spread across the file, never on line 1 and never a round number.
  const at = Math.max(2, Math.floor(size * [0.37, 0.83, 0.12, 0.61][seed % 4]) + 3);
  lines[at - 1] = plant.code;
  return { name: `large-${size}-${seed}`, path: "src/big.ts", source: lines.join("\n") + "\n", line: at, prompt: plant.prompt, value: "TRUE", message: plant.message };
}
const CASES = [...SMALL, ...SIZES.flatMap((size) => [0, 1].map((seed) => large(size, seed)))];

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

async function decide(state: Record<string, string>, questions: Record<string, object>): Promise<{ answers: Record<string, { probabilities: Probabilities }>; inputTokens: number; bytes: number; ms: number }> {
  const body = JSON.stringify({ model: MODEL, state, questions });
  if (DRY) return { answers: {}, inputTokens: 0, bytes: body.length, ms: 0 };
  const started = performance.now();
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(URL, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(120_000) });
    if (response.ok) {
      const payload: any = await response.json();
      return { answers: payload.answers ?? {}, inputTokens: payload.usage?.input_tokens ?? 0, bytes: body.length, ms: performance.now() - started };
    }
    const detail = (await response.text()).slice(0, 300);
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt >= 2) throw new Error(`HTTP ${response.status}: ${detail}`);
    await new Promise((done) => setTimeout(done, 2000 * 2 ** attempt));
  }
}
const top = (p: Probabilities = {}) => Object.entries(p).sort((a, b) => b[1] - a[1]);

// ---------- strategies ----------
async function linesStrategy(c: Case): Promise<Outcome> {
  const options: Record<string, string> = { none: "No source line supports the reported answer and finding." };
  sourceLines(c.source).forEach((text, i) => { if (text.trim()) options[`line_${i + 1}`] = `Line ${i + 1}: ${text}`; });
  const r = await decide({ path: c.path, content: c.source }, { f0: { type: "choice", instructions: instructions(c, ""), criteria: options } });
  const extra = Object.keys(options).length > MAX_OPTIONS ? `${Object.keys(options).length} options > ${MAX_OPTIONS} limit` : undefined;
  const [id, probability] = top(r.answers.f0?.probabilities)[0] ?? [];
  return { line: id?.startsWith("line_") ? Number(id.slice(5)) : undefined, probability, calls: 1, inputTokens: r.inputTokens, bytes: r.bytes, ms: r.ms, extra };
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
  const dist = Array.from({ length: width }, (_, k) => r.answers[`d${k}`]?.probabilities ?? {});
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

async function idsStrategy(c: Case): Promise<Outcome> {
  const lines = sourceLines(c.source);
  const width = Math.max(3, String(lines.length).length);
  const id = (n: number) => `L${String(n).padStart(width, "0")}`;
  const content = lines.map((text, i) => `${id(i + 1)}| ${text}`).join("\n");
  const state = { path: c.path, content };
  const real = lines.flatMap((text, i) => text.trim() ? [i + 1] : []);
  const ask = (candidates: number[], tail = "") => decide(state, { f0: {
    type: "choice",
    instructions: instructions(c, `Every line in content starts with its id and "| ". Answer with that line's id.${tail}`),
    criteria: Object.fromEntries(candidates.map((n) => [id(n), null])),
  } });
  if (real.length < MAX_OPTIONS) {
    const r = await ask(real);
    const [pick, probability] = top(r.answers.f0?.probabilities)[0] ?? [];
    return { line: pick ? Number(pick.slice(1)) : undefined, probability, calls: 1, inputTokens: r.inputTokens, bytes: r.bytes, ms: r.ms };
  }
  // One request, fanned out: a window question plus one id question per window (state sent once).
  const windows = Array.from({ length: Math.ceil(lines.length / WINDOW) }, (_, w) => [w * WINDOW + 1, Math.min(lines.length, (w + 1) * WINDOW)]);
  const questions: Record<string, object> = { window: {
    type: "choice",
    instructions: instructions(c, "Every line in content starts with its id. Which range of line ids contains that line?"),
    criteria: Object.fromEntries(windows.map(([a, b], w) => [`W${w}`, `lines ${id(a)} to ${id(b)}`])),
  } };
  windows.forEach(([a, b], w) => {
    const ids = real.filter((n) => n >= a && n <= b);
    if (ids.length) questions[`w${w}`] = { type: "choice", instructions: instructions(c, `Every line in content starts with its id and "| ". Answer with that line's id; it is between ${id(a)} and ${id(b)}.`), criteria: Object.fromEntries(ids.map((n) => [id(n), null])) };
  });
  const r = await decide(state, questions);
  const base = { calls: 1, inputTokens: r.inputTokens, bytes: r.bytes, ms: r.ms };
  if (DRY) return { ...base, extra: `${Object.keys(questions).length} questions` };
  const [w, pw] = top(r.answers.window?.probabilities)[0] ?? [];
  const [pick, pl] = top(r.answers[`w${w?.slice(1)}`]?.probabilities)[0] ?? [];
  return { ...base, line: pick ? Number(pick.slice(1)) : undefined, probability: (pw ?? 0) * (pl ?? 0), extra: `window ${w}@${(pw ?? 0).toFixed(2)} line@${(pl ?? 0).toFixed(2)}` };
}

const STRATEGIES: Record<string, (c: Case) => Promise<Outcome>> = {
  lines: linesStrategy,
  "digits-greedy": (c) => digitsStrategy(c, "greedy"),
  "digits-constrained": (c) => digitsStrategy(c, "constrained"),
  ids: idsStrategy,
};

// ---------- run ----------
const log: string[] = [];
const out = (line: string) => { console.log(line); log.push(line); };
const rows: { strategy: string; case: string; run: number; truth: number; o: Outcome }[] = [];
for (const c of CASES) {
  for (const [name, run] of Object.entries(STRATEGIES)) {
    if (!ONLY.some((o) => name.startsWith(o))) continue;
    // digits-constrained reuses digits-greedy's request shape; in dry mode one is enough.
    if (DRY && name === "digits-constrained") continue;
    for (let i = 0; i < (DRY ? 1 : REPEATS); i++) {
      let o: Outcome;
      try { o = await run(c); } catch (error) { o = { error: (error as Error).message, calls: 1, inputTokens: 0, bytes: 0, ms: 0 }; }
      rows.push({ strategy: name, case: c.name, run: i, truth: c.line, o });
      const verdict = DRY ? "" : o.error ? `ERROR ${o.error}` : o.line === c.line ? "HIT " : "MISS";
      out([name.padEnd(19), c.name.padEnd(16), `#${i}`, verdict, DRY ? "" : `got=${o.line ?? "-"} want=${c.line} p=${o.probability?.toFixed(3) ?? "-"}`,
        `bytes=${o.bytes}`, o.inputTokens ? `tok=${o.inputTokens}` : "", DRY ? "" : `ms=${Math.round(o.ms)}`, o.extra ?? ""].filter(Boolean).join("  "));
    }
  }
}

if (!DRY) {
  out("\nsummary (hit = exact line; cited = hit AND p >= threshold; stable = same answer across repeats)");
  for (const strategy of Object.keys(STRATEGIES).filter((s) => ONLY.some((o) => s.startsWith(o)))) {
    const mine = rows.filter((r) => r.strategy === strategy);
    const hits = mine.filter((r) => r.o.line === r.truth).length;
    const cited = mine.filter((r) => r.o.line === r.truth && (r.o.probability ?? 0) >= THRESHOLD).length;
    const wrongCited = mine.filter((r) => r.o.line !== undefined && r.o.line !== r.truth && (r.o.probability ?? 0) >= THRESHOLD).length;
    const errors = mine.filter((r) => r.o.error).length;
    const byCase = new Map<string, Set<string>>();
    for (const r of mine) byCase.set(r.case, (byCase.get(r.case) ?? new Set()).add(String(r.o.line)));
    const stable = [...byCase.values()].filter((s) => s.size === 1).length;
    const tokens = mine.reduce((sum, r) => sum + r.o.inputTokens, 0);
    out(`${strategy.padEnd(19)} hit ${hits}/${mine.length}  cited@${THRESHOLD} ${cited}  confidently-wrong ${wrongCited}  errors ${errors}  stable ${stable}/${byCase.size}  input tokens ${tokens.toLocaleString("en-US")}`);
  }
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const title = `Citation strategies (${MODEL}, ${DRY ? "dry run" : `${REPEATS} repeats`})`;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${title}\n\n\`\`\`\n${log.join("\n")}\n\`\`\`\n`);
}
