/**
 * B1-05: 审批意见「快捷短语」— 预置短语 + 每人每动作的「个人常用语」。
 *
 * 点短语只是把文字填进意见框（可再改），提交与否由用户决定；意见框旁「存为常用语」把当前文字存为
 * 本人该动作的常用语，可删除。个人常用语排在预置短语之前。Storage is per-user browser
 * localStorage (corrupt-safe: bad JSON -> []; no-op without a userId). No existing server-side
 * per-user store with an API fits as-is; cross-device phrases await an owner decision.
 */
import { ref } from 'vue'

export type QuickPhraseAction = 'approve' | 'reject' | 'comment'

export const QUICK_PHRASES: Record<QuickPhraseAction, string[]> = {
  approve: ['同意', '情况属实', '已核实无误'],
  reject: ['不符合要求', '请补充材料后重新提交'],
  comment: ['已阅', '请尽快处理'],
}

// `approval-quick-phrases:<userId>:<action>` (no `personal:`) held the pre-2026-10-27 auto-remembered
// recents, which were always a subset of the presets; they are no longer read. The personal list
// lives under its own prefix so those recents never turn into "saved by me" entries.
const KEY_PREFIX = 'approval-quick-phrases:personal:'

/** At most this many personal phrases per user per action. */
export const MAX_PERSONAL_PHRASES = 20
/** At most this many characters (code points) in one personal phrase. */
export const MAX_PHRASE_LENGTH = 100

/**
 * Bumped on every successful save / remove, so every mounted phrase bar (detail dialogs, the
 * approval center's side pane and reject dialog) re-reads the list — localStorage is not reactive.
 */
export const personalPhrasesRevision = ref(0)

export function isQuickPhraseAction(action: string): action is QuickPhraseAction {
  return action === 'approve' || action === 'reject' || action === 'comment'
}

/** The fixed preset phrases offered for an action; an unrecognized action offers none. */
export function phrasesForAction(action: string): string[] {
  return isQuickPhraseAction(action) ? QUICK_PHRASES[action] : []
}

function storageKey(userId: string, action: string): string {
  return `${KEY_PREFIX}${userId}:${action}`
}

/** Length in characters (code points), so a CJK or emoji character counts once. */
export function phraseLength(text: string): number {
  return Array.from(text).length
}

/**
 * This user's saved phrases for this action, newest-saved first. Only well-formed entries survive a
 * read: strings, trimmed, non-empty, within the length cap, de-duplicated, capped at the list limit.
 */
export function personalPhrases(userId: string | null | undefined, action: string): string[] {
  if (!userId || !isQuickPhraseAction(action)) return []
  try {
    const raw = window.localStorage.getItem(storageKey(userId, action))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const entry of parsed) {
      if (typeof entry !== 'string') continue
      const text = entry.trim()
      if (!text || phraseLength(text) > MAX_PHRASE_LENGTH || seen.has(text)) continue
      seen.add(text)
      out.push(text)
      if (out.length >= MAX_PERSONAL_PHRASES) break
    }
    return out
  } catch {
    return []
  }
}

export type SavePhraseResult = 'saved' | 'empty' | 'too_long' | 'duplicate' | 'full' | 'no_user' | 'failed'

/**
 * Saves `text` (trimmed) as a personal phrase for this user + action, newest first. Never evicts an
 * older phrase: a full list answers `'full'` and the user deletes one first.
 */
export function savePersonalPhrase(userId: string | null | undefined, action: string, text: string): SavePhraseResult {
  if (!userId) return 'no_user'
  if (!isQuickPhraseAction(action)) return 'failed'
  const phrase = text.trim()
  if (!phrase) return 'empty'
  if (phraseLength(phrase) > MAX_PHRASE_LENGTH) return 'too_long'
  const current = personalPhrases(userId, action)
  if (current.includes(phrase)) return 'duplicate'
  if (current.length >= MAX_PERSONAL_PHRASES) return 'full'
  try {
    window.localStorage.setItem(storageKey(userId, action), JSON.stringify([phrase, ...current]))
  } catch {
    return 'failed'
  }
  personalPhrasesRevision.value += 1
  return 'saved'
}

/** Removes one personal phrase; `false` when there was nothing to remove or storage failed. */
export function removePersonalPhrase(userId: string | null | undefined, action: string, phrase: string): boolean {
  if (!userId || !isQuickPhraseAction(action)) return false
  const current = personalPhrases(userId, action)
  const next = current.filter((entry) => entry !== phrase)
  if (next.length === current.length) return false
  try {
    if (next.length > 0) window.localStorage.setItem(storageKey(userId, action), JSON.stringify(next))
    else window.localStorage.removeItem(storageKey(userId, action))
  } catch {
    return false
  }
  personalPhrasesRevision.value += 1
  return true
}

export type QuickPhraseChip = { text: string; personal: boolean }

/** Personal phrases first, then every preset that is not already one of them. */
export function quickPhraseChips(userId: string | null | undefined, action: string): QuickPhraseChip[] {
  const personal = personalPhrases(userId, action)
  const taken = new Set(personal)
  return [
    ...personal.map((text) => ({ text, personal: true })),
    ...phrasesForAction(action).filter((text) => !taken.has(text)).map((text) => ({ text, personal: false })),
  ]
}

/** A chip click fills an empty opinion, or appends after a full-width comma; the text stays editable. */
export function appendPhrase(current: string, phrase: string): string {
  return current ? `${current}，${phrase}` : phrase
}
