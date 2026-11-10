import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

assert.ok(process.env.OPENROUTER_API_KEY?.trim(), "Set OPENROUTER_API_KEY to run the live citation checks");
const model = { provider: "openrouter", name: "typesafe/jev-1.13", maxInputTokens: 8192 };
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const cases = [
  { name: "declaration", path: "a.py", source: "def greet(name):\n    return name\n", prompt: "Does the code define a function without a return type annotation?", report: "Add a return type annotation.", line: 1 },
  { name: "print", path: "a.py", source: "def greet(name):\n    print(name)\n", prompt: "Does the code call print?", report: "Remove the print call.", line: 2 },
  { name: "sql", path: "a.py", source: 'def get_user(request, db):\n    user_id = request.args["id"]\n    return db.execute("SELECT * FROM users WHERE id = " + user_id)\n', prompt: "Does this code concatenate untrusted input into an SQL query?", report: "Use a parameterized SQL query.", line: 3 },
  { name: "unawaited", path: "a.js", source: "async function save(user) {\n  writeAudit(user);\n  await persist(user);\n}\n", prompt: "Does this code call writeAudit without awaiting it?", report: "Await writeAudit.", line: 2 },
  { name: "changed", path: "a.py", before: "print('old')\nvalue = 1\n", source: "print('old')\nprint('new')\n", prompt: "Does the code call print?", report: "Remove the print call.", line: 2 },
  { name: "clean", path: "a.py", source: "def greet(name):\n    return name\n", prompt: "Does the code call print?", report: "Remove the print call.", line: undefined },
];

for (const fixture of cases) {
  const cwd = await mkdtemp(join(tmpdir(), "citation-live-"));
  try {
    const config = { model, citation: model, suites: { smoke: { files: [fixture.path], unchecked: "error", rules: {
      violation: { prompt: fixture.prompt, values: [{ value: "TRUE", severity: "error", report: fixture.report }, { value: "FALSE" }] },
    } } } };
    await writeFile(join(cwd, "config.mjs"), `const config = ${JSON.stringify(config)}; config.model.apiKey = config.citation.apiKey = process.env.OPENROUTER_API_KEY; export default config;`);
    if (fixture.before !== undefined) {
      await writeFile(join(cwd, fixture.path), fixture.before);
      for (const args of [["init", "-q"], ["add", "."], ["-c", "commit.gpgsign=false", "-c", "user.name=Citation test", "-c", "user.email=citation@example.test", "commit", "-qm", "base"]]) {
        execFileSync("git", args, { cwd });
      }
    }
    await writeFile(join(cwd, fixture.path), fixture.source);
    const run = spawnSync(process.execPath, [cli, "--config", "config.mjs", "--format", "json", ...(fixture.before === undefined ? [] : ["--base", "HEAD"]), fixture.path], { cwd, encoding: "utf8" });
    assert.equal(run.error, undefined, fixture.name);
    assert.equal(run.stderr, "", fixture.name);
    const results = JSON.parse(run.stdout);
    const findings = results.flatMap((call: { findings: unknown[] }) => call.findings);
    assert.equal(run.status, fixture.line === undefined ? 0 : 1, fixture.name);
    if (fixture.line === undefined) {
      assert.deepEqual(findings, []);
      assert.ok(results.every((call: { citation?: unknown }) => call.citation === undefined));
    } else {
      assert.equal(findings.length, 1, fixture.name);
      assert.equal(findings[0].locations?.[0]?.line, fixture.line, `${fixture.name}: citation should identify the offending line`);
      assert.equal(results[0].unchecked, undefined, fixture.name);
    }
    console.log(`PASS ${fixture.name}${fixture.line === undefined ? " has no findings" : ` cites line ${fixture.line}`}`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
