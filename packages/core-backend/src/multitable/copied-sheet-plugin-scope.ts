/**
 * 复制快照的插件作用域拒绝（设计锁 ADR docs/development/multitable-copy-sheet-with-data-adr-20260926.md
 * CS-14 / §6「插件作用域（S8 修正）」）。
 *
 * 背景：托管表（`plugin_multitable_object_registry` 有行）只对本插件可达，他人访问由
 * `assertPluginOwnsSheet` 抛错。但复制物**永不登记** registry —— 它是非托管快照（可删、可改字段、
 * `ext_` 成普通列、PLM 不刷新）。而「registry 无行」在默认 `MULTITABLE_PLUGIN_SHEET_SCOPE_MODE=observe`
 * 下等于「任何插件都可达」（`index.ts` 的 assertSheetScope hook 只 warn 不拒）：一张备料表的带数据
 * 快照就这样对每个插件敞开了 —— 这正是 §1.10 指出、S8 要关掉的洞。
 *
 * 规则：目标表 `meta_sheets.copied_from_kind = 'plugin-managed'` → **任何模式下**（observe / enforce
 * 都算）抛 `MultitableSheetScopeError(pluginName, sheetId, 'copied-snapshot')`。不看 registry、不看
 * 模式 flag：这一列是服务端在复制事务里写死的，不是客户端可改的。`copied_from_kind = 'user'`（普通表
 * 的快照）与 NULL（不是复制物）不受此规则影响 —— 它们照旧走 registry / 模式判定。
 *
 * 部署窗口：provenance 列还没迁移（SQLSTATE 42703）时无拒绝 —— 列不存在意味着也不可能有任何一张
 * 复制物存在（复制路由写这一列，会在同一个 INSERT 上失败），所以这里放行是精确的，不是 fail-open 的
 * 妥协。只认 SQLSTATE 不认散文（中文 locale 的 PG 会翻译散文）。别的错误照常上抛（fail-closed：
 * 一个坏掉的库不该把作用域判定变成「放行」）。
 */

import { MultitableSheetScopeError, type MultitableScopeQueryFn } from './plugin-scope'

export const COPIED_SNAPSHOT_SCOPE_OWNER = 'copied-snapshot'
export const COPIED_FROM_KIND_PLUGIN_MANAGED = 'plugin-managed'
export const COPIED_FROM_KIND_USER = 'user'

/** 词表（迁移 zzzz20260927120000 的 CHECK 约束就是这两个值）。 */
export type CopiedFromKind = typeof COPIED_FROM_KIND_PLUGIN_MANAGED | typeof COPIED_FROM_KIND_USER

export function isCopiedFromKind(value: unknown): value is CopiedFromKind {
  return value === COPIED_FROM_KIND_PLUGIN_MANAGED || value === COPIED_FROM_KIND_USER
}

function isUndefinedColumn(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === '42703'
}

/**
 * The ONE statement this module issues. Exported so the unit test pins the shape (column-tolerant read is
 * NOT used on purpose: a `to_jsonb(...) ->> 'copied_from_kind'` read would silently answer NULL on a
 * database that HAS the column but where the query was rewritten — 42703 is the precise "not migrated"
 * signal and nothing else may look like it).
 */
export const COPIED_FROM_KIND_SQL = 'SELECT copied_from_kind FROM meta_sheets WHERE id = $1'

/**
 * Throw when `sheetId` is a snapshot copied from a plugin-managed sheet. Called by the host's
 * `assertSheetScope` hook BEFORE the registry/mode decision, for every plugin, in every mode.
 */
export async function assertSheetNotCopiedFromPluginManaged(
  query: MultitableScopeQueryFn,
  input: { pluginName: string; sheetId: string },
): Promise<void> {
  let kind: unknown
  try {
    const result = await query(COPIED_FROM_KIND_SQL, [input.sheetId])
    kind = (result.rows[0] as { copied_from_kind?: unknown } | undefined)?.copied_from_kind
  } catch (err) {
    if (isUndefinedColumn(err)) return // provenance column not migrated ⇒ no copy can exist yet
    throw err
  }
  if (kind === COPIED_FROM_KIND_PLUGIN_MANAGED) {
    throw new MultitableSheetScopeError(input.pluginName, input.sheetId, COPIED_SNAPSHOT_SCOPE_OWNER)
  }
}
