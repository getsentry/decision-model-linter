import { DEFAULT_THRESHOLD, type Citation, type ResolvedRule } from "./config.ts";
import type { Finding, SourceLocation } from "./evaluate.ts";
import type { Question, State } from "./models.ts";
import { openRouter } from "./openrouter.ts";

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
  const source = state.content;
  const model = rules[0].model;
  const choices: Record<string, string> = { none: "No source line supports the reported answer and finding." };
  const locations = new Map<string, SourceLocation>();
  for (const [index, raw] of source.split("\n").entries()) {
    const line = index + 1;
    const text = raw.replace(/\r$/, "");
    if (!text.trim() || (changed && !changed.has(line))) continue;
    const id = `line_${line}`;
    choices[id] = `Line ${line}: ${text}`;
    locations.set(id, { line, endLine: line, col: 1, endColumn: Array.from(text).length });
  }
  if (!locations.size || !findings.length) return { calls: 0 };
  const questions: Record<string, Question> = Object.fromEntries(findings.map((finding, i) => {
    const rule = rules.find((rule) => rule.name === finding.rule)!;
    return [`f${i}`, {
      type: "choice",
      instructions: [
        "Which source line is the strongest evidence for this lint finding?",
        "Select the line that needs to change to resolve the finding.",
        "For a missing safeguard, select the operation that needs it. Select none if the finding is unsupported.",
        `Rule: ${rule.prompt}`,
        `Reported answer: ${finding.value}. ${rule.values.find((value) => value.value === finding.value)?.description ?? ""}`,
        `Finding: ${finding.message}`,
      ].join("\n"),
      options: choices,
    }];
  }));
  if (JSON.stringify(state).length + JSON.stringify(questions).length + 512 > model.maxInputTokens * 3) {
    return { calls: 0, error: "source and questions exceed the citation input budget" };
  }
  const result: CitationResult = { calls: 1 };
  try {
    const output = await openRouter({ ...model, apiKey: model.apiKey ?? "", timeoutMs: 30_000, retries: 0 }).decide(state, questions);
    const tokens = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
    result.inputTokens = tokens(output.inputTokens);
    result.outputTokens = tokens(output.outputTokens);
    for (const [i, finding] of findings.entries()) {
      const answer = output.answers[`f${i}`];
      if (answer?.type !== "choice") continue;
      const probabilities = Object.entries(answer.probabilities);
      if (probabilities.length !== Object.keys(choices).length || probabilities.some(([id, probability]) =>
        !Object.hasOwn(choices, id) || !Number.isFinite(probability) || probability < 0 || probability > 1)) continue;
      if (Math.abs(probabilities.reduce((sum, [, probability]) => sum + probability, 0) - 1) > 1e-6) continue;
      probabilities.sort((a, b) => b[1] - a[1]);
      const [id, probability] = probabilities[0];
      if (probability < (options.threshold ?? DEFAULT_THRESHOLD) || probabilities[1]?.[1] === probability) continue;
      const location = locations.get(id);
      if (location) finding.locations = [location];
    }
  } catch {
    // Provider errors can contain credentials or source; keep them out of reports.
    result.error = "citation request failed; retaining file-level findings";
  }
  return result;
}
