import { COMMENT_MARKER } from "./report.ts";

const BOT_LOGIN = "github-actions[bot]";

export interface CommentApi {
  findComment(pr: number): Promise<number | null>;
  createComment(pr: number, body: string): Promise<void>;
  updateComment(id: number, body: string): Promise<void>;
}

/** The comment calls the linter makes, against the GitHub REST API. */
export function githubComments(token: string, repo: string, api = "https://api.github.com"): CommentApi {
  async function request(method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return response.json();
  }

  return {
    async findComment(pr) {
      for (let page = 1; ; page++) {
        const comments: any[] = await request("GET", `/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
        const ours = comments.find((c) => c.user?.login === BOT_LOGIN && c.body?.includes(COMMENT_MARKER));
        if (ours) return ours.id;
        if (comments.length < 100) return null;
      }
    },
    async createComment(pr, body) {
      await request("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
    },
    async updateComment(id, body) {
      await request("PATCH", `/repos/${repo}/issues/comments/${id}`, { body });
    },
  };
}

/**
 * Creates or rewrites the decision-model-linter comment with `body`, or with `clean` when there are no findings
 * (only if a comment already exists); returns what it did.
 */
export async function upsertComment(api: CommentApi, pr: number, body: string | null, clean: string): Promise<string> {
  const existing = await api.findComment(pr);
  if (body === null) {
    if (existing === null) return "none";
    await api.updateComment(existing, clean);
    return "cleared";
  }
  if (existing === null) {
    await api.createComment(pr, body);
    return "created";
  }
  await api.updateComment(existing, body);
  return "updated";
}
