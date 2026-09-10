import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "../../../..");
const WORKFLOW_PATH = join(
  REPO_ROOT,
  ".github/workflows/approval-realdb-acceptance.yml",
);
const VITEST_CONFIG_PATH = join(
  REPO_ROOT,
  "packages/core-backend/vitest.config.ts",
);
const REALDB_TEST_PATH = join(
  REPO_ROOT,
  "packages/core-backend/tests/integration/approval-department-field.db.test.ts",
);
const RELATIVE_TEST_PATH =
  "packages/core-backend/tests/integration/approval-department-field.db.test.ts";

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

function eventPaths(source: string, event: "pull_request" | "push"): string[] {
  const start = source.indexOf(`  ${event}:`);
  const end =
    event === "pull_request"
      ? source.indexOf("  push:", start)
      : source.indexOf("\npermissions:", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return Array.from(
    source.slice(start, end).matchAll(/^\s+- '([^']+)'$/gm),
    (match) => match[1],
  );
}

describe("Lock-2 department field real-DB CI wiring", () => {
  it("triggers for the whole real-DB file on pull requests and main pushes", () => {
    const workflow = withoutComments(readFileSync(WORKFLOW_PATH, "utf8"));
    expect(eventPaths(workflow, "pull_request")).toContain(RELATIVE_TEST_PATH);
    expect(eventPaths(workflow, "push")).toContain(RELATIVE_TEST_PATH);
  });

  it("runs the whole file in an EXPECT_DB-armed PostgreSQL job", () => {
    const workflow = withoutComments(readFileSync(WORKFLOW_PATH, "utf8"));
    const start = workflow.indexOf("  approval-realdb-lock2-department-field:");
    const end = workflow.indexOf(
      "\n  approval-realdb-pack1a-lifecycle:",
      start,
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const job = workflow.slice(start, end);

    expect(job).toContain("EXPECT_DB: '1'");
    expect(job).toMatch(
      /vitest\s+--config vitest\.integration\.config\.ts run\s+tests\/integration\/approval-department-field\.db\.test\.ts\s+--reporter=verbose/s,
    );
  });

  it("excludes the DB-gated file from no-DB collection and keeps its top-level sentinel", () => {
    const vitestConfig = withoutComments(
      readFileSync(VITEST_CONFIG_PATH, "utf8"),
    );
    const realDbTest = withoutComments(readFileSync(REALDB_TEST_PATH, "utf8"));

    expect(vitestConfig).toContain(
      "'tests/integration/approval-department-field.db.test.ts'",
    );
    expect(realDbTest).toContain(
      "process.env.EXPECT_DB === '1' ? it : it.skip",
    );
    expect(realDbTest).toContain(
      "expect(process.env.DATABASE_URL).toBeTruthy()",
    );
  });
});
