/**
 * Sheet-addressed HTTP REFUSALS — one definition, every route.
 *
 * ── Why this module exists ────────────────────────────────────────────────────
 * The 403 body and the two liveness 404 bodies were hand-copied from `routes/univer-meta.ts` into
 * every new sheet-addressed route (most recently the automation rule-scoped reads, #5779). The
 * copies were byte-equivalent on the day they were written and nothing held them there: changing
 * univer-meta's `sendForbidden` (an extra field, a different code) or teaching `sendSheetNotLive` a
 * new liveness state left the copies silently on the old body, so two routes answered DIFFERENTLY
 * for the SAME condition — and a client that switches on `error.code` sees that as two bugs.
 *
 * Refusal SHAPE is a contract, not a local detail. It lives here so the sheet-addressed surfaces
 * cannot drift apart; the codes/messages themselves stay in `sheet-liveness.ts`, which owns the
 * liveness model.
 *
 * ── Values-free by construction ───────────────────────────────────────────────
 * Neither helper takes a sheet id, a rule id, or an error object, so neither CAN echo one. That is
 * deliberate rather than conventional — the #L5-wire no-leak golden pins that a refusal never pastes
 * the requested id back (an owner fix on 2026-08-25 removed exactly that from the checkpoint route).
 * Not having the value is the only way not to leak it.
 */
import type { Response } from 'express'
import {
  SHEET_DELETED_CODE,
  SHEET_DELETED_MESSAGE,
  SHEET_NOT_FOUND_MESSAGE,
  type SheetLiveness,
} from './sheet-liveness'

/** The authority refusal. 403 — the actor may not act; the sheet is not the problem. */
export function sendForbidden(res: Response, message = 'Insufficient permissions') {
  return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message } })
}

/**
 * SHEET LIVENESS refusal — the 404 that soft delete made necessary.
 *
 * The hard delete was safe by construction: the row and (by FK cascade) every `meta_records` row were
 * gone, so a path that addressed records by `sheet_id` and never joined `meta_sheets` still found
 * nothing. Soft delete removed that guarantee — a deleted sheet stays fully addressable to anyone
 * holding its id — so every sheet-addressed path now refuses explicitly.
 *
 * 404, not 403: the actor's authority is not the problem; there is no live sheet to act on.
 * `SHEET_DELETED` is distinct from `NOT_FOUND` so a client can offer the restore instead of
 * reporting a phantom.
 */
export function sendSheetNotLive(res: Response, liveness: SheetLiveness) {
  if (liveness === 'deleted') {
    return res.status(404).json({ ok: false, error: { code: SHEET_DELETED_CODE, message: SHEET_DELETED_MESSAGE } })
  }
  return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: SHEET_NOT_FOUND_MESSAGE } })
}
