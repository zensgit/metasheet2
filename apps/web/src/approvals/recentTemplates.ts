/**
 * B1-08: 最近使用模板捷径 — 纯 localStorage 模块，零后端。
 *
 * 发起热路径的现实是 90% 场景反复用同 2-3 个模板；提交成功时记录，模板中心顶部渲染
 * 「最近使用」chips 深链填单页。按 userId 隔离（同浏览器多账号不串），最多保留 5 条，
 * 按 templateId 去重、最近优先。存储损坏（手改/版本漂移）一律降级为空列表。
 */

export interface RecentTemplateEntry {
  templateId: string
  name: string
  category: string | null
  at: number
}

const KEY_PREFIX = 'approval-recent-templates:'
const MAX_ENTRIES = 5

function storageKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`
}

export function listRecentTemplates(userId: string | null | undefined): RecentTemplateEntry[] {
  if (!userId) return []
  try {
    const raw = window.localStorage.getItem(storageKey(userId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is RecentTemplateEntry =>
        !!e && typeof e === 'object' && typeof e.templateId === 'string' && typeof e.name === 'string',
    ).slice(0, MAX_ENTRIES)
  } catch {
    return []
  }
}

export function recordRecentTemplate(
  userId: string | null | undefined,
  entry: { templateId: string; name: string; category?: string | null },
  now: number = Date.now(),
): void {
  if (!userId || !entry.templateId) return
  try {
    const next: RecentTemplateEntry[] = [
      { templateId: entry.templateId, name: entry.name, category: entry.category ?? null, at: now },
      ...listRecentTemplates(userId).filter((e) => e.templateId !== entry.templateId),
    ].slice(0, MAX_ENTRIES)
    window.localStorage.setItem(storageKey(userId), JSON.stringify(next))
  } catch {
    // Quota/serialization failures must never break the submit path — the shortcut is best-effort.
  }
}
