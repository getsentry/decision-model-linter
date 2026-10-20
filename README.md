# decision-model-linter

A linter in the style of eslint whose rules are questions a decision model answers. Each rule matches files by glob and asks a yes/no or multiple-choice question about every matching file. On a pull request, it asks only about the lines the pull request changes. An answer with a `report` becomes a finding once its probability reaches the rule's threshold.

The engine has no rules and no default model. Each repository supplies both in a config file.

## Config

The config is TypeScript that Node runs directly. `import type` is erased at runtime, so a repository needs nothing installed to run its config.

```ts
// decision-model-linter.config.ts
import type { Config, Model } from "@sentry/decision-model-linter";
import security from "./lint/security.ts";

const jev = {
  provider: "openrouter",
  name: "typesafe/jev-1.13",
  apiKey: process.env.OPENROUTER_API_KEY,
  maxInputTokens: 32_768,
} satisfies Model;

export default {
  model: jev,
  threshold: 0.7,
  unchecked: "warn",
  suites: { security },
} satisfies Config;
```

```ts
// lint/security.ts
import type { Suite } from "@sentry/decision-model-linter";

export default {
  files: ["src/**/*.py"],
  ignores: ["**/tests/**"],
  unchecked: "error",
  rules: {
    queriesWithoutTenantScope: {
      prompt: "Does the code query rows that belong to a tenant without filtering on the tenant?",
      values: [
        {
          value: "TRUE",
          description: "A query reaches tenant rows and filters only by a row id, or not at all.",
          severity: "error",
          report: "Filter this query on the tenant id.",
        },
        { value: "FALSE", description: "Every query filters on the tenant, or the code makes no queries." },
      ],
    },
  },
} satisfies Suite;
```

### Settings

Rule settings can be set on the config, a suite, or a rule. The nearest level wins, except `context`, which merges by name.

| Setting | Meaning |
|---|---|
| `model` | `{ provider, name, apiKey, maxInputTokens, url? }`. `openrouter` is the only provider so far. The config reads `apiKey` from the environment. `maxInputTokens` caps one call: the file, its context, and the questions together. |
| `files`, `ignores` | Globs relative to the working directory; `**` crosses directories. |
| `context` | Named extra state for the model: strings, or functions of `{ path }` called once per file. `path` and `content` are reserved for the file. |
| `threshold` | The probability an answer must reach to be reported. Default 0.7. |
| `unchecked` | `"warn"` or `"error"`: how a file is reported when a call fails or the file is cut to fit. Default `"warn"`. |

Two settings belong elsewhere:
- `concurrency`, the number of calls at once (default 16), is set on the config only.
- `severity` (`"warn"` or `"error"`, default `"warn"`) is set on each value, next to its `report`.

A rule whose values are exactly `TRUE` and `FALSE` is asked as a yes/no question; any other rule is asked as a multiple-choice question. For each file, the rules of one suite that share a model and context are asked in one call. Overriding `model` or `context` on a rule gives it its own call, which sends the file again.

If the repository's `package.json` has no `"type": "module"`, keep the config in a folder whose own `package.json` says `{ "type": "module" }`.

## Install

```sh
npm install --save-dev @sentry/decision-model-linter
```

## In GitHub Actions

The CLI knows nothing about pull requests: it lints a changeset or files, prints a report, and exits 0 when nothing fails, 1 when an error is found, or 2 when it could not finish. The workflow owns the pull request: the comment, and a label that lets a person accept a failure.

