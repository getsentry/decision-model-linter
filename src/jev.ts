// Jev via OpenRouter's decisions API: https://docs.typesafe.ai/primitives/noul and /choice

export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const MODEL = "typesafe/jev-1.13";

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

export type Question =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence?: number };

export interface Decision {
  answers: Record<string, Answer>;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  durationMs: number;
  model?: string;
}

export type State = Record<string, string>;

export interface JevClient {
  decide(state: State, questions: Record<string, Question>): Promise<Decision>;
}

/** A failed Jev call; `maxTokensExceeded` when the request was too large. */
export class JevError extends Error {
  maxTokensExceeded: boolean;

  constructor(message: string, maxTokensExceeded = false) {
    super(message);
    this.maxTokensExceeded = maxTokensExceeded;
  }
}

/** A Jev client that calls OpenRouter's decisions API. */
export function openRouterJev(options: {
  apiKey: string;
  url?: string;
  model?: string;
  timeoutMs?: number;
  retries?: number;
}): JevClient {
  const { apiKey, url = DECISIONS_URL, model = MODEL, timeoutMs = 180_000, retries = 2 } = options;
  if (!apiKey.trim()) throw new JevError("an OpenRouter API key is required");

  return {
    async decide(state, questions) {
      const body = JSON.stringify({ model, state, questions });
      const started = performance.now();
      const payload = await post(url, apiKey, body, timeoutMs, retries);
      const durationMs = performance.now() - started;

      const answers: Record<string, Answer> = payload.answers ?? {};
      const missing = Object.keys(questions).filter((id) => !(id in answers));
      if (missing.length) throw new JevError(`no answer for: ${missing.join(", ")}`);
      return {
        answers,
        inputTokens: payload.usage?.input_tokens,
        outputTokens: payload.usage?.output_tokens,
        cost: payload.usage?.cost,
        durationMs,
        model: payload.model,
      };
    },
  };
}

/** POSTs to the decisions API, retrying rate limits and server errors with backoff. */
async function post(url: string, apiKey: string, body: string, timeoutMs: number, retries: number): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let failure: JevError;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return await response.json();
      const detail = (await response.text()).slice(0, 500);
      failure = new JevError(`HTTP ${response.status}: ${detail}`, detail.includes("max_tokens_exceeded"));
      if (!RETRY_STATUSES.has(response.status)) throw failure;
    } catch (error) {
      if (error instanceof JevError) throw error;
      failure = new JevError(`request failed: ${(error as Error).message}`);
    }
    if (attempt >= retries) throw failure;
    await new Promise((done) => setTimeout(done, 2000 * 2 ** attempt));
  }
}
