import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { type ContextValue, type Model, type ResolvedRule, type Severity, DEFAULT_SEVERITY } from "./config.ts";
import { collapseHiddenLines, linesToShow } from "./changed-lines.ts";
import { matchesAny } from "./files.ts";
import { type Answer, type DecisionModel, type Question, type State, ModelError } from "./models.ts";

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
  rule: string;
  value: string;
  probability: number;
  threshold: number;
  severity: Severity;
  message: string;
}

export interface CallResult {
  suite: string;
  path: string;
  /** The rules asked in this call. */
  rules: string[];
  /** "changeset" when only the file's new lines were linted. */
  mode: "file" | "changeset";
  /** rule -> value -> probability */
  answers: Record<string, Record<string, number>>;
  findings: Finding[];
  truncated: boolean;
  /** The provider rejected the first state as too large and a half-budget state was sent. */
  shrunk: boolean;
  error?: string;
  /** Set when the file was not fully checked: the most severe `unchecked` among the call's rules. */
  unchecked?: Severity;
  provider: string;
  /** The model that answered, as the provider reports it, or the configured name. */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  durationMs?: number;
}

export interface LintOptions {
  cwd: string;
  /** The decision model for a configured model. */
  connect: (model: Model) => DecisionModel;
  concurrency?: number;
  /** Added or changed line numbers per path; a path listed here is linted on those lines only. */
  newLines?: ReadonlyMap<string, ReadonlySet<number>>;
  /** Old path of each renamed file, so a rule that did not cover it there lints it whole. */
  renamedFrom?: ReadonlyMap<string, string>;
}

/** One call: a file asked the rules of one suite that share a model, context, and mode. */
interface Job {
  path: string;
  rules: ResolvedRule[];
  changed: ReadonlySet<number> | undefined;
}

/** Whether `rule` lints `path`. */
function covers(rule: ResolvedRule, path: string): boolean {
  return matchesAny(path, rule.files) && !matchesAny(path, rule.ignores);
}

/** Whether any rule lints `path`. */
export function isLinted(rules: readonly ResolvedRule[], path: string): boolean {
  return rules.some((rule) => covers(rule, path));
}

/**
 * The lines a rule lints in a file: its changed lines, or undefined for the whole file when the
 * file is new to this rule (renamed from a path it did not cover), or "skip" for an unchanged rename.
 */
function changedLinesFor(
  rule: ResolvedRule,
  path: string,
  newLines: ReadonlyMap<string, ReadonlySet<number>> | undefined,
  renamedFrom: ReadonlyMap<string, string> | undefined,
): ReadonlySet<number> | undefined | "skip" {
  const from = renamedFrom?.get(path);
  if (from !== undefined && !covers(rule, from)) return undefined;
  if (from !== undefined && !newLines?.has(path)) return "skip";
  return newLines?.get(path);
}

