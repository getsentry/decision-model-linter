# decision-model-linter

A linter in the style of eslint whose rules are questions a decision model answers. Each rule matches files by glob and asks a yes/no or multiple-choice question about every matching file. On a pull request, it asks only about the lines the pull request changes. An answer with a `report` becomes a finding once its probability reaches the rule's threshold.

The engine has no rules and no default model. Each repository supplies both in a config file.

## Config

The config is TypeScript that Node runs directly. `import type` is erased at runtime, so a repository needs nothing installed to run its config.

```ts
// decision-model-linter.config.ts
import type { Config, Model } from "@getsentry/decision-model-linter";
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
import type { Suite } from "@getsentry/decision-model-linter";

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

## In GitHub Actions

The package is published to GitHub Packages. Each repository that installs it needs read access, granted in the package's settings under "Manage Actions access".

```yaml
name: Decision model lint

on:
  pull_request:

jobs:
  lint:
    # Pull requests from forks get no secrets. Never use pull_request_target, which would give a
    # pull request's code the key; the linter refuses to run on it.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: read
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
          registry-url: https://npm.pkg.github.com
          scope: '@getsentry'
      - name: Lint
        env:
          NODE_AUTH_TOKEN: ${{ github.token }}
          GITHUB_TOKEN: ${{ github.token }}
          OPENROUTER_API_KEY: ${{ secrets.YOUR_OPENROUTER_KEY }}
        run: >-
          npx --yes @getsentry/decision-model-linter@0.1.0
          --config decision-model-linter.config.ts
          --base HEAD^1 --format github --pr-comment
```

On a pull request, this:
- lints the lines the pull request's merge commit changes relative to its first parent;
- annotates findings;
- keeps one pull request comment up to date;
- reports each run's calls, tokens, cost, and model.

The config and its suites come from the pull request's own commit, and the version is pinned in the workflow. A pull request that adds or changes a rule is linted by it.

To try a rule on existing code, pass paths instead of `--base`, for example in a `workflow_dispatch` run: `--suite security -- 'src/**/*.py'` lints every matching file whole.

## Locally

Installing from GitHub Packages needs a token with `read:packages`, for example from `gh auth refresh -s read:packages`:

```sh
npm config set @getsentry:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken "$(gh auth token)"
OPENROUTER_API_KEY=... npx @getsentry/decision-model-linter@0.1.0 --config decision-model-linter.config.ts -- src/
```

| Flag | Meaning |
|---|---|
| `--config <path>` | Config file. Default `decision-model-linter.config.ts`. |
| `--suite <name>` | Run only this suite; repeatable. |
| `--base <ref>` | Lint only the lines changed since the merge base with `<ref>`; without paths, the files changed since then. |
| `--format stylish\|json\|github` | Output format. Default `stylish`. |
| `--pr-comment` | Keep the pull request comment up to date (in GitHub Actions). |

Exit codes:
- **2** on a setup error: the config fails to load or validate, a suite or provider name is unknown, or a selected rule's key is empty.
- **1** when any finding or unchecked file is at `error`.
- **0** otherwise.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The package ships compiled JavaScript, because Node does not run TypeScript from `node_modules`. To release, bump `version` in `package.json`, merge, and push a `v<version>` tag; the Publish workflow publishes it.

## License

[FSL-1.1-ALv2](LICENSE)
