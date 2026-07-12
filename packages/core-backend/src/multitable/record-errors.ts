export class MultitableRecordValidationError extends Error {
  code = 'VALIDATION_ERROR'
}

export class MultitableRecordNotFoundError extends Error {
  code = 'NOT_FOUND'
}

/**
 * Thrown by the plugin-SDK record API (records.ts) when a caller tries to edit or delete a record that
 * is locked. The plugin path carries no per-record actor identity, so a locked record is hard read-only
 * to it (decision d/e) — the lock can only be lifted via the explicit unlock action.
 */
export class MultitableRecordLockedError extends Error {
  code = 'FORBIDDEN'
}

/**
 * D-2 (side-door delete recoverability, design-lock §OD-6 — typed SDK error contract). Thrown by the
 * plugin-SDK `deleteRecord` when tombstone capture is on and the record's inbound-edge count exceeds
 * `MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS`: the delete is REFUSED (fail-closed, §1.4) rather than run
 * half-captured, and the record still exists. Only reachable with
 * `MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED='true'` AND `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED='true'`
 * (§1.5 nesting) — a previously-succeeding SDK delete can therefore begin to fail once an operator opts
 * into BOTH flags. That behavior change is declared in the lock (§5) and surfaced here as a typed,
 * catchable contract instead of a bare throw.
 */
export class MultitableRecordDeleteCapExceededError extends Error {
  code = 'CAPTURE_CAP_EXCEEDED'

  constructor(
    message: string,
    public readonly totalRows: number,
    public readonly cap: number,
  ) {
    super(message)
    this.name = 'MultitableRecordDeleteCapExceededError'
  }
}