/** Asks every rule about every file it lints, a few calls at a time; one result per call. */
export async function lint(
  rules: readonly ResolvedRule[],
  paths: readonly string[],
  options: LintOptions,
): Promise<CallResult[]> {
  const { cwd, connect, concurrency = 16, newLines, renamedFrom } = options;
  const jobs = paths.flatMap((path) => jobsFor(rules, path, newLines, renamedFrom));
  const models = new Map<string, DecisionModel>();
  const contexts = new Map<ContextValue, Map<string, Promise<string>>>();
  const deps = {
    cwd,
    contexts,
    model: (model: Model) => {
      const key = modelKey(model);
      if (!models.has(key)) models.set(key, connect(model));
      return models.get(key)!;
    },
  };

  const results: CallResult[] = new Array(jobs.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await lintOne(jobs[index], deps);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}

/** The calls for one file: its rules grouped by suite, model, context, and whether lines changed. */
function jobsFor(
  rules: readonly ResolvedRule[],
  path: string,
  newLines: ReadonlyMap<string, ReadonlySet<number>> | undefined,
  renamedFrom: ReadonlyMap<string, string> | undefined,
): Job[] {
  const jobs = new Map<string, Job>();
  for (const rule of rules) {
    if (!covers(rule, path)) continue;
    const changed = changedLinesFor(rule, path, newLines, renamedFrom);
    if (changed === "skip") continue;
    const key = [rule.suite, modelKey(rule.model), contextKey(rule.context), changed ? "changeset" : "file"].join("\0");
    const job = jobs.get(key);
    if (job) job.rules.push(rule);
    else jobs.set(key, { path, rules: [rule], changed });
  }
  return [...jobs.values()];
}

/** Rules whose models give the same key are asked by the same client and may share a call. */
function modelKey(model: Model): string {
  return JSON.stringify([model.provider, model.name, model.url ?? "", model.maxInputTokens, model.apiKey ?? ""]);
}

const functionIds = new WeakMap<Function, number>();
let lastFunctionId = 0;

/** Rules whose contexts give the same key send the same state and may share a call. */
function contextKey(context: Record<string, ContextValue>): string {
  const parts = Object.keys(context)
    .sort()
    .map((name) => {
      const value = context[name];
      if (typeof value === "string") return [name, "s", value];
      if (!functionIds.has(value)) functionIds.set(value, ++lastFunctionId);
      return [name, "f", functionIds.get(value)];
    });
  return JSON.stringify(parts);
}

/** One call, retried at half the budget if the provider finds it too large. */
async function lintOne(
  job: Job,
  deps: {
    cwd: string;
    contexts: Map<ContextValue, Map<string, Promise<string>>>;
    model: (model: Model) => DecisionModel;
  },
): Promise<CallResult> {
  const { path, rules, changed } = job;
  const { model } = rules[0];
  const result: CallResult = {
    suite: rules[0].suite,
    path,
    rules: rules.map((rule) => rule.name),
    mode: changed === undefined ? "file" : "changeset",
    answers: {},
    findings: [],
    truncated: false,
    shrunk: false,
    provider: model.provider,
  };
  try {
    await ask(job, result, deps.model(model), await resolveContext(rules[0].context, path, deps.contexts), deps.cwd);
  } catch (error) {
    result.error = (error as Error).message;
  }
  if (result.error !== undefined || result.truncated) {
    result.unchecked = rules.some((rule) => rule.unchecked === "error") ? "error" : DEFAULT_SEVERITY;
  }
  return result;
}

/** Sends the file and its rules' questions, filling in `result`. */
async function ask(job: Job, result: CallResult, client: DecisionModel, context: State, cwd: string): Promise<void> {
  const { path, rules, changed } = job;
  const content = await readFile(join(cwd, path), "utf8");
  const questions = Object.fromEntries(rules.map((rule) => [rule.name, toQuestion(rule, result.mode)]));
  const fixedChars =
    path.length +
    Object.entries(context).reduce((sum, [key, text]) => sum + key.length + text.length, 0) +
    Object.entries(questions).reduce((sum, [id, q]) => sum + id.length + JSON.stringify(q).length, 0) +
    QUESTION_OVERHEAD_CHARS * rules.length;
  const budget = Math.max(rules[0].model.maxInputTokens * CHARS_PER_TOKEN - fixedChars, 0);

  // A changed file shows only its new lines and the brackets they continue, never the code around
  // them: the model answers about everything it is shown, so unchanged code would leak into the answer.
  const annotated = annotate(content, changed);
  const lines = changed ? collapseHiddenLines(annotated, linesToShow(content, changed, path)) : annotated;
  for (const attemptBudget of [budget, Math.floor(budget / 2)]) {
    const fitted = fit(lines, attemptBudget);
    result.truncated = fitted.length < lines.reduce((sum, line) => sum + line.length + 1, 0);
    const state: State = { path, content: fitted, ...context };
    try {
      const decision = await client.decide(state, questions);
      Object.assign(result, {
        model: decision.model ?? rules[0].model.name,
        inputTokens: decision.inputTokens,
        outputTokens: decision.outputTokens,
        cost: decision.cost,
        durationMs: decision.durationMs,
      });
      for (const rule of rules) {
        result.answers[rule.name] = probabilities(rule, decision.answers[rule.name]);
        result.findings.push(...findings(rule, path, result.answers[rule.name]));
      }
      return;
    } catch (error) {
      if (error instanceof ModelError && error.tooLarge && !result.shrunk) {
        result.shrunk = true;
        continue;
      }
      throw error;
    }
  }
}

/** The context's values for `path`, calling each function at most once per file. */
async function resolveContext(
  context: Record<string, ContextValue>,
  path: string,
  cache: Map<ContextValue, Map<string, Promise<string>>>,
): Promise<State> {
  const state: State = {};
  for (const [name, value] of Object.entries(context)) {
    if (typeof value === "string") {
      state[name] = value;
      continue;
    }
    if (!cache.has(value)) cache.set(value, new Map());
    const byPath = cache.get(value)!;
    if (!byPath.has(path)) byPath.set(path, Promise.resolve().then(() => value({ path })));
    state[name] = await byPath.get(path)!;
  }
  return state;
}

/** Whether the rule's answers are exactly TRUE and FALSE, so it is asked as a yes/no question. */
function isBoolean(rule: ResolvedRule): boolean {
  const names = rule.values.map((v) => v.value).sort();
  return names.length === 2 && names[0] === "FALSE" && names[1] === "TRUE";
}

/** The question for a rule: yes/no for TRUE/FALSE rules, multiple choice otherwise. */
function toQuestion(rule: ResolvedRule, mode: CallResult["mode"]): Question {
  const scope = mode === "changeset" ? NEW_LINES_INSTRUCTIONS : WHOLE_FILE_INSTRUCTIONS;
  const instructions = `${scope}\n\nQuestion: ${rule.prompt}`;
  const describe = (name: string) => {
    const value = rule.values.find((v) => v.value === name)!;
    return value.description ?? value.value;
  };
  if (isBoolean(rule)) {
    const described = rule.values.some((v) => v.description !== undefined);
    return {
      type: "yesno",
      instructions,
      ...(described ? { criteria: { yes: describe("TRUE"), no: describe("FALSE") } } : {}),
    };
  }
  return {
    type: "choice",
    instructions,
    options: Object.fromEntries(rule.values.map((v) => [v.value, describe(v.value)])),
  };
}

/** Each of the rule's answers with the probability the model gave it. */
function probabilities(rule: ResolvedRule, answer: Answer): Record<string, number> {
  if (answer.type === "yesno") return { TRUE: answer.yes, FALSE: 1 - answer.yes };
  return Object.fromEntries(rule.values.map((v) => [v.value, answer.probabilities[v.value] ?? 0]));
}

/** The findings for one rule: answers with a report whose probability reaches their threshold. */
function findings(rule: ResolvedRule, path: string, probs: Record<string, number>): Finding[] {
  return rule.values.flatMap((value) => {
    const threshold = value.threshold ?? rule.threshold;
    const probability = probs[value.value];
    if (value.report === undefined || probability < threshold) return [];
    return [
      {
        suite: rule.suite,
        path,
        rule: rule.name,
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
