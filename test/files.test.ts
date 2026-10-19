import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { matchesAny, resolveTargets } from "../src/files.ts";

test("globs", () => {
  assert.ok(matchesAny("src/sentry/api/endpoints/x.py", ["src/sentry/**/*.py"]));
  assert.ok(matchesAny("src/sentry/x.py", ["src/sentry/**/*.py"]));
  assert.ok(matchesAny("src/a/tests/b.py", ["**/tests/**"]));
  assert.ok(!matchesAny("src/sentry/x.ts", ["src/sentry/**/*.py"]));
  assert.ok(!matchesAny("src/sentry/api/x.py", ["src/sentry/*.py"]));
});

test("targets mix files, directories, and globs", async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-model-linter-"));
  for (const path of ["a/one.py", "a/b/two.py", "a/b/three.ts", "c/four.py", "node_modules/x.py", "top.py"]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "");
  }
  assert.deepEqual(await resolveTargets(["top.py"], root), ["top.py"]);
  assert.deepEqual(await resolveTargets(["a"], root), ["a/b/three.ts", "a/b/two.py", "a/one.py"]);
  assert.deepEqual(await resolveTargets(["**/*.py"], root), ["a/b/two.py", "a/one.py", "c/four.py", "top.py"]);
  assert.deepEqual(await resolveTargets(["a/**/*.py", "c"], root), ["a/b/two.py", "a/one.py", "c/four.py"]);
});
