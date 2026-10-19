// The `openrouter` provider: OpenRouter's decisions API, whose `noul` and `choice` primitives are
// yes/no and multiple-choice questions (https://docs.typesafe.ai/primitives/noul).
import { type Answer, type DecisionModel, type Question, ModelError } from "./models.ts";

export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

/** A decision model served by OpenRouter's decisions API. */
export function openRouter(options: {
  name: string;
  apiKey: string;
  url?: string;
  timeoutMs?: number;
  retries?: number;
}): DecisionModel {
  const { name, apiKey, url = DECISIONS_URL, timeoutMs = 180_000, retries = 2 } = options;

  return {
    async decide(state, questions) {
      const asked = Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, toApi(q)]));
      const body = JSON.stringify({ model: name, state, questions: asked });
      const started = performance.now();
      const payload = await post(url, apiKey, body, timeoutMs, retries);
      const durationMs = performance.now() - started;

      const raw = payload.answers ?? {};
      const answers: Record<string, Answer> = {};
      for (const [id, question] of Object.entries(questions)) {
        const answer = fromApi(question, raw[id]);
        if (!answer) throw new ModelError(`no answer for: ${id}`);
        answers[id] = answer;
      }
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

/** The API's form of a question: a `noul` for yes/no, a `choice` for multiple choice. */
function toApi(question: Question): object {
  if (question.type === "yesno") {
    const { instructions, criteria } = question;
    return { type: "noul", instructions, ...(criteria ? { criteria: { true: criteria.yes, false: criteria.no } } : {}) };
  }
  return { type: "choice", instructions: question.instructions, criteria: question.options };
}

/** The engine's form of the API's answer to `question`, or null if it is missing or malformed. */
function fromApi(question: Question, answer: any): Answer | null {
  if (question.type === "yesno") {
    return typeof answer?.noul === "number" ? { type: "yesno", yes: answer.noul } : null;
  }
  return typeof answer?.probabilities === "object" && answer.probabilities !== null
    ? { type: "choice", probabilities: answer.probabilities }
    : null;
}

/** POSTs to the decisions API, retrying rate limits and server errors with backoff. */
async function post(url: string, apiKey: string, body: string, timeoutMs: number, retries: number): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let failure: ModelError;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return await response.json();
      const detail = (await response.text()).slice(0, 500);
      failure = new ModelError(`HTTP ${response.status}: ${detail}`, detail.includes("max_tokens_exceeded"));
      if (!RETRY_STATUSES.has(response.status)) throw failure;
    } catch (error) {
      if (error instanceof ModelError) throw error;
      failure = new ModelError(`request failed: ${(error as Error).message}`);
    }
    if (attempt >= retries) throw failure;
    await new Promise((done) => setTimeout(done, 2000 * 2 ** attempt));
  }
}
