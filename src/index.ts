// Types for a config file: `import type { Config } from "@getsentry/decision-model-linter"` is erased
// when Node runs the config, so a repository needs no install to use them.
export type { Config, ContextValue, Model, Rule, Settings, Severity, Suite, Value } from "./config.ts";
