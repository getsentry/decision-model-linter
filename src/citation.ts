import type { Citation, ResolvedRule } from "./config.ts";
import type { Finding } from "./evaluate.ts";
import { openRouterExtract } from "./openrouter.ts";

/** One-based source coordinates, with an inclusive end, as GitHub annotations expect. */
export interface SourceLocation {
  line: number;
  endLine: number;
  col: number;
  endColumn: number;
}

/** Kept separate from decision usage: extraction failure is not a failed lint decision. */
export interface CitationResult {
  calls: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

class CitationError extends Error {}

/** Enriches findings in place. No source is truncated and no finding is removed on failure. */
export async function citeFindings(
  source: string,
  findings: Finding[],
  rules: readonly ResolvedRule[],
  changed: ReadonlySet<number> | undefined,
  options: Citation,
): Promise<CitationResult> {
  const fields = Object.fromEntries(findings.map((finding, i) => {
    const rule = rules.find((rule) => rule.name === finding.rule)!;
    return [`f${i}`, {
      type: "list",
      items: "text",
      instructions: [
        "Extract the smallest complete source expressions or statements that are evidence for this finding.",
        "Return each occurrence separately. Return no evidence if the finding is unsupported.",
        "For a missing safeguard, select the operation that needs that safeguard.",
        ...(changed ? [`Only select evidence overlapping these changed source lines (one-based): ${[...changed].sort((a, b) => a - b).join(", ")}.`] : []),
        `Rule: ${rule.prompt}`,
        `Reported answer: ${finding.value}. ${rule.values.find((value) => value.value === finding.value)?.description ?? ""}`,
        `Finding: ${finding.message}`,
        ...(rule.citationPrompt ? [rule.citationPrompt] : []),
      ].join("\n"),
    }];
  }));
  // Match the engine's conservative three-characters-per-token estimate. Skip rather than
  // changing the source, which would invalidate offsets or hide relevant evidence.
  if (source.length + JSON.stringify(fields).length + 512 > options.maxInputTokens * 3) {
    return { calls: 0, error: "source and extraction fields exceed the citation input budget" };
  }
  const result: CitationResult = { calls: 1 };
  try {
    const output = await openRouterExtract(options, source, fields);
    const tokens = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
    result.inputTokens = tokens(output.usage?.input_tokens);
    result.outputTokens = tokens(output.usage?.output_tokens);
    if (output.truncated) throw new CitationError("citation input was truncated");
    if (output.state_text != null && output.state_text !== source) {
      throw new CitationError("citation offsets refer to different source text");
    }
    if (!output.answers || typeof output.answers !== "object") throw new CitationError("citation returned no answers");
    for (const [i, finding] of findings.entries()) {
      const answer = output.answers[`f${i}`];
      if (answer?.type !== "list" || !Array.isArray(answer.value) || !Array.isArray(answer.spans) ||
          !Number.isFinite(answer.confidence) || answer.confidence > 1 || answer.confidence < (options.threshold ?? 0.7) ||
          answer.value.length !== answer.spans.length) continue;
      const locations: SourceLocation[] = [];
      for (let index = 0; index < answer.value.length; index++) {
        const offsets = validatedOffsets(source, answer.spans[index], answer.value[index]);
        if (!offsets) continue;
        const [start, end] = offsets;
        const location = coordinates(source, start, end);
        if (changed && ![...changed].some((line) => line >= location.line && line <= location.endLine)) continue;
        if (!locations.some((existing) => JSON.stringify(existing) === JSON.stringify(location))) locations.push(location);
      }
      if (locations.length) finding.locations = locations;
    }
  } catch (error) {
    // Do not log provider response bodies, URLs or exception messages: they can contain credentials
    // or source. A failed optional extraction pass leaves the original findings intact.
    result.error = `${error instanceof CitationError ? error.message : "citation request failed"}; retaining file-level findings`;
  }
  return result;
}

/** Validate half-open character spans against the extracted text before trusting coordinates.
 * Providers may count Unicode code points or UTF-16 units. Accept only an exact, unambiguous match.
 */
export function validatedOffsets(source: string, span: unknown, text: unknown): [number, number] | undefined {
  if (!Array.isArray(span) || span.length !== 2 || !span.every(Number.isInteger) ||
      span[0] < 0 || span[1] <= span[0] || typeof text !== "string" || !text.trim().length) return;
  const [start, end] = span;
  const matches: [number, number][] = [];
  if (end <= source.length && source.slice(start, end) === text) matches.push([start, end]);
  const points = Array.from(source);
  if (end <= points.length && points.slice(start, end).join("") === text) {
    matches.push([points.slice(0, start).join("").length, points.slice(0, end).join("").length]);
  }
  if (!matches.length || matches.some(([a, b]) => a !== matches[0][0] || b !== matches[0][1])) return;
  return matches[0];
}

/** Columns count Unicode code points; CRLF remains intact for validating provider offsets. */
function coordinates(source: string, start: number, end: number): SourceLocation {
  // Trailing line breaks are not useful annotation targets.
  while (end > start && /[\r\n]/.test(source[end - 1])) end--;
  const position = (offset: number) => {
    const before = source.slice(0, offset);
    return { line: before.split("\n").length, col: Array.from(before.slice(before.lastIndexOf("\n") + 1)).length + 1 };
  };
  const first = position(start);
  const last = position(Math.max(start, end - (source.codePointAt(end - 2)! > 0xffff ? 2 : 1)));
  return { line: first.line, col: first.col, endLine: last.line, endColumn: last.col };
}
