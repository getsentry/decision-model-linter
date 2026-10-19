// A repository's config file: suites of rules, settings that cascade from the config to each suite
// to each rule, and how a config is loaded and checked. Errors name settings, never their values,
// since a model's `apiKey` is a value.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { type Provider, PROVIDERS } from "./providers.ts";

/** How a finding or an unchecked file is reported; `error` fails the run. */
export type Severity = "warn" | "error";

/** Which model answers, through which provider, with which key. */
export interface Model {
  provider: Provider;
  name: string;
  /** Read from the environment by the config, such as `process.env.OPENROUTER_API_KEY`. */
  apiKey: string | undefined;
  /** The most input tokens one call may send: the file, its context, and the questions. */
  maxInputTokens: number;
  /** Overrides the provider's endpoint. */
  url?: string;
}

/** Extra state for a rule's calls: a string, or a function of the file called once per file. */
export type ContextValue = string | ((file: { path: string }) => string | Promise<string>);

/** Settings the config, a suite, or a rule may set; the nearest wins, and `context` merges by name. */
export interface Settings {
  model?: Model;
  files?: string[];
  ignores?: string[];
  context?: Record<string, ContextValue>;
  threshold?: number;
  /** How a file the model could not fully answer for is reported. */
  unchecked?: Severity;
}

/** One answer to a rule; reported when it has a `report` and its probability reaches its threshold. */
export interface Value {
  value: string;
  description?: string;
  report?: string;
  severity?: Severity;
  threshold?: number;
}

/** A question the model answers about each file the rule matches, and its possible answers. */
export interface Rule extends Settings {
  prompt: string;
  values: Value[];
}

/** Rules that share settings, typically one team's or domain's. */
export interface Suite extends Settings {
  rules: Record<string, Rule>;
}

/** A repository's config: its suites, defaults for their rules, and how many calls run at once. */
export interface Config extends Settings {
  concurrency?: number;
  suites: Record<string, Suite>;
}

/** A rule with every setting resolved; `modelAt` is the path of the setting its model came from. */
export interface ResolvedRule {
  suite: string;
  name: string;
  prompt: string;
  values: Value[];
  model: Model;
  modelAt: string;
  files: string[];
  ignores: string[];
  context: Record<string, ContextValue>;
  threshold: number;
  unchecked: Severity;
}

export const DEFAULT_CONFIG = "decision-model-linter.config.ts";
export const DEFAULT_THRESHOLD = 0.7;
export const DEFAULT_SEVERITY: Severity = "warn";
export const DEFAULT_CONCURRENCY = 16;
// Keys the engine puts in every call's state; context may not shadow them.
export const RESERVED_STATE_KEYS = new Set(["path", "content"]);

const SETTING_KEYS = ["model", "files", "ignores", "context", "threshold", "unchecked"];
const MODEL_KEYS = ["provider", "name", "apiKey", "maxInputTokens", "url"];
const VALUE_KEYS = ["value", "description", "report", "severity", "threshold"];

/** A config that cannot be loaded or is not valid. */
export class ConfigError extends Error {}

/** Loads the config file at `path` and returns its rules, resolved, from the suites in `only` (or all). */
export async function loadConfig(
  path: string,
  only: readonly string[] = [],
): Promise<{ rules: ResolvedRule[]; concurrency: number }> {
  let module;
  try {
    module = await import(pathToFileURL(resolve(path)).href);
  } catch (error) {
    // Only the first line: a syntax error's later lines can quote the config's source.
    throw new ConfigError(`cannot load ${path}: ${(error as Error).message.split("\n")[0]}`);
  }
  return resolveConfig(module.default, only);
}

