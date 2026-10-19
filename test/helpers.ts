import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Model, ResolvedRule } from "../src/config.ts";
import type { Answer, Decision, DecisionModel, Question, State } from "../src/models.ts";

export const MODEL: Model = { provider: "openrouter", name: "test-model", apiKey: "test", maxInputTokens: 32_768 };

/** A resolved rule in suite `api` on every Python file, with `overrides` applied. */
export function rule(name: string, overrides: Partial<ResolvedRule> = {}): ResolvedRule {
  return {
    suite: "api",
    name,
    prompt: "Q?",
    values: [{ value: "TRUE", report: "Fix." }, { value: "FALSE" }],
    model: MODEL,
    modelAt: "config.model",
    files: ["**/*.py"],
    ignores: [],
    context: {},
    threshold: 0.7,
    unchecked: "warn",
    ...overrides,
  };
}

/** A decision model that records each call and answers with `answer`. */
export class FakeModel implements DecisionModel {
  calls: { state: State; questions: Record<string, Question> }[] = [];
  answer: (id: string, question: Question, attempt: number) => Answer;

  constructor(answer: (id: string, question: Question, attempt: number) => Answer = () => ({ type: "yesno", yes: 0.1 })) {
    this.answer = answer;
  }

  async decide(state: State, questions: Record<string, Question>): Promise<Decision> {
    this.calls.push({ state, questions });
    const attempt = this.calls.length;
    const answers = Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, this.answer(id, q, attempt)]));
    return { answers, inputTokens: 10, outputTokens: 2, cost: 0.001, durationMs: 5 };
  }
}

/** A temporary directory holding `files`. */
export async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "decision-model-linter-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

/** Config source whose one suite, `api`, has one rule `f` on Python files with these values. */
export function configSource(values = `[{ value: "TRUE", severity: "error", report: "Fix." }, { value: "FALSE" }]`): string {
  return `export default {
  model: { provider: "openrouter", name: "test-model", apiKey: "test", maxInputTokens: 32768 },
  suites: { api: { files: ["*.py"], rules: { f: { prompt: "Q?", values: ${values} } } } },
};
`;
}
