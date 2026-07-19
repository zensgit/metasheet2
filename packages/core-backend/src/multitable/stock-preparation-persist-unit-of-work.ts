import {
  acquireCanonicalSheetFencesInOrder,
  type FenceQuery,
} from "./canonical-sheet-fence";
import type { StockPreparationPersistUnitOfWorkInput } from "../types/plugin";

// Fixed, disjoint int4 namespaces. The two-argument advisory-lock form is also disjoint from the
// canonical one-argument sheet fences. Keep project before batch everywhere.
export const STOCK_PREPARATION_PROJECT_LOCK_NS = 0x73700101;
export const STOCK_PREPARATION_BATCH_LOCK_NS = 0x73700102;

export class StockPreparationPersistUnitOfWorkError extends Error {
  readonly code = "STOCK_PREPARATION_PERSIST_UNIT_OF_WORK_INVALID";

  constructor() {
    super("stock-preparation persist unit-of-work input is invalid");
    this.name = "StockPreparationPersistUnitOfWorkError";
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new StockPreparationPersistUnitOfWorkError();
  }
  return value.trim();
}

export function validateStockPreparationPersistUnitOfWorkInput(
  input: StockPreparationPersistUnitOfWorkInput,
): StockPreparationPersistUnitOfWorkInput {
  if (!input || !Array.isArray(input.sheetIds)) {
    throw new StockPreparationPersistUnitOfWorkError();
  }
  const tenantId = requiredString(input.tenantId);
  const sheetIds = input.sheetIds.map(requiredString);
  if (sheetIds.length !== 4 || new Set(sheetIds).size !== 4) {
    throw new StockPreparationPersistUnitOfWorkError();
  }
  const project = {
    sheetId: requiredString(input.project?.sheetId),
    projectId: requiredString(input.project?.projectId),
  };
  const batch = {
    sheetId: requiredString(input.batch?.sheetId),
    snapshotBatchId: requiredString(input.batch?.snapshotBatchId),
  };
  const allowed = new Set(sheetIds);
  if (!allowed.has(project.sheetId) || !allowed.has(batch.sheetId)) {
    throw new StockPreparationPersistUnitOfWorkError();
  }
  return { tenantId, sheetIds, project, batch };
}

export function stockPreparationProjectLockKey(
  input: StockPreparationPersistUnitOfWorkInput,
): string {
  return `${input.tenantId}|${input.project.sheetId}|${input.project.projectId}`;
}

export function stockPreparationBatchLockKey(
  input: StockPreparationPersistUnitOfWorkInput,
): string {
  return `${input.tenantId}|${input.batch.sheetId}|${input.batch.snapshotBatchId}`;
}

export async function acquireStockPreparationPersistUnitOfWorkLocks(
  query: FenceQuery,
  rawInput: StockPreparationPersistUnitOfWorkInput,
): Promise<StockPreparationPersistUnitOfWorkInput> {
  const input = validateStockPreparationPersistUnitOfWorkInput(rawInput);
  await acquireCanonicalSheetFencesInOrder(query, input.sheetIds);
  await query("SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)", [
    STOCK_PREPARATION_PROJECT_LOCK_NS,
    stockPreparationProjectLockKey(input),
  ]);
  await query("SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)", [
    STOCK_PREPARATION_BATCH_LOCK_NS,
    stockPreparationBatchLockKey(input),
  ]);
  return input;
}
