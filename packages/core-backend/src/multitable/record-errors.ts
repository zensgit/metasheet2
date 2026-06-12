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
