/**
 * B1-05: 审批意见「快捷短语」— 纯 localStorage 模块，零后端。
 *
 * 通过/驳回/评论时反复手打同类措辞（'同意' / '不符合要求' / '已阅'…）是纯粹的重复劳动；
 * 这里为每个动作准备一份固定的常用短语表，并按 userId 记录真正点过、原样提交过的短语，
 * 让常用措辞排到最前面。Mirrors `recentTemplates.ts`'s per-user localStorage discipline: max
 * 3 entries, dedupe, most-recent-first, corrupt-safe (bad JSON → []), no-op without a userId.
 */

export type QuickPhraseAction = 'approve' | 'reject' | 'comment'

export const QUICK_PHRASES: Record<QuickPhraseAction, string[]> = {
  approve: ['同意', '情况属实', '已核实无误'],
  reject: ['不符合要求', '请补充材料后重新提交'],
  comment: ['已阅', '请尽快处理'],
}

const KEY_PREFIX = 'approval-quick-phrases:'
const MAX_ENTRIES = 3

function isQuickPhraseAction(action: string): action is QuickPhraseAction {
  return action === 'approve' || action === 'reject' || action === 'comment'
}

/** The fixed preset phrases offered for an action; an unrecognized action offers none. */
export function phrasesForAction(action: string): string[] {
  return isQuickPhraseAction(action) ? QUICK_PHRASES[action] : []
}

function storageKey(userId: string, action: string): string {
  return `${KEY_PREFIX}${userId}:${action}`
}

/** Phrases this user actually clicked+submitted for this action, most-recent-first. */
export function recentPhrases(userId: string | null | undefined, action: string): string[] {
  if (!userId) return []
  try {
    const raw = window.localStorage.getItem(storageKey(userId, action))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_ENTRIES)
  } catch {
    return []
  }
}

/**
 * Records a used phrase for this user+action, most-recent-first, deduped, capped at 3. No-ops
 * without a userId or an empty phrase — an anonymous/unresolved session never persists a
 * shortcut, and there is nothing useful to remember for blank input.
 */
export function rememberPhrase(userId: string | null | undefined, action: string, phrase: string): void {
  if (!userId || !phrase) return
  try {
    const next = [phrase, ...recentPhrases(userId, action).filter((entry) => entry !== phrase)].slice(0, MAX_ENTRIES)
    window.localStorage.setItem(storageKey(userId, action), JSON.stringify(next))
  } catch {
    // Quota/serialization failures must never break the submit path — the shortcut is best-effort.
  }
}
