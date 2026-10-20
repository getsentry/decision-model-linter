#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { type Model, ConfigError, DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { isLinted, lint } from "./evaluate.ts";
import { resolveTargets } from "./files.ts";
import { changedFiles, changesSince } from "./git.ts";
import type { DecisionModel } from "./models.ts";
import { connect } from "./providers.ts";
import { FORMATS, type Format, exitCode, format } from "./report.ts";

const USAGE =
  "Usage: decision-model-linter [--config <path>] [--suite <name>]... [--base <ref>] [--format stylish|json|github|markdown] [--] [paths, directories, or globs...]\n" +
  "With --base and no paths, lints the files changed since the merge base with <ref>.";

export interface CliDeps {
  cwd: string;
  /** Where the report goes. */
  write: (text: string) => void;
  /** Where usage and setup errors go. */
  writeError: (text: string) => void;
  /** The decision model for a configured model; defaults to the model's provider. */
  connect?: (model: Model) => DecisionModel;
}

/** Runs the CLI with `argv`; returns 2 for a setup error or crash, 1 for an error finding or unchecked file, else 0. */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  try {
    return await run(argv, deps);
  } catch (error) {
    // Never exit 1 on a crash: callers read 1 as findings.
    deps.writeError(`decision-model-linter: ${(error as Error).stack ?? String(error)}\n`);
    return 2;
  }
}

/** Parses `argv`, loads the config, and lints; see `main` for the exit codes. */
async function run(argv: string[], deps: CliDeps): Promise<number> {
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
      },
    });
  } catch (error) {
    deps.writeError(`${(error as Error).message}\n${USAGE}\n`);
    return 2;
  }
  const kind = args.values.format as Format;
  if (!FORMATS.includes(kind)) {
    deps.writeError(`unknown format '${kind}'\n${USAGE}\n`);
    return 2;
  }

  let config;
  try {
    config = await loadConfig(resolve(deps.cwd, args.values.config), args.values.suite);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    deps.writeError(`decision-model-linter config: ${error.message}\n`);
    return 2;
  }
  const { rules, concurrency } = config;
  const missingKeys = [...new Set(rules.filter((rule) => !rule.model.apiKey?.trim()).map((rule) => rule.modelAt))];
  if (missingKeys.length) {
    const settings = missingKeys.map((at) => `${at}.apiKey`).join(", ");
    deps.writeError(`decision-model-linter config: ${settings} is empty; set the environment variable the config reads it from\n`);
    return 2;
  }

  // With --base and no paths, the files changed since the merge base; with neither, everything.
  let targets = args.positionals;
  if (!targets.length && args.values.base) {
    try {
      targets = await changedFiles(deps.cwd, args.values.base);
    } catch (error) {
      deps.writeError(`decision-model-linter: cannot diff against ${args.values.base}: ${(error as Error).message}\n`);
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
      deps.writeError(`decision-model-linter: cannot diff against ${args.values.base}: ${(error as Error).message}\n`);
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
  deps.write(format(results, kind));
  return exitCode(results);
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    write: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
  });
  process.exitCode = code;
}
