#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { SuiteError, loadSuites } from "./suites.ts";
import { isLinted, lint } from "./evaluate.ts";
import { resolveTargets } from "./files.ts";
import { changesSince } from "./git.ts";
import { githubComments, upsertComment } from "./github.ts";
import { type JevClient, JevError, openRouterJev } from "./jev.ts";
import { type Format, cleanComment, exitCode, format, prComment, summary } from "./report.ts";

const USAGE =
  "Usage: decision-model-linter [--suites <dir>] [--suite <name>]... [--base <ref>] [--format stylish|json|github] [--pr-comment] [--model <id>] [--url <decisions url>] [paths or globs...]";

export interface CliDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  write: (text: string) => void;
  client?: JevClient;
}

/** Runs the CLI with `argv`; returns the exit code: 1 for error findings, 2 when suites cannot load, else 0. */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        suites: { type: "string", default: "decision-model-linter" },
        suite: { type: "string", multiple: true, default: [] },
        base: { type: "string" },
        format: { type: "string", default: "stylish" },
        "pr-comment": { type: "boolean", default: false },
        concurrency: { type: "string", default: "16" },
        // Another model or endpoint, such as a newer Jev, without changing the code.
        model: { type: "string" },
        url: { type: "string" },
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

  let suites;
  try {
    suites = await loadSuites(resolve(deps.cwd, args.values.suites), args.values.suite);
  } catch (error) {
    if (!(error instanceof SuiteError)) throw error;
    deps.write(`decision-model-linter suites: ${error.message}\n`);
    return 2;
  }

  const targets = args.positionals.length ? args.positionals : ["."];
  let paths = (await resolveTargets(targets, deps.cwd)).filter((path) => isLinted(suites, path));

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
    // An unchanged rename is kept: an entry that did not cover its old path still lints it whole.
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

  let client = deps.client;
  try {
    client ??= openRouterJev({
      apiKey: deps.env.OPENROUTER_API_KEY ?? "",
      ...(args.values.model ? { model: args.values.model } : {}),
      ...(args.values.url ? { url: args.values.url } : {}),
    });
  } catch (error) {
    if (!(error instanceof JevError)) throw error;
    deps.write(`decision-model-linter: ${error.message} (set OPENROUTER_API_KEY)\n`);
    return 2;
  }
  const results = await lint(suites, paths, {
    cwd: deps.cwd,
    client,
    concurrency: Number(args.values.concurrency),
    newLines,
    renamedFrom,
  });
  deps.write(format(results, kind));
  if (deps.env.GITHUB_STEP_SUMMARY) await appendFile(deps.env.GITHUB_STEP_SUMMARY, summary(results));

  if (args.values["pr-comment"]) {
    const pr = await pullRequestNumber(deps.env);
    if (pr !== null) {
      const api = githubComments(deps.env.GITHUB_TOKEN ?? "", deps.env.GITHUB_REPOSITORY ?? "");
      deps.write(`decision-model-linter PR comment: ${await upsertComment(api, pr, prComment(results), cleanComment(results))}\n`);
    }
  }
  return exitCode(results);
}

/** The pull request number from the GitHub event, or null outside a pull request. */
async function pullRequestNumber(env: NodeJS.ProcessEnv): Promise<number | null> {
  if (!env.GITHUB_EVENT_PATH) return null;
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
  return event.pull_request?.number ?? null;
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    write: (text) => process.stdout.write(text),
  });
  process.exitCode = code;
}
