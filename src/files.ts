import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const SKIPPED_DIRS = new Set([".git", "node_modules"]);
const regexCache = new Map<string, RegExp>();

/** A regular expression for a glob, where `**` crosses directories and `*` does not. */
export function globToRegExp(pattern: string): RegExp {
  let regex = regexCache.get(pattern);
  if (regex) return regex;
  let out = "";
  for (let i = 0; i < pattern.length; ) {
    if (pattern.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else if (pattern[i] === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += pattern[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  regex = new RegExp(`^${out}$`);
  regexCache.set(pattern, regex);
  return regex;
}

/** Whether `path` matches any of the globs. */
export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

/** Resolves file paths, directories, and globs to sorted, unique paths relative to `cwd`. */
export async function resolveTargets(targets: readonly string[], cwd: string): Promise<string[]> {
  const found = new Set<string>();
  for (const target of targets) {
    const info = await stat(join(cwd, target)).catch(() => null);
    if (info?.isFile()) {
      found.add(toPosix(relative(cwd, join(cwd, target))));
    } else if (info?.isDirectory()) {
      for (const path of await walk(join(cwd, target), cwd)) found.add(path);
    } else {
      const regex = globToRegExp(target.replace(/^\.\//, ""));
      for (const path of await walk(join(cwd, staticPrefix(target)), cwd)) {
        if (regex.test(path)) found.add(path);
      }
    }
  }
  return [...found].sort();
}

/** The directory part of a glob before its first wildcard, where a walk can start. */
function staticPrefix(glob: string): string {
  const segments = glob.split("/");
  const firstWild = segments.findIndex((segment) => /[*?]/.test(segment));
  return segments.slice(0, firstWild === -1 ? segments.length - 1 : firstWild).join("/") || ".";
}

/** Every file under `dir`, relative to `cwd`, skipping .git and node_modules. */
async function walk(dir: string, cwd: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const paths: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) paths.push(...(await walk(full, cwd)));
    } else if (entry.isFile()) {
      paths.push(toPosix(relative(cwd, full)));
    }
  }
  return paths;
}

/** `path` with forward slashes. */
function toPosix(path: string): string {
  return path.split(sep).join("/");
}
