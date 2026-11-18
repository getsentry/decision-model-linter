import { DEFAULT_THRESHOLD, type Citation, type ResolvedRule } from "./config.ts";
import type { Finding, SourceLocation } from "./evaluate.ts";
import type { Answer, Question, State } from "./models.ts";
import { openRouter } from "./openrouter.ts";

type Choice = Extract<Question, { type: "choice" }>;
const MAX_OPTIONS = 255;
const RANGE_LINES = 100;

/** Kept separate from decision usage: citation failure is not a failed lint decision. */
export interface CitationResult {
  calls: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

/** Enriches findings in place with one representative source line each. */
export async function citeFindings(
  state: State,
  findings: Finding[],
  rules: readonly ResolvedRule[],
  changed: ReadonlySet<number> | undefined,
  options: Citation,
): Promise<CitationResult> {
  const lines = state.content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const width = Math.max(3, String(lines.length).length);
  const lineId = (line: number) => `L${String(line).padStart(width, "0")}`;
  const model = rules[0].model;
  const none = { none: "No source line supports the reported answer and finding." };
  const locations = new Map<string, SourceLocation>();
  const content = lines.map((raw, index) => {
    const line = index + 1;
    const text = raw.replace(/\r$/, "");
    const id = lineId(line);
    if (text.trim() && (!changed || changed.has(line))) {
      locations.set(id, { line, endLine: line, col: 1, endColumn: Array.from(text).length });
    }
    const marker = changed ? (locations.has(id) ? "(new) " : "(context) ") : "";
    return `${id}| ${marker}${text}`;
  }).join("\n");
  if (!locations.size || !findings.length) return { calls: 0 };
  const choices: Choice["options"] = { ...none, ...Object.fromEntries([...locations.keys()].map((id) => [id, null])) };
  const ranges = new Map<number, Record<string, null>>();
  if (locations.size >= MAX_OPTIONS) {
    for (const [id, location] of locations) {
      const range = Math.floor((location.line - 1) / RANGE_LINES);
      if (!ranges.has(range)) ranges.set(range, {});
      ranges.get(range)![id] = null;
    }
    if (ranges.size >= MAX_OPTIONS) {
      return { calls: 0, error: "source exceeds the citation range option limit; retaining file-level findings" };
    }
  }
  const rangeChoices: Choice["options"] = { ...none, ...Object.fromEntries([...ranges.keys()].map((range) => [
    `W${range}`, `lines ${lineId(range * RANGE_LINES + 1)} to ${lineId(Math.min(lines.length, (range + 1) * RANGE_LINES))}`,
  ])) };
  const questions: Record<string, Choice> = {};
  for (const [i, finding] of findings.entries()) {
    const rule = rules.find((rule) => rule.name === finding.rule)!;
    const instructions = [
      "Which source line is the strongest evidence for this lint finding?",
      "Select the line that needs to change to resolve the finding.",
      "For a missing safeguard, select the operation that needs it.",
      "Every line in content starts with its id and \"| \".",
      ...(changed ? ["Only lines marked (new) immediately after their id and \"| \" are eligible evidence."] : []),
      `Rule: ${rule.prompt}`,
      `Reported answer: ${finding.value}. ${rule.values.find((value) => value.value === finding.value)?.description ?? ""}`,
      `Finding: ${finding.message}`,
    ].join("\n");
    questions[`f${i}`] = {
      type: "choice", options: ranges.size ? rangeChoices : choices,
      instructions: `${instructions}\n${ranges.size ? "Which range of line ids contains that line?" : "Answer with that line's id."} Select none if the finding is unsupported.`,
    };
    for (const [range, options] of ranges) {
      if (Object.keys(options).length === 1) continue;
      questions[`f${i}_W${range}`] = {
        type: "choice", options,
        instructions: `${instructions}\nAssuming the strongest evidence is in ${rangeChoices[`W${range}`]}, answer with that line's id.`,
      };
    }
  }
  const taggedState = { ...state, content };
  if (JSON.stringify(taggedState).length + JSON.stringify(questions).length + 512 > model.maxInputTokens * 3) {
    return { calls: 0, error: "source and questions exceed the citation input budget" };
  }
  const result: CitationResult = { calls: 1 };
  try {
    const output = await openRouter({ ...model, apiKey: model.apiKey ?? "", timeoutMs: 30_000, retries: 0 }).decide(taggedState, questions);
    const tokens = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
    result.inputTokens = tokens(output.inputTokens);
    result.outputTokens = tokens(output.outputTokens);
    for (const [i, finding] of findings.entries()) {
      const rootId = `f${i}`;
      const selected = winner(output.answers[rootId], questions[rootId].options);
      if (!selected || selected.id === "none") continue;
      let id = selected.id;
      const threshold = options.threshold ?? DEFAULT_THRESHOLD;
      if (ranges.size) {
        const childId = `${rootId}_${selected.id}`;
        const candidates = Object.keys(ranges.get(Number(selected.id.slice(1)))!);
        const line = candidates.length === 1
          ? { id: candidates[0], probability: 1 }
          : winner(output.answers[childId], questions[childId].options);
        if (!line || !jointMeetsThreshold(selected.probability, line.probability, threshold)) continue;
        id = line.id;
      } else if (selected.probability < threshold) continue;
      const location = locations.get(id);
      if (location) finding.locations = [location];
    }
  } catch {
    // Provider errors can contain credentials or source; keep them out of reports.
    result.error = "citation request failed; retaining file-level findings";
  }
  return result;
}

/** Preserve decimal probability cutoffs without binary floating-point rounding. */
function jointMeetsThreshold(range: number, line: number, threshold: number): boolean {
  const [a, b, cutoff] = [range, line, threshold].map((probability) => {
    const [coefficient, exponent = "0"] = probability.toString().split("e");
    const [whole, fraction = ""] = coefficient.split(".");
    return { units: BigInt(whole + fraction), exponent: Number(exponent) - fraction.length };
  });
  const exponent = Math.min(a.exponent + b.exponent, cutoff.exponent);
  return a.units * b.units * 10n ** BigInt(a.exponent + b.exponent - exponent)
    >= cutoff.units * 10n ** BigInt(cutoff.exponent - exponent);
}

function winner(answer: Answer | undefined, choices: Choice["options"]): { id: string; probability: number } | undefined {
  if (answer?.type !== "choice") return;
  const probabilities = Object.entries(answer.probabilities);
  if (probabilities.length !== Object.keys(choices).length || probabilities.some(([id, probability]) =>
    !Object.hasOwn(choices, id) || !Number.isFinite(probability) || probability < 0 || probability > 1)) return;
  if (Math.abs(probabilities.reduce((sum, [, probability]) => sum + probability, 0) - 1) > 1e-6) return;
  probabilities.sort((a, b) => b[1] - a[1]);
  const [best, second] = probabilities;
  if (!best || second?.[1] === best[1]) return;
  return { id: best[0], probability: best[1] };
}
