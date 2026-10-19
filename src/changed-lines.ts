// What Jev is shown of a changed file: the changed lines and the bracketed expression each one
// sits inside, never the blocks around it. Jev answers about everything it is shown, so other
// unchanged code could put an existing problem into the answer.

// Longer expressions (a whole urlpatterns list) show only the lines that open them.
const MAX_EXPRESSION_LINES = 30;

/**
 * Line numbers to show for a changed file: each changed line, the whole innermost bracketed
 * expression around it (so a new `.where(...)` shows the rest of its query), and outer openers.
 */
export function linesToShow(source: string, changed: ReadonlySet<number>, path: string): Set<number> {
  const shown = new Set(changed);
  const spans = bracketSpans(source, path);
  for (const line of changed) {
    const enclosing = spans.filter((span) => span.open < line && line <= span.close);
    for (const span of enclosing) shown.add(span.open);
    const innermost = enclosing.reduce<Span | undefined>(
      (best, span) => (!best || span.open > best.open || (span.open === best.open && span.close < best.close) ? span : best),
      undefined,
    );
    if (innermost && innermost.close - innermost.open < MAX_EXPRESSION_LINES) {
      for (let l = innermost.open; l <= innermost.close; l++) shown.add(l);
    }
  }
  return shown;
}

/** The file's lines with each run of lines not in `shown` replaced by one omission marker. */
export function collapseHiddenLines(lines: readonly string[], shown: ReadonlySet<number>): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (shown.has(i + 1)) {
      out.push(lines[i++]);
      continue;
    }
    const start = i;
    while (i < lines.length && !shown.has(i + 1)) i++;
    out.push(`\t[decision-model-linter: lines ${start + 1}-${i} omitted]`);
  }
  return out;
}

interface Span {
  open: number;
  close: number;
}

/** The first and last line of every bracket pair, ignoring brackets in strings and comments. */
function bracketSpans(source: string, path: string): Span[] {
  const spans: Span[] = [];
  const open: number[] = [];
  let line = 1;
  for (const ch of blankStringsAndComments(source, path)) {
    if (ch === "\n") line++;
    else if ("([{".includes(ch)) open.push(line);
    else if (")]}".includes(ch) && open.length) spans.push({ open: open.pop()!, close: line });
  }
  for (const start of open) spans.push({ open: start, close: line });
  return spans;
}

/** `source` with strings and comments blanked to spaces (newlines kept), so their brackets don't count. */
function blankStringsAndComments(source: string, path: string): string {
  const python = path.endsWith(".py");
  const out = source.split("");
  for (let i = 0; i < source.length; i++) {
    const end = commentEnd(source, i, python) ?? stringEnd(source, i);
    if (end === undefined) continue;
    for (let j = i; j < end; j++) if (out[j] !== "\n") out[j] = " ";
    i = end - 1;
  }
  return out.join("");
}

/** Where a comment starting at `i` ends, or undefined if none starts there. */
function commentEnd(source: string, i: number, python: boolean): number | undefined {
  if (python ? source[i] === "#" : source.startsWith("//", i)) return lineEnd(source, i);
  if (!python && source.startsWith("/*", i)) {
    const close = source.indexOf("*/", i + 2);
    return close === -1 ? source.length : close + 2;
  }
  return undefined;
}

/** Where a string literal starting at `i` ends, or undefined if none starts there. */
function stringEnd(source: string, i: number): number | undefined {
  const quote = ['"""', "'''", '"', "'", "`"].find((q) => source.startsWith(q, i));
  if (!quote) return undefined;
  for (let j = i + quote.length; j < source.length; j++) {
    if (source[j] === "\\") j++;
    else if (source.startsWith(quote, j)) return j + quote.length;
    // Only triple-quoted and template strings span lines; stop an unterminated one at the line end.
    else if (source[j] === "\n" && quote.length === 1 && quote !== "`") return j;
  }
  return source.length;
}

/** The end of the line containing `i`. */
function lineEnd(source: string, i: number): number {
  const end = source.indexOf("\n", i);
  return end === -1 ? source.length : end;
}
