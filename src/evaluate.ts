import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type Entry,
  type Suite,
  type Field,
  type Severity,
  DEFAULT_SEVERITY,
  DEFAULT_THRESHOLD,
} from "./suites.ts";
import { collapseHiddenLines, linesToShow } from "./changed-lines.ts";
import { matchesAny } from "./files.ts";
import { type Answer, type JevClient, type Question, type State, JevError } from "./jev.ts";

// Measured: calls fail with max_tokens_exceeded just above 32k input tokens, state and
// questions together.
const CALL_TOKEN_LIMIT = 32_768;
// Conservative: diffs and source measured ~3.8 characters per token, schema JSON ~5.8.
const CHARS_PER_TOKEN = 3;
const QUESTION_OVERHEAD_CHARS = 60;

// Every prompt is prefixed with one of these; `content` is the file with numbered lines.
const LINE_FORMAT =
  "`content` is the file to lint. Each line starts with its line number and a tab; the prefix is " +
  "not part of the file. A line reading `[decision-model-linter: lines A-B omitted]` stands for lines left out to fit.";
export const WHOLE_FILE_INSTRUCTIONS = `${LINE_FORMAT} Evaluate the whole file.`;
export const NEW_LINES_INSTRUCTIONS =
  `${LINE_FORMAT} Lines added or changed by the change under review have (new) after the number, ` +
  "as in `12(new)`. Evaluate only the (new) lines: read the other lines to understand them, but " +
  "they never count toward the answer.";
// Measured on real PRs: any unchanged code shown, even 5 lines, leaks existing
// violations into the answer; new lines plus open brackets do not.

export interface Finding {
  suite: string;
  path: string;
  field: string;
  value: string;
  probability: number;
  threshold: number;
  severity: Severity;
  message: string;
}

export interface CallResult {
  suite: string;
  path: string;
  /** Index of the entry within its suite. */
  entry: number;
  /** "changeset" when only the file's new lines were linted. */
  mode: "file" | "changeset";
  /** field -> value -> probability */
  fields: Record<string, Record<string, number>>;
  findings: Finding[];
  truncated: boolean;
  /** Jev rejected the first state as too large and a half-budget state was sent. */
  shrunk: boolean;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  durationMs?: number;
  /** The model version that answered, as OpenRouter reports it. */
  model?: string;
}

export interface LintOptions {
  cwd: string;
  client: JevClient;
  concurrency?: number;
  callTokenLimit?: number;
  /** Added or changed line numbers per path; a path listed here is linted on those lines only. */
  newLines?: ReadonlyMap<string, ReadonlySet<number>>;
  /** Old path of each renamed file, so an entry that did not cover it there lints it whole. */
  renamedFrom?: ReadonlyMap<string, string>;
}

/** Indexes of the entries whose `files` match `path` and whose `ignores` do not. */
function entriesFor(entries: readonly Entry[], path: string): number[] {
  return entries.flatMap((entry, index) => (covers(entry, path) ? [index] : []));
}

/**
 * The lines an entry lints in a file: its changed lines, or undefined for the whole file when the
 * file is new to this entry (renamed from a path it did not cover), or "skip" for an unchanged rename.
 */
function changedLinesFor(
  entry: Entry,
  path: string,
  newLines: ReadonlyMap<string, ReadonlySet<number>> | undefined,
  renamedFrom: ReadonlyMap<string, string> | undefined,
): ReadonlySet<number> | undefined | "skip" {
  const from = renamedFrom?.get(path);
  if (from !== undefined && !covers(entry, from)) return undefined;
  if (from !== undefined && !newLines?.has(path)) return "skip";
  return newLines?.get(path);
}

/** Whether `entry` lints `path`. */
function covers(entry: Entry, path: string): boolean {
  return matchesAny(path, entry.files) && !matchesAny(path, entry.ignores ?? []);
}

/** Whether any suite has an entry for `path`. */
export function isLinted(suites: readonly Suite[], path: string): boolean {
  return suites.some((suite) => entriesFor(suite.entries, path).length > 0);
}

