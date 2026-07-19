/**
 * FWB §11 Q6 — server-generated confirmation challenge + persisted acknowledgement.
 *
 * Fingerprint covers identifiers only:
 *   { templateId, templateVersionId, targetBaseId, targetSheetId, mappings: [{formFieldId,targetFieldId}] }
 * No form/decision values. Any change invalidates. Save and execute read the persisted row —
 * never trust a free config boolean or client-supplied hash as authority.
 */
import { createHash, randomUUID } from 'node:crypto'

import type { AutomationDeps } from './automation-executor'

const NON_BLANK = /[!-~]/

export interface FwbConfirmationSubject {
  templateId: string
  templateVersionId: string
  targetBaseId: string | null
  targetSheetId: string
  /** identifiers only — formFieldId + targetFieldId pairs (order-insensitive). */
  mappings: readonly { formFieldId: string; targetFieldId: string }[]
}

export function computeFwbConfigFingerprint(subject: FwbConfirmationSubject): string {
  const normalized = {
    templateId: subject.templateId,
    templateVersionId: subject.templateVersionId,
    targetBaseId: subject.targetBaseId ?? null,
    targetSheetId: subject.targetSheetId,
    mappings: [...subject.mappings]
      .map((m) => ({ formFieldId: m.formFieldId, targetFieldId: m.targetFieldId }))
      .sort((a, b) =>
        a.formFieldId === b.formFieldId
          ? a.targetFieldId.localeCompare(b.targetFieldId)
          : a.formFieldId.localeCompare(b.formFieldId),
      ),
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

export interface FwbChallengeRow {
  id: string
  fingerprint: string
  challengeNonce: string
  confirmed: boolean
}

/** Create an unconfirmed challenge for the given subject (identifiers only). */
export async function createFwbConfirmationChallenge(
  queryFn: AutomationDeps['queryFn'],
  input: {
    sheetId: string
    configurerUserId: string
    subject: FwbConfirmationSubject
  },
): Promise<FwbChallengeRow> {
  const fingerprint = computeFwbConfigFingerprint(input.subject)
  const id = `fwbc_${randomUUID()}`
  const challengeNonce = createHash('sha256').update(`${id}:${randomUUID()}`).digest('hex').slice(0, 32)
  await queryFn(
    `INSERT INTO meta_fwb_confirmations
       (id, sheet_id, configurer_user_id, fingerprint, template_id, template_version_id,
        target_base_id, target_sheet_id, mapping_json, challenge_nonce, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,now())`,
    [
      id,
      input.sheetId,
      input.configurerUserId,
      fingerprint,
      input.subject.templateId,
      input.subject.templateVersionId,
      input.subject.targetBaseId,
      input.subject.targetSheetId,
      JSON.stringify(input.subject.mappings),
      challengeNonce,
    ],
  )
  return { id, fingerprint, challengeNonce, confirmed: false }
}

/** Explicit acknowledgement of a challenge. Values-free; binds confirmed_by only. */
export async function acknowledgeFwbConfirmation(
  queryFn: AutomationDeps['queryFn'],
  input: { confirmationId: string; configurerUserId: string; challengeNonce: string },
): Promise<{ ok: true } | { ok: false; code: 'not_found' | 'nonce_mismatch' | 'already_confirmed' | 'user_mismatch' }> {
  const res = await queryFn(
    `SELECT id, configurer_user_id, challenge_nonce, confirmed_at
       FROM meta_fwb_confirmations WHERE id = $1`,
    [input.confirmationId],
  )
  const row = res.rows[0] as {
    id: string
    configurer_user_id: string
    challenge_nonce: string
    confirmed_at: string | null
  } | undefined
  if (!row) return { ok: false, code: 'not_found' }
  if (row.configurer_user_id !== input.configurerUserId) return { ok: false, code: 'user_mismatch' }
  if (row.challenge_nonce !== input.challengeNonce) return { ok: false, code: 'nonce_mismatch' }
  if (row.confirmed_at) return { ok: false, code: 'already_confirmed' }
  await queryFn(
    `UPDATE meta_fwb_confirmations
        SET confirmed_at = now(), confirmed_by = $2
      WHERE id = $1 AND confirmed_at IS NULL`,
    [input.confirmationId, input.configurerUserId],
  )
  return { ok: true }
}

export type FwbConfirmationCheck =
  | { ok: true; confirmationId: string; fingerprint: string }
  | { ok: false; code: 'missing' | 'not_confirmed' | 'fingerprint_mismatch' | 'user_mismatch' }

/**
 * Verify a persisted confirmation is acknowledged AND still matches the current subject fingerprint.
 * Used at rule save and at execute.
 */
export async function verifyFwbConfirmation(
  queryFn: AutomationDeps['queryFn'],
  input: {
    confirmationId: string
    configurerUserId: string
    subject: FwbConfirmationSubject
  },
): Promise<FwbConfirmationCheck> {
  if (!NON_BLANK.test(input.confirmationId ?? '')) return { ok: false, code: 'missing' }
  const expected = computeFwbConfigFingerprint(input.subject)
  const res = await queryFn(
    `SELECT id, configurer_user_id, fingerprint, confirmed_at
       FROM meta_fwb_confirmations WHERE id = $1`,
    [input.confirmationId],
  )
  const row = res.rows[0] as {
    id: string
    configurer_user_id: string
    fingerprint: string
    confirmed_at: string | null
  } | undefined
  if (!row) return { ok: false, code: 'missing' }
  if (row.configurer_user_id !== input.configurerUserId) return { ok: false, code: 'user_mismatch' }
  if (!row.confirmed_at) return { ok: false, code: 'not_confirmed' }
  if (row.fingerprint !== expected) return { ok: false, code: 'fingerprint_mismatch' }
  return { ok: true, confirmationId: row.id, fingerprint: row.fingerprint }
}
