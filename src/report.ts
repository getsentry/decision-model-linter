import type { Severity } from "./config.ts";
import type { CallResult, Finding } from "./evaluate.ts";

export const FORMATS = ["stylish", "json", "github", "markdown"] as const;
export type Format = (typeof FORMATS)[number];

export interface Usage {
  calls: number;
  files: number;
  inputTokens: number;
  outputTokens: number;
  /** USD, as the provider reports it per call. */
  cost: number;
  /** Calls whose cost the provider did not report, so `cost` undercounts. */
  unpriced: number;
  /** Every model version that answered, so a change behind an alias shows up. */
  models: string[];
}

/** Totals of calls, files, tokens, and cost across a run. */
export function usage(results: readonly CallResult[]): Usage {
  const asked = results.filter((r) => r.inputTokens !== undefined);
  return {
    calls: results.length,
    files: new Set(results.map((r) => r.path)).size,
    inputTokens: asked.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0),
    outputTokens: asked.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0),
    cost: results.reduce((sum, r) => sum + (r.cost ?? 0), 0),
    unpriced: asked.filter((r) => r.cost === undefined).length,
    models: [...new Set(results.flatMap((r) => (r.model ? [r.model] : [])))].sort(),
  };
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumSignificantDigits: 2 });

/** One line: "4 calls on 3 files, 9,812 input tokens, $0.00041". */
export function describeUsage(u: Usage): string {
  const parts = [
    `${u.calls} ${u.calls === 1 ? "call" : "calls"} on ${u.files} ${u.files === 1 ? "file" : "files"}`,
    `${u.inputTokens.toLocaleString("en-US")} input tokens`,
    u.cost > 0 ? USD.format(u.cost) : "$0",
  ];
  if (u.unpriced) parts.push(`cost missing for ${u.unpriced}`);
  if (u.models.length) parts.push(`model ${u.models.join(", ")}`);
  return parts.join(", ");
}

/** The run's results in one output format. */
export function format(results: readonly CallResult[], kind: Format): string {
  if (kind === "json") return `${JSON.stringify(results, null, 2)}\n`;
  if (kind === "github") return github(results);
  if (kind === "markdown") return markdown(results);
  return stylish(results);
}

/** Findings and unchecked files grouped by file, eslint-style, ending with the totals and usage. */
function stylish(results: readonly CallResult[]): string {
  const lines: string[] = [];
  const counts: Record<Severity, number> = { error: 0, warn: 0 };
  for (const [path, calls] of groupByPath(results)) {
    const problems = calls.flatMap((call) => [
      ...call.findings.map((f) => {
        counts[f.severity]++;
        return `  ${f.severity.padEnd(5)}  ${f.suite}/${f.rule} = ${f.value} (${f.probability.toFixed(2)})  ${oneLine(f.message)}`;
      }),
      ...(call.unchecked ? [`  ${call.unchecked.padEnd(5)}  ${call.suite}: ${gap(call)}`] : []),
    ]);
    for (const call of calls) if (call.unchecked) counts[call.unchecked]++;
    if (problems.length) lines.push(path, ...problems, "");
  }
  const total = counts.error + counts.warn;
  if (total > 0) {
    lines.push(
      `✖ ${total} ${total === 1 ? "problem" : "problems"} (${plural(counts.error, "error")}, ${plural(counts.warn, "warning")})`,
    );
  }
  lines.push(`decision-model-linter: ${describeUsage(usage(results))}`);
  return `${lines.join("\n")}\n`;
}

/** One GitHub workflow command per finding and unchecked file, plus a notice with the run's usage. */
function github(results: readonly CallResult[]): string {
  const command = (severity: Severity) => (severity === "error" ? "error" : "warning");
  const lines = results.flatMap((call) => [
    ...call.findings.map(
      (f) =>
        `::${command(f.severity)} file=${property(f.path)},title=${property(`decision-model-linter ${f.suite}/${f.rule}`)}::${data(f.message)}`,
    ),
    ...(call.unchecked
      ? [`::${command(call.unchecked)} file=${property(call.path)},title=${property(`decision-model-linter ${call.suite}`)}::${data(gap(call))}`]
      : []),
  ]);
  lines.push(`::notice title=${property("decision-model-linter usage")}::${data(describeUsage(usage(results)))}`);
  return `${lines.join("\n")}\n`;
}

/** A section per suite with findings by file, then any unchecked files and the usage; empty if clean. */
function markdown(results: readonly CallResult[]): string {
  const bySuite = new Map<string, Finding[]>();
  for (const call of results) {
    if (call.findings.length) bySuite.set(call.suite, [...(bySuite.get(call.suite) ?? []), ...call.findings]);
  }
  const unchecked = results.filter((call) => call.unchecked);
  if (!bySuite.size && !unchecked.length) return "";
  const sections = [...bySuite.keys()].sort().map((suite) => {
    const byPath = new Map<string, Finding[]>();
    for (const f of bySuite.get(suite)!) byPath.set(f.path, [...(byPath.get(f.path) ?? []), f]);
    const files = [...byPath.keys()].sort().map((path) => {
      const items = byPath
        .get(path)!
        .map((f) => `- **${f.severity}** \`${f.rule} = ${f.value}\` (${f.probability.toFixed(2)}): ${f.message.trim()}`);
      return `**\`${path}\`**\n\n${items.join("\n")}`;
    });
    return `### ${suite}\n\n${files.join("\n\n")}`;
  });
  if (unchecked.length) sections.push(notFullyChecked(unchecked));
  return `## decision-model-linter\n\n${sections.join("\n\n")}\n\n${footer(results)}`;
}

/** The section for files the model did not see in full, so a partial run never reads as clean. */
function notFullyChecked(unchecked: readonly CallResult[]): string {
  const items = unchecked.map((call) => `- **${call.unchecked}** \`${call.path}\` (${call.suite}): ${gap(call)}`);
  return `### Not fully checked\n\nFindings may be missing for these files:\n\n${items.join("\n")}`;
}

/** Why a call did not check its whole file or change. */
function gap(call: CallResult): string {
  if (call.error) return `not checked: ${oneLine(call.error).slice(0, 200)}`;
  return "too large for one call, so the end was not checked";
}

/** The report's last line: what this run cost. */
function footer(results: readonly CallResult[]): string {
  return `<sub>decision-model-linter: ${describeUsage(usage(results))}</sub>\n`;
}

/** 1 if any finding or unchecked file is at `error`, else 0. */
export function exitCode(results: readonly CallResult[]): number {
  const failed = results.some((call) => call.unchecked === "error" || call.findings.some((f) => f.severity === "error"));
  return failed ? 1 : 0;
}

/** Results grouped by file, sorted by file, suite, and first rule. */
function groupByPath(results: readonly CallResult[]): Map<string, CallResult[]> {
  const byPath = new Map<string, CallResult[]>();
  for (const call of [...results].sort(
    (a, b) => a.path.localeCompare(b.path) || a.suite.localeCompare(b.suite) || a.rules[0].localeCompare(b.rules[0]),
  )) {
    byPath.set(call.path, [...(byPath.get(call.path) ?? []), call]);
  }
  return byPath;
}

/** `count` and `noun`, pluralized. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** `text` on one line. */
function oneLine(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** `text` escaped for a workflow command message, per GitHub's syntax. */
function data(text: string): string {
  return oneLine(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** `text` escaped for a workflow command property (file=, title=). */
function property(text: string): string {
  return data(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}