/** Checks a config's default export and resolves every rule's settings. */
export function resolveConfig(raw: unknown, only: readonly string[] = []): { rules: ResolvedRule[]; concurrency: number } {
  if (!isObject(raw)) throw new ConfigError("config: must default-export an object");
  checkKeys(raw, "config", [...SETTING_KEYS, "concurrency", "suites"]);
  checkSettings(raw, "config");
  const { concurrency = DEFAULT_CONCURRENCY } = raw;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new ConfigError("config.concurrency: must be a positive integer");
  }
  if (!isObject(raw.suites) || !Object.keys(raw.suites).length) {
    throw new ConfigError("config.suites: must name at least one suite");
  }
  const unknown = only.filter((name) => !Object.hasOwn(raw.suites, name));
  if (unknown.length) throw new ConfigError(`no suite named ${unknown.join(", ")}`);

  const rules: ResolvedRule[] = [];
  for (const [suiteName, suite] of Object.entries(raw.suites)) {
    const at = `suites.${suiteName}`;
    if (!isObject(suite)) throw new ConfigError(`${at}: must be an object`);
    checkKeys(suite, at, [...SETTING_KEYS, "rules"]);
    checkSettings(suite, at);
    if (!isObject(suite.rules) || !Object.keys(suite.rules).length) {
      throw new ConfigError(`${at}.rules: must name at least one rule`);
    }
    for (const [ruleName, rule] of Object.entries(suite.rules)) {
      const resolved = resolveRule(raw, suite, rule, suiteName, ruleName);
      if (!only.length || only.includes(suiteName)) rules.push(resolved);
    }
  }
  return { rules, concurrency };
}

/** Checks one rule and resolves its settings from the rule, then its suite, then the config. */
function resolveRule(
  config: Record<string, any>,
  suite: Record<string, any>,
  rule: unknown,
  suiteName: string,
  ruleName: string,
): ResolvedRule {
  const at = `suites.${suiteName}.rules.${ruleName}`;
  if (!isObject(rule)) throw new ConfigError(`${at}: must be an object`);
  checkKeys(rule, at, [...SETTING_KEYS, "prompt", "values"]);
  checkSettings(rule, at);
  checkQuestion(rule, at);

  const levels = [
    [rule, at],
    [suite, `suites.${suiteName}`],
    [config, "config"],
  ] as const;
  const nearest = (key: keyof Settings) => levels.find(([level]) => level[key] !== undefined);
  const model = nearest("model");
  if (!model) throw new ConfigError(`${at}: no model is set on the rule, its suite, or the config`);
  const files = nearest("files")?.[0].files;
  if (!files) throw new ConfigError(`${at}: no files are set on the rule, its suite, or the config`);
  return {
    suite: suiteName,
    name: ruleName,
    prompt: rule.prompt,
    values: rule.values,
    model: model[0].model,
    modelAt: `${model[1]}.model`,
    files,
    ignores: nearest("ignores")?.[0].ignores ?? [],
    context: { ...config.context, ...suite.context, ...rule.context },
    threshold: nearest("threshold")?.[0].threshold ?? DEFAULT_THRESHOLD,
    unchecked: nearest("unchecked")?.[0].unchecked ?? DEFAULT_SEVERITY,
  };
}

/** Checks the settings any level may set. */
function checkSettings(level: Record<string, any>, at: string): void {
  if (level.model !== undefined) checkModel(level.model, `${at}.model`);
  if (level.files !== undefined) requireStrings(level.files, `${at}.files`, { nonEmpty: true });
  if (level.ignores !== undefined) requireStrings(level.ignores, `${at}.ignores`);
  if (level.context !== undefined) {
    if (!isObject(level.context)) throw new ConfigError(`${at}.context: must be an object`);
    for (const [name, value] of Object.entries(level.context)) {
      if (RESERVED_STATE_KEYS.has(name)) {
        throw new ConfigError(`${at}.context.${name}: '${name}' is reserved for the file`);
      }
      if (typeof value !== "string" && typeof value !== "function") {
        throw new ConfigError(`${at}.context.${name}: must be a string or a function`);
      }
    }
  }
  if (level.threshold !== undefined) checkThreshold(level.threshold, `${at}.threshold`);
  if (level.unchecked !== undefined) checkSeverity(level.unchecked, `${at}.unchecked`);
}

