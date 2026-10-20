#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { type Model, ConfigError, DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { isLinted, lint } from "./evaluate.ts";
import { resolveTargets } from "./files.ts";
import { changedFiles, changesSince } from "./git.ts";
import { githubComments, upsertComment } from "./github.ts";
import type { DecisionModel } from "./models.ts";
import { connect } from "./providers.ts";
import { type Format, type Override, cleanComment, exitCode, format, prComment, summary } from "./report.ts";

const USAGE =
  "Usage: decision-model-linter [--config <path>] [--suite <name>]... [--base <ref>] [--format stylish|json|github] [--pr-comment] [--] [paths, directories, or globs...]\n" +
  "With --base and no paths, lints the files changed since the merge base with <ref>.";

export interface CliDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  write: (text: string) => void;
  /** The decision model for a configured model; defaults to the model's provider. */
  connect?: (model: Model) => DecisionModel;
}

/**
 * Runs the CLI with `argv`; returns 2 for a setup error, 1 for an error finding or unchecked file
 * unless the pull request has the config's override label, else 0.
 */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  // The config is code, and it runs with the key in its environment.
  if (deps.env.GITHUB_EVENT_NAME === "pull_request_target") {
    deps.write("decision-model-linter: refusing to run on pull_request_target, which gives a PR's code the key; use pull_request\n");
    return 2;
  }

  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: "string", default: DEFAULT_CONFIG },
        suite: { type: "string", multiple: true, default: [] },
        base: { type: "string" },
        format: { type: "string", default: "stylish" },
        "pr-comment": { type: "boolean", default: false },
      },
    });
  } catch (error) {
    deps.write(`${(error as Error).message}\n${USAGE}\n`);
    return 2;
  }
  const kind = args.values.format as Format;
  if (!["stylish", "json", "github"].includes(kind)) {
    deps.write(`unknown format '${kind}'\n${USAGE}\n`);
    return 2;
  }

  let config;
  try {
    config = await loadConfig(resolve(deps.cwd, args.values.config), args.values.suite);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    deps.write(`decision-model-linter config: ${error.message}\n`);
    return 2;
  }
  const { rules, concurrency, overrideLabel } = config;
  const missingKeys = [...new Set(rules.filter((rule) => !rule.model.apiKey?.trim()).map((rule) => rule.modelAt))];
  if (missingKeys.length) {
    const settings = missingKeys.map((at) => `${at}.apiKey`).join(", ");
    deps.write(`decision-model-linter config: ${settings} is empty; set the environment variable the config reads it from\n`);
    return 2;
  }

  // With --base and no paths, the files changed since the merge base; with neither, everything.
  let targets = args.positionals;
  if (!targets.length && args.values.base) {
    try {
      targets = await changedFiles(deps.cwd, args.values.base);
    } catch (error) {
      deps.write(`decision-model-linter: cannot diff against ${args.values.base}: ${(error as Error).message}\n`);
      return 2;
    }
    if (!targets.length) return 0;
  } else if (!targets.length) {
    targets = ["."];
  }
  let paths = (await resolveTargets(targets, deps.cwd)).filter((path) => isLinted(rules, path));

  // With --base, unchanged files are skipped and modified files are linted on their new lines only.
  const newLines = new Map<string, Set<number>>();
  const renamedFrom = new Map<string, string>();
  if (args.values.base) {
    let changes;
    try {
      changes = await changesSince(deps.cwd, args.values.base, paths);
    } catch (error) {
      deps.write(`decision-model-linter: cannot diff against ${args.values.base}: ${(error as Error).message}\n`);
      return 2;
    }
    // An unchanged rename is kept: a rule that did not cover its old path still lints it whole.
    paths = paths.filter((path) => {
      const change = changes.get(path);
      return change?.kind !== "unchanged" || change.from !== undefined;
    });
    for (const [path, change] of changes) {
      if (change.kind === "modified") newLines.set(path, change.newLines);
      if (change.kind !== "new" && change.from) renamedFrom.set(path, change.from);
    }
  }
  if (!paths.length) return 0;

  const results = await lint(rules, paths, {
    cwd: deps.cwd,
    connect: deps.connect ?? connect,
    concurrency,
    newLines,
    renamedFrom,
  });
  const pr = await pullRequest(deps.env);
  const override: Override | undefined = overrideLabel
    ? { label: overrideLabel, applied: pr?.labels.includes(overrideLabel) ?? false }
    : undefined;
  deps.write(format(results, kind, override));
  if (deps.env.GITHUB_STEP_SUMMARY) await appendFile(deps.env.GITHUB_STEP_SUMMARY, summary(results));

  if (args.values["pr-comment"] && pr) {
    const api = githubComments(deps.env.GITHUB_TOKEN ?? "", deps.env.GITHUB_REPOSITORY ?? "");
    const action = await upsertComment(api, pr.number, prComment(results, override), cleanComment(results));
    deps.write(`decision-model-linter PR comment: ${action}\n`);
  }
  const code = exitCode(results);
  return code === 1 && override?.applied ? 0 : code;
}

/** The pull request's number and labels from the GitHub event, or null outside a pull request. */
async function pullRequest(env: NodeJS.ProcessEnv): Promise<{ number: number; labels: string[] } | null> {
  if (!env.GITHUB_EVENT_PATH) return null;
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
  const pr = event.pull_request;
  if (!pr) return null;
  return { number: pr.number, labels: (pr.labels ?? []).map((label: { name: string }) => label.name) };
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    write: (text) => process.stdout.write(text),
  });
  process.exitCode = code;
}
