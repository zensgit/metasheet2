/**
 * Live cell-cursor state — pure reducers over remote collaborators' active cells.
 *
 * The sheet socket relays `sheet:cursor` events ({ userId, recordId, fieldId }; recordId/fieldId null =
 * the user blurred/left). These pure functions fold those events into a Map keyed by userId, excluding
 * self, so the grid can render one highlight per remote collaborator. Kept pure (no socket/Vue) so the
 * tracking + self-exclusion + prune rules are unit-testable in isolation.
 */

export type RemoteCellCursor = { recordId: string; fieldId: string }

export type SheetCursorEvent = {
  userId?: unknown
  recordId?: unknown
  fieldId?: unknown
}

function asTrimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Fold one `sheet:cursor` event into the cursor map. Returns a NEW Map (so Vue reactivity sees a change).
 * - self events (userId === selfId) are ignored — you never render your own cursor as "remote";
 * - a complete cell (recordId AND fieldId) sets/replaces that user's cursor;
 * - an incomplete cell (either missing → blur/clear) removes that user's cursor.
 */
export function applyCursorEvent(
  cursors: Map<string, RemoteCellCursor>,
  event: SheetCursorEvent,
  selfId: string | null,
): Map<string, RemoteCellCursor> {
  const userId = asTrimmed(event.userId)
  if (!userId) return cursors
  if (selfId && userId === selfId) return cursors

  const recordId = asTrimmed(event.recordId)
  const fieldId = asTrimmed(event.fieldId)
  const next = new Map(cursors)
  if (recordId && fieldId) {
    next.set(userId, { recordId, fieldId })
  } else {
    next.delete(userId)
  }
  return next
}

/**
 * Drop cursors for users no longer present in the sheet (presence is the source of truth for "who's
 * here"; a disconnect also broadcasts a clear, but presence-prune is the backstop). Returns the SAME map
 * reference when nothing changed, else a new pruned Map.
 */
export function pruneCursors(
  cursors: Map<string, RemoteCellCursor>,
  activeUserIds: Iterable<string>,
): Map<string, RemoteCellCursor> {
  const allowed = new Set<string>()
  for (const id of activeUserIds) {
    const trimmed = asTrimmed(id)
    if (trimmed) allowed.add(trimmed)
  }
  let changed = false
  const next = new Map<string, RemoteCellCursor>()
  for (const [userId, cell] of cursors) {
    if (allowed.has(userId)) next.set(userId, cell)
    else changed = true
  }
  return changed ? next : cursors
}

/** Stable key for matching a remote cursor to a rendered grid cell. */
export function cursorCellKey(recordId: string, fieldId: string): string {
  return `${recordId}:${fieldId}`
}

/**
 * Index cursors by cell key → list of userIds, for O(1) per-cell lookup in the grid render. A cell can
 * carry more than one remote collaborator.
 */
export function cursorsByCell(cursors: Map<string, RemoteCellCursor>): Map<string, string[]> {
  const byCell = new Map<string, string[]>()
  for (const [userId, cell] of cursors) {
    const key = cursorCellKey(cell.recordId, cell.fieldId)
    const list = byCell.get(key)
    if (list) list.push(userId)
    else byCell.set(key, [userId])
  }
  return byCell
}