/** Checks a model's provider, name, key, input limit, and endpoint. */
function checkModel(model: unknown, at: string): void {
  if (!isObject(model)) throw new ConfigError(`${at}: must be an object`);
  checkKeys(model, at, MODEL_KEYS);
  if (typeof model.provider !== "string" || !Object.hasOwn(PROVIDERS, model.provider)) {
    throw new ConfigError(`${at}.provider: must be one of ${Object.keys(PROVIDERS).join(", ")}`);
  }
  if (typeof model.name !== "string" || !model.name.trim()) {
    throw new ConfigError(`${at}.name: must be a non-empty string`);
  }
  if (model.apiKey !== undefined && typeof model.apiKey !== "string") {
    throw new ConfigError(`${at}.apiKey: must be a string, such as process.env.OPENROUTER_API_KEY`);
  }
  if (!Number.isInteger(model.maxInputTokens) || model.maxInputTokens < 1) {
    throw new ConfigError(`${at}.maxInputTokens: must be a positive integer`);
  }
  if (model.url !== undefined && (typeof model.url !== "string" || !URL.canParse(model.url))) {
    throw new ConfigError(`${at}.url: must be a URL`);
  }
}

/** Checks a rule's prompt and values, and each value's options. */
function checkQuestion(rule: Record<string, any>, at: string): void {
  if (typeof rule.prompt !== "string" || !rule.prompt.trim()) throw new ConfigError(`${at}: missing prompt`);
  if (!Array.isArray(rule.values) || rule.values.length < 2) {
    throw new ConfigError(`${at}.values: must list at least two values`);
  }
  const seen = new Set<string>();
  for (const [index, value] of rule.values.entries()) {
    if (!isObject(value) || typeof value.value !== "string" || !value.value.trim()) {
      throw new ConfigError(`${at}.values.${index}: needs a non-empty 'value'`);
    }
    const valueAt = `${at}.values.${value.value}`;
    if (seen.has(value.value)) throw new ConfigError(`${at}.values: duplicate value '${value.value}'`);
    seen.add(value.value);
    checkKeys(value, valueAt, VALUE_KEYS);
    for (const key of ["description", "report"] as const) {
      if (value[key] !== undefined && typeof value[key] !== "string") {
        throw new ConfigError(`${valueAt}.${key}: must be a string`);
      }
    }
    if (value.severity !== undefined) checkSeverity(value.severity, `${valueAt}.severity`);
    if (value.threshold !== undefined) checkThreshold(value.threshold, `${valueAt}.threshold`);
  }
}

/** Throws for any key not in `allowed`, so a misspelled setting is not silently ignored. */
function checkKeys(object: Record<string, unknown>, at: string, allowed: readonly string[]): void {
  const unknown = Object.keys(object).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new ConfigError(`${at}.${unknown}: unknown setting`);
}

/** Throws unless `value` is "warn" or "error". */
function checkSeverity(value: unknown, at: string): void {
  if (value !== "warn" && value !== "error") throw new ConfigError(`${at}: must be "warn" or "error"`);
}

/** Throws unless `value` is a number in [0, 1]. */
function checkThreshold(value: unknown, at: string): void {
  if (typeof value !== "number" || value < 0 || value > 1) throw new ConfigError(`${at}: must be a number in [0, 1]`);
}

/** Throws unless `value` is a list of strings, and a non-empty one when `nonEmpty`. */
function requireStrings(value: unknown, at: string, { nonEmpty = false } = {}): void {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new ConfigError(`${at}: must be a list of strings`);
  }
  if (nonEmpty && value.length === 0) throw new ConfigError(`${at}: must not be empty`);
}

/** True for a plain object: not null, not an array. */
function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
