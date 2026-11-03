import { ref } from 'vue'
import type { DingTalkPersonRecipientStatus } from '../types'

/**
 * 客户反馈 2026-10-21 item 1 (review round 1): whether a local user id in a 发送钉钉个人消息 action would be
 * reached by the sender — read from the server preflight (the sender's own query), NOT from the sheet
 * roster: the roster only lists users with a multitable role, so a directory-synced user typed in by id
 * used to get no check at all and the real run reached 0 people.
 *
 * - one batched request per check (chunked at the server cap), requests run one at a time;
 * - an id already known, in flight, or whose lookup failed less than RETRY_AFTER_MS ago is not re-sent,
 *   so a failing lookup is not retried on every blur;
 * - ids the server would refuse (too long / control characters) are not users: answered locally as missing;
 * - `reset()` (editor open) forgets everything, so a binding fixed since the last open is re-checked, and
 *   answers to requests sent before the reset are dropped;
 * - review round 2: a request is abandoned after LOOKUP_TIMEOUT_MS (aborted when the client honours the
 *   signal) so a hung request cannot block the queue; a timeout or error leaves the id in the 'failed' state
 *   (shown and counted as "could not check"), retried no sooner than RETRY_AFTER_MS later.
 */

export const DINGTALK_PERSON_RECIPIENT_STATUS_CHUNK = 200
const MAX_ID_LENGTH = 256
const RETRY_AFTER_MS = 15_000
export const LOOKUP_TIMEOUT_MS = 15_000
// C0 controls and DEL (mirrors the server's validation).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export type DingTalkPersonRecipientState = 'unknown' | 'checking' | 'failed' | 'missing' | 'inactive' | 'unlinked' | 'ready'

export interface DingTalkPersonRecipientCounts {
  notLinked: number
  inactive: number
  notFound: number
  checking: number
  /** Ids whose lookup failed or timed out — their DingTalk link is unknown. */
  unchecked: number
}

export interface DingTalkPersonRecipientStatusClient {
  getDingTalkPersonRecipientStatus?: (
    sheetId: string,
    userIds: string[],
    options?: { signal?: AbortSignal },
  ) => Promise<DingTalkPersonRecipientStatus[]>
}

export function useDingTalkPersonRecipientStatus(options: {
  client: () => DingTalkPersonRecipientStatusClient | undefined | null
  sheetId: () => string
  now?: () => number
}) {
  const now = options.now ?? (() => Date.now())
  const statuses = ref<Record<string, DingTalkPersonRecipientStatus>>({})
  const pending = ref<Record<string, true>>({})
  const failedAt = ref<Record<string, number>>({})
  let generation = 0
  let chain: Promise<void> = Promise.resolve()

  function isSendable(id: string): boolean {
    return id.length > 0 && id.length <= MAX_ID_LENGTH && !CONTROL_CHARS.test(id)
  }

  function recentlyFailed(id: string): boolean {
    const at = failedAt.value[id]
    return at !== undefined && now() - at < RETRY_AFTER_MS
  }

  function setFailed(ids: string[], on: boolean) {
    const next = { ...failedAt.value }
    for (const id of ids) {
      if (on) next[id] = now()
      else delete next[id]
    }
    failedAt.value = next
  }

  function lookupWithTimeout(
    lookup: NonNullable<DingTalkPersonRecipientStatusClient['getDingTalkPersonRecipientStatus']>,
    client: DingTalkPersonRecipientStatusClient,
    sheetId: string,
    batch: string[],
  ): Promise<DingTalkPersonRecipientStatus[]> {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller?.abort()
        reject(new Error('DingTalk recipient status lookup timed out'))
      }, LOOKUP_TIMEOUT_MS)
    })
    return Promise.race([lookup.call(client, sheetId, batch, controller ? { signal: controller.signal } : undefined), timeout])
      .finally(() => { if (timer !== undefined) clearTimeout(timer) })
  }

  function setStatuses(items: DingTalkPersonRecipientStatus[]) {
    if (items.length === 0) return
    const next = { ...statuses.value }
    for (const item of items) next[item.userId] = item
    statuses.value = next
  }

  function setPending(ids: string[], on: boolean) {
    const next = { ...pending.value }
    for (const id of ids) {
      if (on) next[id] = true
      else delete next[id]
    }
    pending.value = next
  }

  /** Look up the ids not yet known. Resolves when this batch (and any queued before it) is done. */
  function check(ids: string[]): Promise<void> {
    const client = options.client()
    const lookup = client?.getDingTalkPersonRecipientStatus
    if (!client || typeof lookup !== 'function') return Promise.resolve()
    const wanted = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))).filter((id) =>
      statuses.value[id] === undefined && !pending.value[id] && !recentlyFailed(id),
    )
    if (wanted.length === 0) return chain
    setStatuses(wanted.filter((id) => !isSendable(id)).map((userId) => ({ userId, exists: false, active: false, dingtalkLinked: false })))
    const remote = wanted.filter(isSendable)
    if (remote.length === 0) return chain
    setPending(remote, true)
    const sheetId = options.sheetId()
    const started = generation
    chain = chain.then(async () => {
      for (let i = 0; i < remote.length; i += DINGTALK_PERSON_RECIPIENT_STATUS_CHUNK) {
        const batch = remote.slice(i, i + DINGTALK_PERSON_RECIPIENT_STATUS_CHUNK)
        if (started !== generation) return
        try {
          const items = await lookupWithTimeout(lookup, client, sheetId, batch)
          if (started !== generation) return
          const asked = new Set(batch)
          setStatuses(items.filter((item) => asked.has(item.userId)))
          setFailed(batch, false)
        } catch {
          if (started !== generation) return
          setFailed(batch, true)
        } finally {
          if (started === generation) setPending(batch, false)
        }
      }
    })
    return chain
  }

  function reset() {
    generation += 1
    statuses.value = {}
    pending.value = {}
    failedAt.value = {}
    // Requests of the previous open still settle (and are dropped above); new checks do not wait for them.
    chain = Promise.resolve()
  }

  function stateOf(id: string): DingTalkPersonRecipientState {
    const status = statuses.value[id]
    if (status) {
      if (!status.exists) return 'missing'
      if (!status.active) return 'inactive'
      if (!status.dingtalkLinked) return 'unlinked'
      return 'ready'
    }
    if (pending.value[id]) return 'checking'
    return failedAt.value[id] !== undefined ? 'failed' : 'unknown'
  }

  function counts(ids: string[]): DingTalkPersonRecipientCounts {
    const result: DingTalkPersonRecipientCounts = { notLinked: 0, inactive: 0, notFound: 0, checking: 0, unchecked: 0 }
    for (const id of new Set(ids)) {
      const state = stateOf(id)
      if (state === 'unlinked') result.notLinked += 1
      else if (state === 'inactive') result.inactive += 1
      else if (state === 'missing') result.notFound += 1
      else if (state === 'checking') result.checking += 1
      else if (state === 'failed') result.unchecked += 1
    }
    return result
  }

  return { statuses, pending, check, reset, stateOf, counts }
}

/** Name lookups (exact-id roster searches) run at most this many at a time. */
export const RECIPIENT_NAME_LOOKUP_CONCURRENCY = 4
/** A failed name lookup is not retried for this long (review round 1 F10). */
export const RECIPIENT_NAME_LOOKUP_RETRY_AFTER_MS = RETRY_AFTER_MS

/** Run `fn` over `items` with at most `limit` calls in flight. */
export async function forEachWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      await fn(item)
    }
  })
  await Promise.all(workers)
}
