// Suites are the rule files in decision-model-linter/, one per team or domain: their shape, and how they are
// loaded and checked before a run.
import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** How a finding is reported; an `error` fails the check. */
export type Severity = "warn" | "error";

/** One answer to a field; reported when it has a `report` and its probability reaches `threshold`. */
export interface Value {
  value: string;
  description?: string;
  report?: string;
  severity?: Severity;
  threshold?: number;
}

/** A question Jev answers about a file, and the answers it may give. */
export interface Field {
  prompt: string;
  values: Value[];
}

/**
 * Extra state for every call of an entry, computed once per run. Rules should answer from the
 * file or change alone, like any linter; context is for the rare rule that needs shared data.
 */
export type ContextValue = string | (() => string | Promise<string>);

/** The fields to ask about every file matching `files` and not `ignores`. */
export interface Entry {
  files: string[];
  ignores?: string[];
  context?: Record<string, ContextValue>;
  fields: Record<string, Field>;
}

/** One team's or domain's rules: a file in the suites directory, named by its file name. */
export interface Suite {
  name: string;
  entries: Entry[];
}

export const DEFAULT_THRESHOLD = 0.7;
export const DEFAULT_SEVERITY: Severity = "warn";
// Keys the engine puts in every call's state; context may not shadow them.
export const RESERVED_STATE_KEYS = new Set(["path", "content"]);

/** Returns `entries` unchanged; wrapping a suite in it type-checks the suite file. */
export function defineSuite(entries: Entry[]): Entry[] {
  return entries;
}

/** A suite file that cannot be loaded or is not a valid suite. */
export class SuiteError extends Error {}

const SUITE_FILE = /^[^.]+\.m?ts$/;

/** Every suite file directly in `dir`, or only those named in `only`. */
export async function loadSuites(dir: string, only: readonly string[] = []): Promise<Suite[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => SUITE_FILE.test(f)).sort();
  const names = files.map((f) => basename(f).replace(/\.m?ts$/, ""));
  const unknown = only.filter((name) => !names.includes(name));
  if (unknown.length) throw new SuiteError(`no suite named ${unknown.join(", ")} in ${dir}`);
  if (!files.length) throw new SuiteError(`no suites in ${dir}`);
  const suites: Suite[] = [];
  for (const [i, file] of files.entries()) {
    if (only.length && !only.includes(names[i])) continue;
    const path = join(resolve(dir), file);
    let module;
    try {
      module = await import(pathToFileURL(path).href);
    } catch (error) {
      throw new SuiteError(`suite ${names[i]}: cannot load ${path}: ${(error as Error).message}`);
    }
    suites.push({ name: names[i], entries: validateEntries(module.default, `suite ${names[i]}`) });
  }
  return suites;
}

/** Checks a suite file's default export, naming the suite and entry in any error. */
export function validateEntries(raw: unknown, where = "suite"): Entry[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SuiteError(`${where}: must default-export a non-empty array of entries`);
  }
  raw.forEach((entry, index) => validateEntry(entry, `${where}: entry ${index}`));
  return raw as Entry[];
}

/** Checks one entry's files, ignores, context, and fields. */
function validateEntry(entry: unknown, where: string): void {
  if (!isObject(entry)) throw new SuiteError(`${where}: must be an object`);
  requireStrings(entry.files, `${where}.files`, { nonEmpty: true });
  if (entry.ignores !== undefined) requireStrings(entry.ignores, `${where}.ignores`);
  if (entry.context !== undefined) {
    if (!isObject(entry.context)) throw new SuiteError(`${where}.context: must be an object`);
    for (const [name, value] of Object.entries(entry.context)) {
      if (RESERVED_STATE_KEYS.has(name)) {
        throw new SuiteError(`${where}.context.${name}: '${name}' is reserved for the file`);
      }
      if (typeof value !== "string" && typeof value !== "function") {
        throw new SuiteError(`${where}.context.${name}: must be a string or a function`);
      }
    }
  }
  if (!isObject(entry.fields) || Object.keys(entry.fields).length === 0) {
    throw new SuiteError(`${where}: missing fields`);
  }
  for (const [name, field] of Object.entries(entry.fields)) {
    validateField(field, `${where}.fields.${name}`);
  }
}

/** Checks a field's prompt and values, and each value's options. */
function validateField(field: unknown, where: string): void {
  if (!isObject(field)) throw new SuiteError(`${where}: must be an object`);
  if (typeof field.prompt !== "string" || !field.prompt.trim()) {
    throw new SuiteError(`${where}: missing prompt`);
  }
  if (!Array.isArray(field.values) || field.values.length < 2) {
    throw new SuiteError(`${where}: values must list at least two values`);
  }
  const seen = new Set<string>();
  for (const value of field.values) {
    if (!isObject(value) || typeof value.value !== "string" || !value.value.trim()) {
      throw new SuiteError(`${where}: every value needs a non-empty 'value'`);
    }
    const at = `${where}.${value.value}`;
    if (seen.has(value.value)) throw new SuiteError(`${where}: duplicate value '${value.value}'`);
    seen.add(value.value);
    for (const key of ["description", "report"] as const) {
      if (value[key] !== undefined && typeof value[key] !== "string") {
        throw new SuiteError(`${at}: ${key} must be a string`);
      }
    }
    if (value.severity !== undefined && value.severity !== "warn" && value.severity !== "error") {
      throw new SuiteError(`${at}: severity must be "warn" or "error"`);
    }
    const threshold = value.threshold;
    if (threshold !== undefined && (typeof threshold !== "number" || threshold < 0 || threshold > 1)) {
      throw new SuiteError(`${at}: threshold must be a number in [0, 1]`);
    }
  }
}

/** Throws unless `value` is a list of strings, and a non-empty one when `nonEmpty`. */
function requireStrings(value: unknown, where: string, { nonEmpty = false } = {}): void {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new SuiteError(`${where}: must be a list of strings`);
  }
  if (nonEmpty && value.length === 0) throw new SuiteError(`${where}: must not be empty`);
}

/** True for a plain object: not null, not an array. */
function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