/** Asks Jev about every (file, suite entry) pair, a few calls at a time; one result per pair. */
export async function lint(suites: readonly Suite[], paths: readonly string[], options: LintOptions): Promise<CallResult[]> {
  const { cwd, client, concurrency = 16, callTokenLimit = CALL_TOKEN_LIMIT, newLines, renamedFrom } = options;
  const contexts = new Map<Entry, Promise<State>>();
  const jobs = paths.flatMap((path) =>
    suites.flatMap((suite) =>
      entriesFor(suite.entries, path).flatMap((entry) => {
        const scope = changedLinesFor(suite.entries[entry], path, newLines, renamedFrom);
        return scope === "skip" ? [] : [{ path, suite, entry, changed: scope }];
      }),
    ),
  );

  const results: CallResult[] = new Array(jobs.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < jobs.length) {
      const index = next++;
      const { path, suite, entry, changed } = jobs[index];
      results[index] = await lintOne(suite.name, suite.entries[entry], entry, path, changed, {
        cwd,
        client,
        callTokenLimit,
        contexts,
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}

/** One call: a file against one entry's fields, retried at half the budget if Jev finds it too large. */
async function lintOne(
  suite: string,
  entry: Entry,
  entryIndex: number,
  path: string,
  newLines: ReadonlySet<number> | undefined,
  deps: { cwd: string; client: JevClient; callTokenLimit: number; contexts: Map<Entry, Promise<State>> },
): Promise<CallResult> {
  const result: CallResult = {
    suite,
    path,
    entry: entryIndex,
    mode: newLines === undefined ? "file" : "changeset",
    fields: {},
    findings: [],
    truncated: false,
    shrunk: false,
  };
  let context: State;
  let content: string;
  try {
    if (!deps.contexts.has(entry)) deps.contexts.set(entry, resolveContext(entry));
    context = await deps.contexts.get(entry)!;
    content = await readFile(join(deps.cwd, path), "utf8");
  } catch (error) {
    result.error = (error as Error).message;
    return result;
  }

  const questions = Object.fromEntries(
    Object.entries(entry.fields).map(([name, field]) => [name, toQuestion(field, result.mode)]),
  );
  const fixedChars =
    path.length +
    Object.entries(context).reduce((sum, [key, text]) => sum + key.length + text.length, 0) +
    Object.entries(questions).reduce((sum, [id, q]) => sum + id.length + JSON.stringify(q).length, 0) +
    QUESTION_OVERHEAD_CHARS * Object.keys(questions).length;
  const budget = Math.max(deps.callTokenLimit * CHARS_PER_TOKEN - fixedChars, 0);

  // A changed file shows only its new lines and the brackets they continue, never the code around
  // them: Jev answers about everything it is shown, so unchanged code would leak into the answer.
  const annotated = annotate(content, newLines);
  const lines = newLines ? collapseHiddenLines(annotated, linesToShow(content, newLines, path)) : annotated;
  for (const attemptBudget of [budget, Math.floor(budget / 2)]) {
    const fitted = fit(lines, attemptBudget);
    result.truncated = fitted.length < lines.reduce((sum, line) => sum + line.length + 1, 0);
    const state: State = { path, content: fitted, ...context };
    try {
      const decision = await deps.client.decide(state, questions);
      Object.assign(result, {
        inputTokens: decision.inputTokens,
        outputTokens: decision.outputTokens,
        cost: decision.cost,
        durationMs: decision.durationMs,
        model: decision.model,
      });
      for (const [name, field] of Object.entries(entry.fields)) {
        result.fields[name] = probabilities(field, decision.answers[name]);
        result.findings.push(...findings(suite, path, name, field, result.fields[name]));
      }
      return result;
    } catch (error) {
      if (error instanceof JevError && error.maxTokensExceeded && !result.shrunk) {
        result.shrunk = true;
        continue;
      }
      result.error = (error as Error).message;
      return result;
    }
  }
  throw new Error("unreachable: the half-budget attempt either returns or records an error");
}

/** The entry's context values, with functions called. */
async function resolveContext(entry: Entry): Promise<State> {
  const state: State = {};
  for (const [name, value] of Object.entries(entry.context ?? {})) {
    state[name] = typeof value === "function" ? await value() : value;
  }
  return state;
}

/** Whether the field's answers are exactly TRUE and FALSE, so it is asked as a yes/no question. */
function isBoolean(field: Field): boolean {
  const names = field.values.map((v) => v.value).sort();
  return names.length === 2 && names[0] === "FALSE" && names[1] === "TRUE";
}

/** The Jev question for a field: yes/no for TRUE/FALSE fields, multiple choice otherwise. */
function toQuestion(field: Field, mode: CallResult["mode"] = "file"): Question {
  const scope = mode === "changeset" ? NEW_LINES_INSTRUCTIONS : WHOLE_FILE_INSTRUCTIONS;
  const instructions = `${scope}\n\nQuestion: ${field.prompt}`;
  const describe = (name: string) => {
    const value = field.values.find((v) => v.value === name)!;
    return value.description ?? value.value;
  };
  if (isBoolean(field)) {
    const described = field.values.some((v) => v.description !== undefined);
    return {
      type: "noul",
      instructions,
      ...(described ? { criteria: { true: describe("TRUE"), false: describe("FALSE") } } : {}),
    };
  }
  return {
    type: "choice",
    instructions,
    criteria: Object.fromEntries(field.values.map((v) => [v.value, describe(v.value)])),
  };
}

/** Each of the field's answers with the probability Jev gave it. */
function probabilities(field: Field, answer: Answer): Record<string, number> {
  if (answer.type === "noul") {
    return { TRUE: answer.noul, FALSE: 1 - answer.noul };
  }
  return Object.fromEntries(field.values.map((v) => [v.value, answer.probabilities[v.value] ?? 0]));
}

/** The findings for one field: answers with a report whose probability reaches their threshold. */
function findings(
  suite: string,
  path: string,
  field: string,
  definition: Field,
  probs: Record<string, number>,
): Finding[] {
  return definition.values.flatMap((value) => {
    const threshold = value.threshold ?? DEFAULT_THRESHOLD;
    const probability = probs[value.value];
    if (value.report === undefined || probability < threshold) return [];
    return [
      {
        suite,
        path,
        field,
        value: value.value,
        probability,
        threshold,
        severity: value.severity ?? DEFAULT_SEVERITY,
        message: value.report,
      },
    ];
  });
}

/** The file's lines, each prefixed with its number, `(new)` if listed, and a tab. */
export function annotate(content: string, newLines?: ReadonlySet<number>): string[] {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, i) => `${i + 1}${newLines?.has(i + 1) ? "(new)" : ""}\t${line}`);
}

/** The lines within `budget` characters, cutting the end if they do not fit. */
function fit(lines: readonly string[], budget: number): string {
  const whole = lines.length ? `${lines.join("\n")}\n` : "";
  return truncate(whole, budget);
}

/** `text` cut at a line boundary to fit `budget` characters, with a marker saying how much was cut. */
function truncate(text: string, budget: number): string {
  if (text.length <= budget) return text;
  budget = Math.max(budget, 0);
  const cut = text.lastIndexOf("\n", budget);
  const kept = cut > 0 ? text.slice(0, cut + 1) : `${text.slice(0, budget)}\n`;
  return `${kept}[decision-model-linter: truncated, ${text.length - kept.length} of ${text.length} characters omitted]\n`;
}
