/**
 * Generates machine-readable module/test evidence:
 *   evidence/tests.json   — every spec, test name and pass/fail from vitest JSON
 *   evidence/modules.json — the 30 pack test-cases (T-001..T-030) mapped to suites,
 *                           status, module and commit
 * Usage: node scripts/evidence.mjs   (runs vitest --reporter=json itself)
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const commit = execSync("git rev-parse --short HEAD").toString().trim();
const generatedAt = new Date().toISOString();

console.log("running vitest --reporter=json …");
let raw;
try {
  raw = execSync("npx vitest run --reporter=json", { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
} catch (e) {
  raw = e.stdout; // vitest exits non-zero on failures — keep the JSON
}
const jsonStart = raw.indexOf("{");
const results = JSON.parse(raw.slice(jsonStart));

const tests = [];
for (const suite of results.testResults ?? []) {
  for (const t of suite.assertionResults ?? []) {
    const title = [...(t.ancestorTitles ?? []), t.title].join(" > ");
    const m = title.match(/T-0\d\d/);
    tests.push({
      tCase: m ? m[0] : null,
      suite: suite.name?.replace(root + "/", "") ?? "unknown",
      title,
      status: t.status,
      durationMs: t.duration ?? null,
    });
  }
}

const cases = [];
for (const t of tests) {
  if (!t.tCase) continue;
  const ex = cases.find((c) => c.id === t.tCase);
  const entry = ex ?? { id: t.tCase, suite: t.suite.match(/m(\d\d)/)?.[0] ?? t.suite,
    module: "M" + String(Math.ceil(Number(t.tCase.slice(2)) / 3)).padStart(2, "0"), tests: [] };
  entry.tests.push({ suite: t.suite, title: t.title, status: t.status });
  if (!ex) cases.push(entry);
}
for (const c of cases) {
  c.localCheckStatus = c.tests.every(t => t.status === "passed") ? "pass" : "fail";
  c.status = c.id === "T-029" ? "blocked" : c.localCheckStatus;
  if (c.id === "T-029") c.reason = "A real eligible Delphi entry and external receipt are required. The local guard check covers only blocker reporting.";
}
cases.sort((a, b) => a.id.localeCompare(b.id));

const covered = new Set(cases.map((c) => c.id));
const all30 = Array.from({ length: 30 }, (_, i) => `T-0${String(i + 1).padStart(2, "0")}`);
const missing = all30.filter((id) => !covered.has(id));

mkdirSync(join(root, "evidence"), { recursive: true });
writeFileSync(join(root, "evidence/tests.json"), JSON.stringify({
  generatedAt, commit, totals: results.numTotalTests
    ? { total: results.numTotalTests, passed: results.numPassedTests, failed: results.numFailedTests }
    : undefined,
  tests,
}, null, 2));
writeFileSync(join(root, "evidence/modules.json"), JSON.stringify({
  generatedAt, commit,
  summary: {
    testCasesCovered: covered.size, required: 30, missing,
    suitesPassed: results.numPassedTestSuites, suitesFailed: results.numFailedTestSuites,
    testsPassed: results.numPassedTests, testsFailed: results.numFailedTests,
  },
  cases,
}, null, 2));

console.log(JSON.stringify({ cases: cases.length, missing,
  passed: results.numPassedTests, failed: results.numFailedTests }, null, 2));
if (missing.length || results.numFailedTests) process.exit(1);
