# Citation strategies

Run a controlled comparison of two HTTP requests against one combined request:

```sh
OPENROUTER_API_KEY=... node bench/citation-strategies.ts --only two-pass,combined --repeats 5 --output results.json
```

`two-pass` asks the lint question first and requests a citation only if it flags.
`combined` asks that same question and the same hypothetical citation questions together,
then ignores citations when the lint answer does not flag. Both variants use the same
source view, including the linter's filtering of unchanged code in changesets. This
isolates batching; it does not reproduce the production citation pass's full-file view.

Large end-to-end fixtures put the planted statement inside a valid TypeScript function,
with simple filler statements and its original line number. Their syntax is compiler-checked.
The historical citation strategies retain the original concatenated repository corpus,
which can put a planted statement inside a type declaration and is unsuitable as detection
ground truth. Results identify the paired fixture set as `executable-v1`. These are
synthetic cases with obvious violations, not a production-code accuracy estimate.

Each repetition and fixture alternates which strategy runs first. Results separate detection errors
from citation errors and report clean and flagged fixtures separately. Request counts
include HTTP retries. Latency covers the complete trial, including both calls and retry
waits, and its median and range exclude transport or malformed-answer failures.
Missing usage and cost are counted explicitly. The JSON artifact includes every trial;
its fixture mix does not imply the same savings for a mostly-clean repository.
The clean and flagged groups use fixture ground truth, not the model's decision.

The original `lines`, `lines-windowed`, `digits-*`, and `ids` strategies measure only
citation and remain available. Their timings cannot be compared directly with the
end-to-end variants. The two changeset fixtures run only for the end-to-end variants.

For request construction without model calls:

```sh
node bench/citation-strategies.ts --dry --only two-pass,combined --output dry.json
```

A dry run records planned request shapes, assuming the two-pass lint question flags.
It does not produce accuracy, token usage, or latency measurements. The HTTP-stub
tests verify the harness, not model accuracy. Live runs require an OpenRouter key;
GitHub Actions uses `DECISION_MODEL_LINTER_OPENROUTER_API_KEY` and uploads JSON and logs.
