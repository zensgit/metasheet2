import { describe, expect, it, vi } from "vitest";

import {
  STOCK_PREPARATION_BATCH_LOCK_NS,
  STOCK_PREPARATION_PROJECT_LOCK_NS,
  StockPreparationPersistUnitOfWorkError,
  acquireStockPreparationPersistUnitOfWorkLocks,
  stockPreparationBatchLockKey,
  stockPreparationProjectLockKey,
} from "../../src/multitable/stock-preparation-persist-unit-of-work";

const input = {
  tenantId: "tenant_1",
  sheetIds: ["sheet_run", "sheet_project", "sheet_line", "sheet_batch"],
  project: { sheetId: "sheet_project", projectId: "project_1" },
  batch: { sheetId: "sheet_batch", snapshotBatchId: "batch_1" },
};

describe("stock-preparation persist unit-of-work locks", () => {
  it("takes sorted canonical sheet fences, then project and batch locks in fixed namespaces", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [] };
    });

    await expect(
      acquireStockPreparationPersistUnitOfWorkLocks(query, input),
    ).resolves.toEqual(input);

    expect(calls).toEqual([
      {
        sql: "SELECT pg_advisory_xact_lock(hashtext($1))",
        params: ["meta:auto-number:sheet:sheet_batch"],
      },
      {
        sql: "SELECT pg_advisory_xact_lock(hashtext($1))",
        params: ["meta:auto-number:sheet:sheet_line"],
      },
      {
        sql: "SELECT pg_advisory_xact_lock(hashtext($1))",
        params: ["meta:auto-number:sheet:sheet_project"],
      },
      {
        sql: "SELECT pg_advisory_xact_lock(hashtext($1))",
        params: ["meta:auto-number:sheet:sheet_run"],
      },
      {
        sql: "SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)",
        params: [
          STOCK_PREPARATION_PROJECT_LOCK_NS,
          '["tenant_1","sheet_project","project_1"]',
        ],
      },
      {
        sql: "SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)",
        params: [
          STOCK_PREPARATION_BATCH_LOCK_NS,
          '["tenant_1","sheet_batch","batch_1"]',
        ],
      },
    ]);
  });

  it("frames lock-key components without delimiter collisions", () => {
    const left = {
      ...input,
      tenantId: "tenant|one",
      project: { ...input.project, sheetId: "sheet_project" },
      batch: { ...input.batch, sheetId: "sheet_batch" },
    };
    const right = {
      ...input,
      tenantId: "tenant",
      project: { ...input.project, sheetId: "one|sheet_project" },
      batch: { ...input.batch, sheetId: "one|sheet_batch" },
    };

    expect(stockPreparationProjectLockKey(left)).not.toBe(
      stockPreparationProjectLockKey(right),
    );
    expect(stockPreparationBatchLockKey(left)).not.toBe(
      stockPreparationBatchLockKey(right),
    );
  });

  it("rejects a non-four-sheet or out-of-scope key before taking any lock", async () => {
    for (const invalid of [
      { ...input, sheetIds: input.sheetIds.slice(0, 3) },
      {
        ...input,
        sheetIds: ["sheet_batch", "sheet_batch", "sheet_line", "sheet_run"],
      },
      { ...input, project: { ...input.project, sheetId: "sheet_foreign" } },
    ]) {
      const query = vi.fn(async () => ({ rows: [] }));
      await expect(
        acquireStockPreparationPersistUnitOfWorkLocks(query, invalid),
      ).rejects.toBeInstanceOf(StockPreparationPersistUnitOfWorkError);
      expect(query).not.toHaveBeenCalled();
    }
  });
});
