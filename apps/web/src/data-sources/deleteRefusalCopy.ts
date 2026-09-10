/**
 * Honest copy for the data-source DELETE referential refusal.
 *
 * ### What the server does
 *
 * `DELETE /api/data-sources/:id` refuses with 409
 * `DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS` while any 数据工厂 binding still points at the
 * source (canonical `integration_external_systems.connection_id`, or an owner-attributed legacy
 * `config.dataSourceId`). The refusal body carries `details.referenceCount` and NOTHING about the
 * referencing systems.
 *
 * ### Why this module exists
 *
 * Left alone, the store surfaces `error.message` verbatim — which is English prose naming an
 * internal table (`integration_external_systems.config.dataSourceId`) and advertising the
 * platform-admin `force=true` escape hatch. Operators of this page are neither. This turns the
 * refusal into the two things they can act on: HOW MANY bindings hold the source, and WHERE to go
 * clear them.
 *
 * ### Deliberately absent: force
 *
 * `force=true` is a platform-admin API-level action, audited as a deliberate reference break. It is
 * NOT surfaced here and there is no UI affordance for it — this copy must not teach an operator to
 * reach for a flag the UI will not send and their role would be refused anyway (403
 * `DATA_SOURCE_FORCE_DELETE_ADMIN_ONLY`).
 *
 * ### values-free
 *
 * Only the integer crosses into the copy. The referencing bindings' names, tenants, owners and
 * configuration never reach the client at all — the server sends a count and nothing else — so
 * there is nothing here to leak.
 */

/** The 409 code the referential delete guard raises. */
export const DATA_SOURCE_REFERENCED_CODE = 'DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS'

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return undefined
}

function errorReferenceCount(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'referenceCount' in error) {
    const count = (error as { referenceCount?: unknown }).referenceCount
    if (typeof count === 'number' && Number.isFinite(count)) return count
  }
  return undefined
}

/**
 * Confirm-dialog text shown BEFORE the request, when the list already knows the source is
 * referenced. It states the outcome (the server will refuse) instead of pretending the click might
 * work, and points at the bindings below rather than at a flag the UI does not send.
 *
 * `referenceCount` undefined means the server could not count (the list shows 未知) — in that case
 * the caller uses the plain confirm, because claiming a refusal we cannot predict is its own lie.
 */
export function deleteConfirmMessage(name: string, referenceCount?: number): string {
  if (referenceCount !== undefined && referenceCount > 0) {
    return (
      `数据源「${name}」正被 ${referenceCount} 个绑定引用，删除会被服务器拒绝（409）。\n` +
      `请先到下方「已配置连接」里解除这 ${referenceCount} 个引用，再回来删除。\n\n` +
      '仍要发起一次删除请求吗？'
    )
  }
  return `删除数据源「${name}」?此操作不可撤销。`
}

/**
 * Turn a delete failure into something the operator can act on. Only the referential 409 is
 * rewritten; every other failure keeps the server's own message, which is the behavior the store
 * already shipped.
 */
export function describeDeleteFailure(error: unknown): string {
  if (errorCode(error) === DATA_SOURCE_REFERENCED_CODE) {
    const count = errorReferenceCount(error)
    if (count === undefined) {
      return '该数据源仍被数据工厂的绑定引用，服务器拒绝删除（409）。请先到下方「已配置连接」里解除引用，再回来删除。'
    }
    return `该数据源被 ${count} 个绑定引用，服务器拒绝删除（409）。请先到下方「已配置连接」里解除这 ${count} 个引用，再回来删除。`
  }
  return error instanceof Error ? error.message : 'Failed to delete data source'
}
