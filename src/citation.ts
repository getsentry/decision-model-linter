import { DEFAULT_THRESHOLD, type Citation, type ResolvedRule } from "./config.ts";
import type { Finding, SourceLocation } from "./evaluate.ts";
import type { Answer, Decision, Question } from "./models.ts";

type Choice = Extract<Question, { type: "choice" }>;
const MAX_OPTIONS = 255;
const RANGE_LINES = 100;

type CitationPlan =
  | { error: string }
  | { questions: Record<string, Choice>; attach(findings: Finding[], answers: Decision["answers"]): void };

/** Plans optional choices for every reportable answer against the complete lines of the lint view. */
export function planCitations({ rules, completeLines, lineCount, changeset, config, budget }: {
  rules: readonly ResolvedRule[];
  completeLines: readonly string[];
  lineCount: number;
  changeset: boolean;
  config: Citation;
  budget: number;
}): CitationPlan | undefined {
  const width = Math.max(3, String(lineCount).length);
  const lineId = (line: number) => `L${String(line).padStart(width, "0")}`;
  const none = { none: "No source line supports the reported answer and finding." };
  const locations = new Map<string, SourceLocation>();
  for (const annotated of completeLines) {
    const prefix = /^(\d+)(\(new\))?\t/.exec(annotated);
    if (!prefix || (changeset && !prefix[2])) continue;
    const text = annotated.slice(prefix[0].length).replace(/\r$/, "");
    if (!text.trim()) continue;
    const line = Number(prefix[1]);
    locations.set(lineId(line), { line, endLine: line, col: 1, endColumn: Array.from(text).length });
  }
  if (!locations.size) return;

  const ranges = new Map<string, Record<string, null>>();
  if (locations.size >= MAX_OPTIONS) {
    for (const [id, location] of locations) {
      const range = `W${Math.floor((location.line - 1) / RANGE_LINES)}`;
      if (!ranges.has(range)) ranges.set(range, {});
      ranges.get(range)![id] = null;
    }
    if (ranges.size >= MAX_OPTIONS) {
      return { error: "source exceeds the citation range option limit; retaining file-level findings" };
    }
  }
  const options: Choice["options"] = { ...none };
  if (ranges.size) {
    for (const id of ranges.keys()) {
      const start = Number(id.slice(1)) * RANGE_LINES;
      options[id] = `lines ${lineId(start + 1)} to ${lineId(Math.min(lineCount, start + RANGE_LINES))}`;
    }
  } else {
    for (const id of locations.keys()) options[id] = null;
  }

  let prefix = "f";
  while (rules.some((rule) => rule.name.startsWith(prefix))) prefix = `_${prefix}`;
  const questions: Record<string, Choice> = {};
  const roots = new Map<string, Map<string, string>>();
  let next = 0;
  function add(id: string, instructions: string, options: Choice["options"]) {
    const question = { type: "choice", instructions, options, optional: true } as const;
    budget -= id.length + JSON.stringify(question).length + 4;
    questions[id] = question;
    return budget >= 0;
  }
  const overBudget = { error: "source and questions exceed the citation input budget; retaining file-level findings" };
  for (const rule of rules) {
    const values = new Map<string, string>();
    roots.set(rule.name, values);
    for (const value of rule.values) {
      if (value.report === undefined) continue;
      const root = `${prefix}${next++}`;
      values.set(value.value, root);
      const instructions = [
        "If the rule has the answer below, which line needs to change to resolve the finding?",
        "For a missing safeguard, select the operation that needs it.",
        "Each L-prefixed ID refers to the numbered source line in content (L012 means line 12).",
        ...(changeset ? ["Only lines marked (new) immediately after their number and before the tab are eligible evidence."] : []),
        `Rule: ${rule.prompt}`,
        `Answer: ${value.value}. ${value.description ?? ""}`,
        `Finding: ${value.report}`,
      ].join("\n");
      const select = ranges.size ? "Which range of line IDs contains that line?" : "Answer with that line's ID.";
      if (!add(root, `${instructions}\n${select} Select none if the finding is unsupported.`, options)) return overBudget;
      for (const [range, lines] of ranges) {
        if (Object.keys(lines).length === 1) continue;
        if (!add(`${root}_${range}`, `${instructions}\nAssuming the strongest evidence is in ${options[range]}, answer with that line's ID.`, lines)) return overBudget;
      }
    }
  }
  if (!next) return;
  const threshold = config.threshold ?? DEFAULT_THRESHOLD;
  return {
    questions,
    attach(findings, answers) {
      for (const finding of findings) {
        const root = roots.get(finding.rule)!.get(finding.value)!;
        const selected = winner(answers[root], options);
        if (!selected || selected.id === "none") continue;
        let id = selected.id;
        const range = ranges.get(id);
        if (range) {
          const candidates = Object.keys(range);
          const line = candidates.length === 1
            ? { id: candidates[0], probability: 1 }
            : winner(answers[`${root}_${id}`], range);
          if (!line || !jointMeetsThreshold(selected.probability, line.probability, threshold)) continue;
          id = line.id;
        } else if (selected.probability < threshold) continue;
        finding.locations = [locations.get(id)!];
      }
    },
  };
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
