import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { main } from "../src/cli.ts";
import { collapseHiddenLines, linesToShow } from "../src/changed-lines.ts";
import { NEW_LINES_INSTRUCTIONS, WHOLE_FILE_INSTRUCTIONS, annotate, lint } from "../src/evaluate.ts";
import { changesSince, newLineNumbers } from "../src/git.ts";
import { FakeModel, configSource, rule } from "./helpers.ts";

const swallows = rule("swallows", {
  suite: "security",
  files: ["*.py"],
  prompt: "Swallows exceptions?",
  values: [{ value: "TRUE", report: "Don't." }, { value: "FALSE" }],
});

async function repo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "decision-model-linter-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  await writeFile(join(cwd, "modified.py"), "a = 1\nb = 2\n");
  await writeFile(join(cwd, "unchanged.py"), "b = 1\n");
  await writeFile(join(cwd, "shrunk.py"), "c = 1\nd = 2\n");
  const moved = Array.from({ length: 20 }, (_, i) => `line_${i} = ${i}`);
  await writeFile(join(cwd, "moved_from.py"), `${moved.join("\n")}\n`);
  // Distinct contents, so git pairs each rename with the right file.
  await writeFile(join(cwd, "renamed_from.py"), `${moved.map((l) => `r_${l}`).join("\n")}\n`);
  await mkdir(join(cwd, "sub"));
  await writeFile(join(cwd, "sub", "entered.py"), `${moved.map((l) => `e_${l}`).join("\n")}\n`);
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("mv", "moved_from.py", "moved_to.py");
  git("mv", "renamed_from.py", "renamed_to.py");
  git("mv", "sub/entered.py", "entered.py");
  await writeFile(join(cwd, "moved_to.py"), `${moved.map((l, i) => (i === 10 ? "line_10 = 'changed'" : l)).join("\n")}\n`);
  git("switch", "-q", "-c", "feature");
  await writeFile(join(cwd, "modified.py"), "a = 1\ntry:\n    x()\nexcept Exception:\n    pass\nb = 3\n");
  await writeFile(join(cwd, "shrunk.py"), "c = 1\n");
  await writeFile(join(cwd, "new.py"), "c = 1\n");
  git("add", ".");
  git("commit", "-q", "-m", "change");
  return cwd;
}

test("new lines come from the merge base; removals alone leave nothing to lint", async () => {
  const cwd = await repo();
  const changes = await changesSince(cwd, "main", ["modified.py", "unchanged.py", "shrunk.py", "new.py"]);
  assert.equal(changes.get("new.py")?.kind, "new");
  assert.equal(changes.get("unchanged.py")?.kind, "unchanged");
  assert.equal(changes.get("shrunk.py")?.kind, "unchanged");
  const modified = changes.get("modified.py");
  assert.deepEqual(modified?.kind === "modified" ? [...modified.newLines] : [], [2, 3, 4, 5, 6]);
});

test("a renamed file is compared with its old path", async () => {
  const cwd = await repo();
  const changes = await changesSince(cwd, "main", ["moved_to.py", "renamed_to.py"]);
  const moved = changes.get("moved_to.py");
  assert.deepEqual(moved?.kind === "modified" ? [...moved.newLines] : moved, [11]);
  assert.deepEqual(changes.get("renamed_to.py"), { kind: "unchanged", from: "renamed_from.py" });
});

test("changed lines count as new", () => {
  const diff = ["--- a/x.py", "+++ b/x.py", "@@ -3 +3 @@", "-old = 1", "+new = 1", "@@ -10,0 +11,2 @@", "+a", "+b"].join("\n");
  assert.deepEqual([...newLineNumbers(diff)], [3, 11, 12]);
});

test("a changed file shows only its new lines, with the new-lines instructions", async () => {
  const cwd = await repo();
  const client = new FakeModel(() => ({ type: "yesno", yes: 0.9 }));
  const [changed, whole] = await lint([swallows], ["modified.py", "new.py"], {
    cwd,
    connect: () => client,
    newLines: new Map([["modified.py", new Set([4, 5])]]),
  });
  assert.equal(changed.mode, "changeset");
  assert.equal(whole.mode, "file");

  const changedCall = client.calls.find((c) => c.state.path === "modified.py")!;
  assert.equal(
    changedCall.state.content,
    "\t[decision-model-linter: lines 1-3 omitted]\n4(new)\texcept Exception:\n5(new)\t    pass\n\t[decision-model-linter: lines 6-6 omitted]\n",
  );
  assert.equal(changedCall.questions.swallows.instructions, `${NEW_LINES_INSTRUCTIONS}\n\nQuestion: Swallows exceptions?`);

  const wholeCall = client.calls.find((c) => c.state.path === "new.py")!;
  assert.equal(wholeCall.state.content, "1\tc = 1\n");
  assert.equal(wholeCall.questions.swallows.instructions, `${WHOLE_FILE_INSTRUCTIONS}\n\nQuestion: Swallows exceptions?`);
});

