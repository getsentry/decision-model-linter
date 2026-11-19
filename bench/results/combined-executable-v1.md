# Combined detection and citation

Live run completed 2026-11-19T16:26:45.587Z. Model: `typesafe/jev-1.13`. Harness: `ebf69c465d329bd6d780add7732cf59f2c847feb`.

Five paired repetitions of 22 synthetic fixtures, with the starting strategy alternating by fixture and repetition. Each variant ran 80 positive and 30 clean trials. Both variants used identical filtered source and hypothetical citation prompts.

| Outcome | Two-pass | Combined |
| --- | ---: | ---: |
| Positive detections | 80/80 | 80/80 |
| Correct confident citations | 80/80 | 80/80 |
| Clean trials without findings | 30/30 | 30/30 |
| Confidently wrong citations | 0 | 0 |
| HTTP requests | 190 | 110 |
| Input tokens | 1,737,300 | 1,258,260 |
| Output tokens | 543,400 | 613,055 |
| Reported total cost | $0.072967 | $0.052847 |

| Fixture group | Two-pass median latency | Combined median latency | Two-pass reported cost | Combined reported cost |
| --- | ---: | ---: | ---: | ---: |
| Positive, 80 trials | 501 ms | 255 ms | $0.069693 | $0.046504 |
| Clean, 30 trials | 188 ms | 182 ms | $0.003274 | $0.006343 |

Combined had lower median latency on all 16 positive fixtures. Clean fixtures split three faster and three slower, so this run shows no consistent clean-file latency benefit. Positive-trial latency ranges were 282–1548 ms for two-pass and 139–992 ms for combined. Clean ranges were 130–377 ms and 130–640 ms, respectively.

The mixed fixture set cost 27.6% less with combined requests. Clean-trial cost was 1.94 times higher because unused citation questions still cost tokens. This fixture mix is mostly positive; it does not establish savings for mostly-clean repositories.

All 300 HTTP requests succeeded without retries, citation errors, or missing usage/cost. Latency includes request construction, all awaited calls, and response processing. The raw data contains every trial and each group’s median and full range.

Large fixtures are compiler-checked TypeScript functions with simple filler statements and planted violations at the original target lines. An initial run using the historical concatenated source corpus was excluded from these detection results because some planted statements landed inside type declarations. Historical citation-only strategies retain that corpus. The paired baseline deliberately uses the same filtered view as combined; production two-pass citation currently sees the full file.

The result supports a combined-request prototype for latency. Each fixture has one rule; multiple-rule batching and real-PR accuracy remain unmeasured. Client/server timing components were not isolated. These results do not establish production cost savings or change the production linter.

Reproduce with:

```sh
OPENROUTER_API_KEY=... node bench/citation-strategies.ts --only two-pass,combined --repeats 5 --output results.json
```

[Raw trial data](combined-executable-v1.json). The API key was supplied only to the local process; it is not in the artifacts. GitHub Actions still requires its configured repository secret for future live runs.