```yaml
name: Decision model lint

on:
  pull_request:
    types: [opened, reopened, synchronize, labeled, unlabeled]

concurrency:
  group: ${{ github.workflow }}-${{ github.event.number }}
  cancel-in-progress: true

jobs:
  lint:
    # Never pull_request_target, which would give a pull request's code the key. Forks get no
    # secrets, so skip them. Every label change re-runs the lint, because a skipped run would
    # replace the last result.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      # The pull request's merge commit and its first parent: HEAD^1..HEAD is what it changes.
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          fetch-depth: 2
          persist-credentials: false
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: '24'
      - run: npm ci
      - name: Lint
        env:
          OPENROUTER_API_KEY: ${{ secrets.YOUR_OPENROUTER_KEY }}
          GH_TOKEN: ${{ github.token }}
          PR: ${{ github.event.number }}
          LABEL: Override decision model lint
          OVERRIDDEN: "${{ contains(github.event.pull_request.labels.*.name, 'Override decision model lint') }}"
        run: |
          status=0
          npx decision-model-linter --base HEAD^1 --format markdown > report.md || status=$?

          # Only 1 means findings; any other failure means the linter did not finish.
          if [ "$status" -eq 1 ] && [ "$OVERRIDDEN" = true ]; then
            printf '\nThe `%s` label keeps these errors from failing the check.\n' "$LABEL" >> report.md
          elif [ "$status" -eq 1 ]; then
            printf '\nThese errors fail the check; fix the code to resolve them. If you and a reviewer are confident an error is wrong, a person can add the `%s` label to pass the check while the findings stay reported. Agents should never add this label.\n' "$LABEL" >> report.md
          fi

          marker='<!-- decision-model-linter -->'
          comment=$(gh api "repos/$GITHUB_REPOSITORY/issues/$PR/comments" --paginate \
            --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | contains(\"$marker\"))) | .id" | head -n 1)
          body=
          if [ "$status" -le 1 ] && [ -s report.md ]; then
            body=$(printf '%s\n%s' "$marker" "$(cat report.md)")
          elif [ "$status" -eq 0 ] && [ -n "$comment" ]; then
            body=$(printf '%s\nNo findings on the latest commit.' "$marker")
          fi
          if [ -n "$body" ] && [ -n "$comment" ]; then
            gh api -X PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$comment" -f body="$body" > /dev/null
          elif [ -n "$body" ]; then
            gh api "repos/$GITHUB_REPOSITORY/issues/$PR/comments" -f body="$body" > /dev/null
          fi
          cat report.md >> "$GITHUB_STEP_SUMMARY"

          if [ "$status" -ne 0 ] && [ "$OVERRIDDEN" = true ]; then exit 0; fi
          exit "$status"
```

On a pull request, this:
- lints the lines the pull request's merge commit changes relative to its first parent;
- keeps one pull request comment with the findings, the cost, and the model, and says how the override label applies when the check fails;
- passes the check when the override label is on the pull request, while the findings stay reported.

The config, its suites, and the package version in the lockfile all come from the pull request's own commit, so a pull request that adds or changes a rule is linted by it.

To try a rule on existing code, pass paths instead of `--base`: `npx decision-model-linter --suite security -- 'src/**/*.py'` lints every matching file whole.

## Locally

```sh
OPENROUTER_API_KEY=... npx decision-model-linter -- src/
```

| Flag | Meaning |
|---|---|
| `--config <path>` | Config file. Default `decision-model-linter.config.ts`. |
| `--suite <name>` | Run only this suite; repeatable. |
| `--base <ref>` | Lint only the lines changed since the merge base with `<ref>`; without paths, the files changed since then. |
| `--format stylish\|json\|github\|markdown` | Output format, to stdout. `github` prints workflow-command annotations; `markdown` prints nothing when there is nothing to report. Default `stylish`. |

Exit codes, as with eslint and ruff:
- **0** when no finding or unchecked file is at `error`.
- **1** when any finding or unchecked file is at `error`.
- **2** when the run could not finish: the config fails to load or validate, a suite or provider name is unknown, a selected rule's key is empty, or the CLI crashes.

The report goes to stdout; usage and setup errors go to stderr.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The package ships compiled JavaScript, because Node does not run TypeScript from `node_modules`. To release, run the Release workflow with a version; craft prepares the release and publishes the tarball that CI built once the release is approved in `getsentry/publish`.

## License

[FSL-1.1-ALv2](LICENSE)
