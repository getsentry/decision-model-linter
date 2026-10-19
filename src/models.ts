// What the engine asks a decision model and what it gets back. Each provider translates these to
// its own API, so the engine knows no provider.

/** Named strings the model reads: the file's `path` and `content`, plus any context. */
export type State = Record<string, string>;

export type Question =
  | { type: "yesno"; instructions: string; criteria?: { yes: string; no: string } }
  | { type: "choice"; instructions: string; options: Record<string, string> };

export type Answer =
  | { type: "yesno"; yes: number }
  | { type: "choice"; probabilities: Record<string, number> };

export interface Decision {
  answers: Record<string, Answer>;
  inputTokens?: number;
  outputTokens?: number;
  /** USD, as the provider reports it. */
  cost?: number;
  durationMs: number;
  /** The model version that answered, as the provider reports it. */
  model?: string;
}

/** A decision model behind one provider. */
export interface DecisionModel {
  decide(state: State, questions: Record<string, Question>): Promise<Decision>;
}

/** A failed call; `tooLarge` when the provider rejected the input as too large. */
export class ModelError extends Error {
  tooLarge: boolean;

  constructor(message: string, tooLarge = false) {
    super(message);
    this.tooLarge = tooLarge;
  }
}
