/**
 * FWB §11 Q6 — server-generated confirmation challenge + persisted acknowledgement.
 *
 * Fingerprint covers identifiers only:
 *   { templateId, templateVersionId, targetBaseId, targetSheetId, mappings: [{formFieldId,targetFieldId}] }
 * No form/decision values. Any change invalidates. Save and execute read the persisted row —
 * never trust a free config boolean or client-supplied hash as authority.
 *
 * Challenge is server-authoritative: callers supply templateId + mapping identifiers (+ optional
 * record-link field for update/decision). The server resolves active_version_id, record-link
 * target binding, and ACL gates itself before inserting the challenge row.
 */
import { createHash, randomUUID } from 'node:crypto'

import type { AutomationDeps } from './automation-executor'
import { isAdmin } from '../rbac/service'
import { resolveSheetCapabilitiesForUser } from './sheet-capabilities'
import {
  isApprovalTemplateVisibleToUser,
  loadActiveTemplateVersionBundle,
  resolveActiveTemplateVersionId,
} from './approval-template-visibility'
import { loadTargetFieldsFromMeta, resolvePinnedRecordLinkTarget } from './approval-fwb-target-fields'

const NON_BLANK = /[!-~]/
export const FWB_V1_SOURCE_FIELD_TYPES: ReadonlySet<string> = new Set([
  'text',
  'textarea',
  'number',
  'date',
  'datetime',
  'select',
])

export function isSupportedFwbSourceField(field: Record<string, unknown>): boolean {
  return typeof field.id === 'string'
    && NON_BLANK.test(field.id.trim())
    && typeof field.type === 'string'
    && FWB_V1_SOURCE_FIELD_TYPES.has(field.type)
}

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
  /** Authoritative subject the server bound — client must persist confirmationId only. */
  subject: FwbConfirmationSubject
}

export type FwbChallengeBuildError =
  | 'template_not_found'
  | 'template_not_visible'
  | 'active_version_missing'
  | 'mappings_invalid'
  | 'source_field_missing'
  | 'source_field_unsupported'
  | 'target_field_missing'
  | 'record_link_required'
  | 'record_link_invalid'
  | 'target_manage_denied'
  | 'target_write_denied'

export type FwbChallengeBuildResult =
  | { ok: true; subject: FwbConfirmationSubject }
  | { ok: false; code: FwbChallengeBuildError }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formFieldsFromSchema(formSchema: Record<string, unknown>): Array<Record<string, unknown>> {
  const fields = Array.isArray(formSchema.fields) ? formSchema.fields : []
  return fields.filter(isRecord)
}

/**
 * Resolve the authoritative Q6 subject + gate checks for a challenge/save.
 * Client-supplied templateVersionId is NEVER authority — only active_version_id is.
 */