test("a new line shows the expression it sits in, but not the blocks around it", () => {
  const text = [
    "@decorator(",
    "    omit={",
    '        "a": "old",',
    '        "b": "new",',
    "    }",
    ")",
    "try:",
    "    run()",
    "except Exception:",
    "    log('# not a comment', [1, 2])",
    "    fallback = 0",
  ].join("\n");
  assert.deepEqual([...linesToShow(text, new Set([4]), "x.py")].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual([...linesToShow(text, new Set([11]), "x.py")], [11]);
  assert.deepEqual(
    collapseHiddenLines(annotate(text, new Set([4])), new Set([1, 2, 4])),
    ["1\t@decorator(", "2\t    omit={", "\t[decision-model-linter: lines 3-3 omitted]", '4(new)\t        "b": "new",', "\t[decision-model-linter: lines 5-11 omitted]"],
  );
});

test("a new condition in a chained query shows the conditions already there", () => {
  const text = [
    "def get_run(org_id, run_id):",
    "    stmt = (",
    "        select(DbRun)",
    "        .where(DbRun.organization_id == org_id)",
    "        .where(DbRun.id == run_id)",
    "    )",
    "    return session.scalar(stmt)",
  ].join("\n");
  assert.deepEqual([...linesToShow(text, new Set([5]), "x.py")].sort(), [2, 3, 4, 5, 6]);
});

test("a long expression shows only the line that opens it", () => {
  const text = ["urlpatterns = [", ...Array.from({ length: 40 }, (_, i) => `    path("r${i}"),`), "]"].join("\n");
  assert.deepEqual([...linesToShow(text, new Set([20]), "x.py")].sort((a, b) => a - b), [1, 20]);
});

test("--base skips unchanged files, marks new lines, and lints files moved into a rule's scope whole", async () => {
  const cwd = await repo();
  await writeFile(join(cwd, "decision-model-linter.config.ts"), configSource(`[{ value: "TRUE", report: "r" }, { value: "FALSE" }]`));
  const client = new FakeModel(() => ({ type: "yesno", yes: 0.9 }));
  const code = await main(["--base", "main", "--format", "json", "."], { cwd, write: () => {}, writeError: () => {}, connect: () => client });
  assert.equal(code, 0);
  const byPath = Object.fromEntries(client.calls.map((c) => [c.state.path, c.state.content]));
  assert.deepEqual(Object.keys(byPath).sort(), ["entered.py", "modified.py", "moved_to.py", "new.py"]);
  assert.match(byPath["modified.py"], /^4\(new\)\texcept Exception:$/m);
  assert.doesNotMatch(byPath["modified.py"], /^1\ta = 1$/m);
  assert.equal(byPath["moved_to.py"].match(/\(new\)/g)?.length, 1);
  assert.doesNotMatch(byPath["new.py"], /\(new\)/);
  // Moved from sub/, which "*.py" does not cover, so it is new to this rule.
  assert.match(byPath["entered.py"], /^1\te_line_0 = 0$/m);
  assert.doesNotMatch(byPath["entered.py"], /\(new\)/);
});

test("--base without paths lints the files changed since the merge base", async () => {
  const cwd = await repo();
  await writeFile(join(cwd, "decision-model-linter.config.ts"), configSource(`[{ value: "TRUE", report: "r" }, { value: "FALSE" }]`));
  const client = new FakeModel(() => ({ type: "yesno", yes: 0.1 }));
  const code = await main(["--base", "main", "--format", "json"], { cwd, write: () => {}, writeError: () => {}, connect: () => client });
  assert.equal(code, 0);
  assert.deepEqual(client.calls.map((c) => c.state.path).sort(), ["entered.py", "modified.py", "moved_to.py", "new.py"]);
});

test("--base without paths and with no changes makes no calls", async () => {
  const cwd = await repo();
  execFileSync("git", ["switch", "-q", "main"], { cwd });
  await writeFile(join(cwd, "decision-model-linter.config.ts"), configSource());
  const client = new FakeModel();
  const code = await main(["--base", "main"], { cwd, write: () => {}, writeError: () => {}, connect: () => client });
  assert.equal(code, 0);
  assert.equal(client.calls.length, 0);
});
