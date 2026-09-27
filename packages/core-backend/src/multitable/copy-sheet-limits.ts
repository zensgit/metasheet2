/**
 * 「复制数据表（含数据）」的两个大小上限（设计锁 ADR
 * docs/development/multitable-copy-sheet-with-data-adr-20260926.md CS-15 / §7.5）。
 *
 * - 行数上限 N：默认 2000（客户表 1239 行在内），env `MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS` 可调，
 *   登记在 scripts/ops/global-history-flag-manifest.mjs。解析口径与 DINGTALK_TODO_MIRROR_INTERVAL_MS
 *   同形：`Number(env)`；非有限 / 非正整数 → 默认值；夹在 [1, 50 000]（50 000 = XLSX_MAX_ROWS，
 *   ADR §7.5 的绝对上限，异步也不超）。超过 N 行 → 413 `COPY_TOO_LARGE`（S3 异步在这个上限之外）。
 * - 字段数上限 500：本功能自己的常量（`univer-meta.ts` 的 500 是模板请求 `fieldIds` 的 zod 上限，
 *   不是模板字段上限，CS-15 特意分开）。不可配置。
 *
 * 常量名故意不带 `MULTITABLE_` 前缀：flag manifest 的完整性测试把 `packages/core-backend/src` 里所有
 * `MULTITABLE_[A-Z_0-9]+` 记号当成 flag 名核对，只有真的从 process.env 读的那一个（下面的 env 名）
 * 该出现在 manifest 里。
 */

export const COPY_SHEET_SYNC_MAX_ROWS_ENV = 'MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS'
export const COPY_SHEET_SYNC_MAX_ROWS_DEFAULT = 2000
/** ADR §7.5：绝对上限 50 000（= XLSX_MAX_ROWS），env 再大也夹到这里。 */
export const COPY_SHEET_SYNC_MAX_ROWS_CEILING = 50_000
export const COPY_SHEET_MAX_FIELDS = 500

/**
 * 同步复制的行数上限。unset / blank / 非数字 / 非正整数 → 默认 2000；> 50 000 → 50 000。
 * 每次调用都重读 env（不缓存），与 `isWriterFenceEnabled` 等 flag 读法一致，测试可直接改 process.env。
 */
export function resolveCopySheetSyncMaxRows(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS
  if (typeof raw !== 'string' || raw.trim() === '') return COPY_SHEET_SYNC_MAX_ROWS_DEFAULT
  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) return COPY_SHEET_SYNC_MAX_ROWS_DEFAULT
  return Math.min(parsed, COPY_SHEET_SYNC_MAX_ROWS_CEILING)
}