export async function buildAuthoritativeFwbChallengeSubject(
  queryFn: AutomationDeps['queryFn'],
  input: {
    configurerUserId: string
    templateId: string
    /** Rule/host sheet — used as create-mode target when targetSheetId omitted. */
    hostSheetId: string
    mode: 'create' | 'update' | 'decision'
    mappings: readonly { formFieldId: string; targetFieldId: string }[]
    recordLinkFieldId?: string | null
    /** Optional create-mode target override (same-base product constraint still enforced at save). */
    targetSheetId?: string | null
  },
): Promise<FwbChallengeBuildResult> {
  const templateId = input.templateId.trim()
  if (!NON_BLANK.test(templateId)) return { ok: false, code: 'template_not_found' }
  if (!input.mappings.length) return { ok: false, code: 'mappings_invalid' }

  const visible = await isApprovalTemplateVisibleToUser(queryFn, templateId, input.configurerUserId)
  if (!visible) return { ok: false, code: 'template_not_visible' }

  const templateVersionId = await resolveActiveTemplateVersionId(queryFn, templateId)
  if (!templateVersionId) return { ok: false, code: 'active_version_missing' }

  const bundle = await loadActiveTemplateVersionBundle(queryFn, templateId)
  if (!bundle || bundle.templateVersionId !== templateVersionId) {
    return { ok: false, code: 'active_version_missing' }
  }

  const formFields = formFieldsFromSchema(bundle.formSchema)
  const formFieldsById = new Map(
    formFields
      .map((f) => [typeof f.id === 'string' ? f.id.trim() : '', f] as const)
      .filter(([id]) => Boolean(id)),
  )

  const mappings: Array<{ formFieldId: string; targetFieldId: string }> = []
  const seenTargets = new Set<string>()
  for (const m of input.mappings) {
    const formFieldId = typeof m.formFieldId === 'string' ? m.formFieldId.trim() : ''
    const targetFieldId = typeof m.targetFieldId === 'string' ? m.targetFieldId.trim() : ''
    if (!NON_BLANK.test(formFieldId) || !NON_BLANK.test(targetFieldId)) {
      return { ok: false, code: 'mappings_invalid' }
    }
    const formField = formFieldsById.get(formFieldId)
    if (!formField) return { ok: false, code: 'source_field_missing' }
    if (!isSupportedFwbSourceField(formField)) {
      return { ok: false, code: 'source_field_unsupported' }
    }
    if (seenTargets.has(targetFieldId)) return { ok: false, code: 'mappings_invalid' }
    seenTargets.add(targetFieldId)
    mappings.push({ formFieldId, targetFieldId })
  }

  let targetSheetId = input.hostSheetId
  let targetBaseId: string | null = null

  if (input.mode === 'create') {
    if (input.targetSheetId && NON_BLANK.test(input.targetSheetId.trim())) {
      targetSheetId = input.targetSheetId.trim()
    }
  } else {
    const recordLinkFieldId = typeof input.recordLinkFieldId === 'string'
      ? input.recordLinkFieldId.trim()
      : ''
    if (!NON_BLANK.test(recordLinkFieldId)) return { ok: false, code: 'record_link_required' }
    const field = formFields.find(
      (f) => f.id === recordLinkFieldId && f.type === 'record-link',
    )
    if (!field) return { ok: false, code: 'record_link_invalid' }
    const props = isRecord(field.props) ? field.props : {}
    // Fail closed: sheetId required AND baseId must exactly match non-deleted meta_sheets.base_id.
    const pinned = await resolvePinnedRecordLinkTarget(queryFn, props)
    if (!pinned.ok) return { ok: false, code: 'record_link_invalid' }
    targetSheetId = pinned.sheetId
    targetBaseId = pinned.baseId
  }

  // Target field authority from meta_fields.
  const fieldRes = await loadTargetFieldsFromMeta(
    queryFn,
    targetSheetId,
    mappings.map((m) => m.targetFieldId),
  )
  if (!fieldRes.ok) return { ok: false, code: 'target_field_missing' }

  // Q6 G1/G3: admin OR canManageSheetAccess; plus write capability for mode.
  const admin = await isAdmin(input.configurerUserId)
  if (!admin) {
    const { capabilities } = await resolveSheetCapabilitiesForUser(
      queryFn,
      targetSheetId,
      input.configurerUserId,
    )
    if (!capabilities.canManageSheetAccess) return { ok: false, code: 'target_manage_denied' }
    if (input.mode === 'create' && !capabilities.canCreateRecord) {
      return { ok: false, code: 'target_write_denied' }
    }
    if ((input.mode === 'update' || input.mode === 'decision') && !capabilities.canEditRecord) {
      return { ok: false, code: 'target_write_denied' }
    }
  }

  return {
    ok: true,
    subject: {
      templateId,
      templateVersionId,
      targetBaseId,
      targetSheetId,
      mappings,
    },
  }
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
  return {
    id,
    fingerprint,
    challengeNonce,
    confirmed: false,
    subject: input.subject,
  }
}

/**
 * Explicit acknowledgement of a challenge. Atomic conditional UPDATE … RETURNING so exactly one
 * concurrent ack succeeds; the loser sees zero rows and returns already_confirmed / not_found.
 */
export async function acknowledgeFwbConfirmation(
  queryFn: AutomationDeps['queryFn'],
  input: { confirmationId: string; configurerUserId: string; challengeNonce: string },
): Promise<
  | { ok: true; confirmationId: string }
  | { ok: false; code: 'not_found' | 'nonce_mismatch' | 'already_confirmed' | 'user_mismatch' }
> {
  // Pre-check identity/nonce for precise error codes (values-free). The race is sealed by the
  // conditional UPDATE RETURNING below — only one concurrent winner gets a row back.
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

  const upd = await queryFn(
    `UPDATE meta_fwb_confirmations
        SET confirmed_at = now(), confirmed_by = $2
      WHERE id = $1
        AND configurer_user_id = $2
        AND challenge_nonce = $3
        AND confirmed_at IS NULL
      RETURNING id`,
    [input.confirmationId, input.configurerUserId, input.challengeNonce],
  )
  if (upd.rows.length !== 1) {
    // Lost the race to another concurrent ack (or row vanished).
    return { ok: false, code: 'already_confirmed' }
  }
  return { ok: true, confirmationId: input.confirmationId }
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
