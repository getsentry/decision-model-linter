// Every provider a model's `provider` can name. Adding one is a module that implements
// DecisionModel and a line here.
import type { Model } from "./config.ts";
import type { DecisionModel } from "./models.ts";
import { openRouter } from "./openrouter.ts";

export const PROVIDERS = {
  openrouter: (model: Model) => openRouter({ name: model.name, apiKey: model.apiKey ?? "", url: model.url }),
} satisfies Record<string, (model: Model) => DecisionModel>;

export type Provider = keyof typeof PROVIDERS;

/** The decision model a configured model names. */
export function connect(model: Model): DecisionModel {
  return PROVIDERS[model.provider](model);
}
