import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** How a file differs from the merge base; `from` is its old path when it was renamed. */
export type Change =
  | { kind: "new" }
  | { kind: "modified"; newLines: Set<number>; from?: string }
  /** Identical to the merge base, or only lines removed. */
  | { kind: "unchanged"; from?: string };

/**
 * How each path differs from its merge base with `base`, including uncommitted edits. A renamed
 * file is compared with its old path; a path that did not exist at the merge base is new.
 */
export async function changesSince(cwd: string, base: string, paths: readonly string[]): Promise<Map<string, Change>> {
  const mergeBase = (await git(cwd, ["merge-base", base, "HEAD"])).trim();
  const renamedFrom = await renames(cwd, mergeBase);
  const changes = new Map<string, Change>();
  for (const path of paths) {
    const existed = await git(cwd, ["cat-file", "-e", `${mergeBase}:${path}`]).then(
      () => true,
      () => false,
    );
    const oldPath = existed ? path : renamedFrom.get(path);
    if (!oldPath) {
      changes.set(path, { kind: "new" });
      continue;
    }
    const diff = await git(cwd, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--unified=0",
      "--find-renames",
      mergeBase,
      "--",
      ...new Set([oldPath, path]),
    ]);
    const newLines = newLineNumbers(diff);
    const from = oldPath === path ? {} : { from: oldPath };
    changes.set(path, newLines.size ? { kind: "modified", newLines, ...from } : { kind: "unchanged", ...from });
  }
  return changes;
}

/** Line numbers, in the new version of the file, of the lines a unified diff adds or changes. */
export function newLineNumbers(diff: string): Set<number> {
  const added = new Set<number>();
  let line = 0;
  for (const text of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
    } else if (line && text.startsWith("+")) {
      added.add(line++);
    } else if (line && text.startsWith(" ")) {
      line++;
    }
  }
  return added;
}

/** New path -> old path for every file renamed since `mergeBase`. */
async function renames(cwd: string, mergeBase: string): Promise<Map<string, string>> {
  const status = await git(cwd, ["diff", "--name-status", "--find-renames", mergeBase]);
  const renamed = new Map<string, string>();
  for (const line of status.split("\n")) {
    const [kind, from, to] = line.split("\t");
    if (kind?.startsWith("R") && from && to) renamed.set(to, from);
  }
  return renamed;
}

/** Runs git in `cwd` and returns its output. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
