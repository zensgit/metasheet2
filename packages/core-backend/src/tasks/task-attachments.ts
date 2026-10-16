/**
 * Task feature — attachments: the type/size allowlist, upload-candidate validation, display names,
 * storage keys, the download decision, add/remove permissions, event plans, comment-binding and
 * quota checks, and the download response headers. PURE, no I/O; bytes, timestamps and random
 * suffixes are passed in by the caller.
 *
 * Design: docs/development/task-e-m5-pure-functions-design-20261007.md §2.6
 * Lock:   task-feature-design-lock-20260917.md §3 (P2 scope), §4.2 (`task_attachments` +
 *         purge intents; event words `attachment_added` / `attachment_removed`), §13-23, §13-24
 *
 * External imports (both import-free, no I/O — D16):
 *   - `../services/imageMagicBytes` — `sniffImageContentType` (PNG/JPEG/GIF/BMP/WEBP signatures);
 *   - `../multitable/display-name-hygiene` — `checkDisplayNameHygiene`.
 */
import { checkDisplayNameHygiene } from '../multitable/display-name-hygiene'
import { sniffImageContentType } from '../services/imageMagicBytes'
import { can, type TaskRole } from './task-access'
import { isValidTaskDomainId, normalizeUserText } from './task-ids'

// RULED(2026-10-09): [S18] the closed allowlist, named explicitly (not inherited): pdf, png,
// jpeg (jpg/jpeg), gif, webp, txt, csv. This ONE table drives the allowed types, the
// extension-agreement check and the storage-key extension (first entry = the stored extension).
export const TASK_ATTACHMENT_MIME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'application/pdf': Object.freeze(['pdf']),
  'image/png': Object.freeze(['png']),
  'image/jpeg': Object.freeze(['jpg', 'jpeg']),
  'image/gif': Object.freeze(['gif']),
  'image/webp': Object.freeze(['webp']),
  'text/plain': Object.freeze(['txt']),
  'text/csv': Object.freeze(['csv']),
})

export const TASK_ATTACHMENT_ALLOWED_MIME_TYPES: readonly string[] = Object.freeze(Object.keys(TASK_ATTACHMENT_MIME_EXTENSIONS))

// RULED(2026-10-09): [S18] images and PDF must carry a signature that matches the declared type.
export const TASK_ATTACHMENT_SIGNATURE_MIME_TYPES: readonly string[] = Object.freeze([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

// RULED(2026-10-09): [S18] 10 MiB per file; 20 per task; 5 per comment and 25 MiB per comment.
// ASSUMPTION(task-e): [D18] the per-task and per-comment ceilings are defined once, here, and answer
// `limit`.
// RULED(2026-10-09): [S21] the refs resolver takes at most 200 ids in a body of at most 64 KiB.
// ASSUMPTION(task-e): [D5] a display name keeps at most 255 code points.
export const TASK_ATTACHMENT_LIMITS = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  maxPerTask: 20,
  maxPerComment: 5,
  maxCommentBytes: 25 * 1024 * 1024,
  maxRefIds: 200,
  maxRefBodyBytes: 64 * 1024,
  maxDisplayNameCodePoints: 255,
})

// RULED(2026-10-09): [S19] a row that was never bound expires 168 hours after it was created.
export const TASK_ATTACHMENT_UNBOUND_TTL_MS = 168 * 60 * 60 * 1000

// RULED(2026-10-09): [S22] task blobs live under their own key prefix, never under another line's.
export const TASK_ATTACHMENT_STORAGE_PREFIX = 'task-attachments/'

export const TASK_ATTACHMENT_STATUSES = ['unbound', 'bound', 'deleted'] as const
export type TaskAttachmentStatus = (typeof TASK_ATTACHMENT_STATUSES)[number]

// RULED(2026-10-09): [S19] two bindings: `task` (uploaded straight onto the task) and `comment`
// (staged unbound, bound when the comment is written).
export const TASK_ATTACHMENT_BIND_KINDS = ['task', 'comment'] as const
export type TaskAttachmentBindKind = (typeof TASK_ATTACHMENT_BIND_KINDS)[number]

// RULED(2026-10-09): [S22] there is no scanning engine in M5: new rows are always `unscanned`.
export const TASK_ATTACHMENT_SCAN_STATES = ['unscanned', 'clean', 'infected'] as const
export type TaskAttachmentScanState = (typeof TASK_ATTACHMENT_SCAN_STATES)[number]
export const TASK_ATTACHMENT_INITIAL_SCAN_STATE: TaskAttachmentScanState = 'unscanned'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function allowedExtensionsFor(mime: string): readonly string[] | undefined {
  return Object.hasOwn(TASK_ATTACHMENT_MIME_EXTENSIONS, mime) ? TASK_ATTACHMENT_MIME_EXTENSIONS[mime] : undefined
}

function requireRoles(roles: unknown, fn: string): TaskRole[] {
  if (!Array.isArray(roles)) throw new TypeError(`${fn}: roles must be an array of task roles`)
  return roles as TaskRole[]
}

function requireBindKind(value: unknown, fn: string): TaskAttachmentBindKind {
  if (value !== 'task' && value !== 'comment') throw new TypeError(`${fn}: bindKind must be 'task' or 'comment'`)
  return value
}

function requireDate(value: unknown, name: string, fn: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError(`${fn}: ${name} must be a valid Date`)
  return value
}

function requireActor(actorId: unknown, fn: string): string {
  if (typeof actorId !== 'string' || actorId.length === 0) throw new TypeError(`${fn}: actorId must be a non-empty string`)
  return actorId
}

// ── Upload validation ──────────────────────────────────────────────────────────────────────────

export type TaskAttachmentRejectReason =
  | 'invalid_size'
  | 'file_too_large'
  | 'mime_not_allowed'
  | 'extension_not_allowed'
  | 'extension_mime_mismatch'
  | 'content_mime_mismatch'

export type ValidateAttachmentCandidateResult =
  | { ok: true; mimeType: string; storageExtension: string }
  | { ok: false; reason: TaskAttachmentRejectReason }

/** Content type read from the leading bytes: the shared image sniffer plus the `%PDF` header. */
function detectSignature(head: Uint8Array): string | undefined {
  const image = sniffImageContentType(Buffer.from(head.buffer, head.byteOffset, head.byteLength))
  if (image) return image
  if (head.length >= 4 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) {
    return 'application/pdf'
  }
  return undefined
}

/** How many leading bytes the text-type check reads: every image header the sniffer knows fits in it. */
const TEXT_HEADER_PROBE_BYTES = 16

/** A byte that plain text does not contain: NUL or a C0 control other than TAB, LF, FF and CR. */
function isNonTextByte(byte: number): boolean {
  return byte <= 0x08 || byte === 0x0b || (byte >= 0x0e && byte <= 0x1f)
}

// ASSUMPTION(task-e, own choice): [S18] requires a matching signature for images and PDF only. For
// txt/csv the question is whether the bytes ARE an image or a PDF, not whether their first bytes
// look like a signature: refused when they start with the PDF magic `%PDF` (a PDF header is text by
// design, so its magic is the only evidence), or when the shared sniffer recognises an image
// signature AND the first 16 bytes hold a byte text does not contain. Every real image header has
// such a byte there (the 0x1A of PNG's signature, JPEG's segment length, GIF's screen size, the RIFF
// size of a WEBP up to 10 MiB, BMP's reserved zeros). So text that merely begins with "BM" or "GIF8"
// is accepted, and bytes with no recognised signature are never refused as text.
function textBytesAreImageOrPdf(head: Uint8Array, detected: string | undefined): boolean {
  if (detected === undefined) return false
  if (detected === 'application/pdf') return true
  const end = Math.min(head.length, TEXT_HEADER_PROBE_BYTES)
  for (let i = 0; i < end; i += 1) {
    if (isNonTextByte(head[i])) return true
  }
  return false
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase()
}

// ASSUMPTION(task-e, own choice): the declared type is lower-cased and trimmed, nothing else; a type
// with parameters (`text/plain; charset=utf-8`) is not on the allowlist.
/**
 * One uploaded file. Order: size (`invalid_size`, `file_too_large`) → declared type on the allowlist
 * → extension on the allowlist → extension agrees with the type → content. `head` (the uploaded
 * bytes, or at least their first 16) is REQUIRED: a signature-bearing type whose bytes carry no
 * matching signature is refused, and txt/csv whose bytes are an image or a PDF (see
 * `textBytesAreImageOrPdf`) are refused.
 */
export function validateAttachmentCandidate(input: {
  mimeType: unknown
  fileName: unknown
  sizeBytes: unknown
  head: Uint8Array
}): ValidateAttachmentCandidateResult {
  const fn = 'validateAttachmentCandidate'
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  if (!(input.head instanceof Uint8Array)) throw new TypeError(`${fn}: head must be a Uint8Array (the uploaded bytes)`)
  const size = input.sizeBytes
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return { ok: false, reason: 'invalid_size' }
  if (size > TASK_ATTACHMENT_LIMITS.maxFileBytes) return { ok: false, reason: 'file_too_large' }
  const mime = typeof input.mimeType === 'string' ? input.mimeType.trim().toLowerCase() : ''
  const allowedExtensions = allowedExtensionsFor(mime)
  if (!allowedExtensions) return { ok: false, reason: 'mime_not_allowed' }
  const extension = typeof input.fileName === 'string' ? extensionOf(input.fileName) : ''
  const knownExtension = Object.values(TASK_ATTACHMENT_MIME_EXTENSIONS).some((list) => list.includes(extension))
  if (!knownExtension) return { ok: false, reason: 'extension_not_allowed' }
  if (!allowedExtensions.includes(extension)) return { ok: false, reason: 'extension_mime_mismatch' }
  const detected = detectSignature(input.head)
  if (TASK_ATTACHMENT_SIGNATURE_MIME_TYPES.includes(mime)) {
    if (detected !== mime) return { ok: false, reason: 'content_mime_mismatch' }
  } else if (textBytesAreImageOrPdf(input.head, detected)) {
    return { ok: false, reason: 'content_mime_mismatch' }
  }
  return { ok: true, mimeType: mime, storageExtension: allowedExtensions[0] }
}

/** True when `extension` (in any letter case) is one of the allowlisted file extensions. */
function isAllowlistedExtension(extension: string): boolean {
  const lower = extension.toLowerCase()
  return Object.values(TASK_ATTACHMENT_MIME_EXTENSIONS).some((list) => list.includes(lower))
}

// ASSUMPTION(task-e): [D5] the display name is the client's file name cut to 255 and checked with the
// shared display-name hygiene.
// ASSUMPTION(task-e, own choice): the 255 counts CODE POINTS, where D5 writes `slice(0, 255)` (UTF-16
// units): a surrogate pair is never split, and a name of astral characters keeps up to 255 of them
// (up to 510 UTF-16 units). Recorded as a deviation in the design doc.
// ASSUMPTION(task-e, own choice): when the name is cut and ends with an allowlisted extension, the
// stem is shortened and the extension kept, so the saved name keeps the extension that was checked
// against the type; a name that is blank after normalization, or fails hygiene, is refused
// (`invalid_name`) rather than replaced.
export function normalizeAttachmentDisplayName(raw: unknown): { ok: true; name: string } | { ok: false; reason: 'invalid_name' } {
  const normalized = normalizeUserText(raw)
  if (normalized === null) return { ok: false, reason: 'invalid_name' }
  const max = TASK_ATTACHMENT_LIMITS.maxDisplayNameCodePoints
  let cut = normalized
  if ([...normalized].length > max) {
    const dot = normalized.lastIndexOf('.')
    const extension = dot > 0 ? normalized.slice(dot + 1) : ''
    const kept = extension.length > 0 && isAllowlistedExtension(extension) ? `.${extension}` : ''
    const stem = [...normalized.slice(0, normalized.length - kept.length)]
    cut = stem.slice(0, max - kept.length).join('') + kept
  }
  const name = normalizeUserText(cut)
  if (name === null || checkDisplayNameHygiene(name) !== null) return { ok: false, reason: 'invalid_name' }
  return { ok: true, name }
}

const STORAGE_SUFFIX_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/

/**
 * `task-attachments/<yyyy-mm>/<suffix>.<ext>`: the extension comes from the VALIDATED type (never
 * from the client file name); `suffix` is a random token made by the caller (alphanumeric runs
 * joined by single hyphens, so a UUID fits); the month is the UTC month of `now`.
 */
export function deriveTaskAttachmentStorageKey(mimeType: string, now: Date, suffix: string): string {
  const fn = 'deriveTaskAttachmentStorageKey'
  const extensions = typeof mimeType === 'string' ? allowedExtensionsFor(mimeType) : undefined
  if (!extensions) throw new TypeError(`${fn}: mimeType must be an allowlisted type`)
  const at = requireDate(now, 'now', fn)
  if (typeof suffix !== 'string' || suffix.length > 128 || !STORAGE_SUFFIX_RE.test(suffix)) {
    throw new TypeError(`${fn}: suffix must be alphanumeric runs joined by single hyphens`)
  }
  const month = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`
  return `${TASK_ATTACHMENT_STORAGE_PREFIX}${month}/${suffix}.${extensions[0]}`
}

// ── Download decision (S21) ────────────────────────────────────────────────────────────────────

export interface TaskAttachmentRowForDownload {
  orgId: string
  uploaderId: string
  status: TaskAttachmentStatus
  /** Set when the row was bound (and kept after a delete). `null` = never bound. */
  boundAt: Date | null
  scanState: TaskAttachmentScanState
}

export type TaskAttachmentDownloadDecision = 'allow' | 'not_found' | 'gone'

/**
 * A row's status and `boundAt` must agree: `unbound` ⇒ `boundAt` null, `bound` ⇒ `boundAt` set; a
 * `deleted` row may have either (deleted before or after it was bound). A contradictory row is data
 * corruption (TypeError), refused the same way by the download decision and the removal plan.
 */
function requireConsistentBinding(row: Record<string, unknown>, fn: string): void {
  if (!(TASK_ATTACHMENT_STATUSES as readonly unknown[]).includes(row.status)) throw new TypeError(`${fn}: row.status is not a known status`)
  if (row.boundAt !== null && !(row.boundAt instanceof Date)) throw new TypeError(`${fn}: row.boundAt must be a Date or null`)
  if (row.status === 'unbound' && row.boundAt !== null) throw new TypeError(`${fn}: an unbound row cannot carry boundAt`)
  if (row.status === 'bound' && row.boundAt === null) throw new TypeError(`${fn}: a bound row needs boundAt`)
}

function requireRow(row: unknown, fn: string): Record<string, unknown> {
  if (!isPlainObject(row)) throw new TypeError(`${fn}: row must be an object or null`)
  if (typeof row.orgId !== 'string' || typeof row.uploaderId !== 'string') throw new TypeError(`${fn}: row.orgId and row.uploaderId must be strings`)
  requireConsistentBinding(row, fn)
  if (!(TASK_ATTACHMENT_SCAN_STATES as readonly unknown[]).includes(row.scanState)) throw new TypeError(`${fn}: row.scanState is not a known state`)
  return row
}

// RULED(2026-10-09): [S21] the decision order is fixed:
//   1. viewer org or row org blank, or the two differ ⇒ not_found;
//   2. a never-bound row ⇒ only its uploader, everyone else not_found;
//   3. a bound row ⇒ `can(roles, 'view')` on the owning task, otherwise not_found;
//   4. only after 1–3: `deleted` or `infected` ⇒ gone (410).
// All three not_found answers are the same response. The route adds the resource gate
// (`authenticate` + `rbacGuard('tasks','read')`, 403) before this and storage errors (503) after it.
// When the owning task is missing or soft-deleted the caller passes `['none']`.
export function authorizeTaskAttachmentDownload(input: {
  row: TaskAttachmentRowForDownload | null
  viewerId: string
  viewerOrgId: string
  roles: TaskRole[]
}): { decision: TaskAttachmentDownloadDecision } {
  const fn = 'authorizeTaskAttachmentDownload'
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  if (typeof input.viewerId !== 'string' || typeof input.viewerOrgId !== 'string') {
    throw new TypeError(`${fn}: viewerId and viewerOrgId must be strings`)
  }
  const roles = requireRoles(input.roles, fn)
  if (input.row === null) return { decision: 'not_found' }
  const row = requireRow(input.row, fn) as unknown as TaskAttachmentRowForDownload
  if (input.viewerOrgId.length === 0 || row.orgId.length === 0 || input.viewerOrgId !== row.orgId) {
    return { decision: 'not_found' }
  }
  if (row.boundAt === null) {
    if (input.viewerId.length === 0 || input.viewerId !== row.uploaderId) return { decision: 'not_found' }
  } else if (!can(roles, 'view')) {
    return { decision: 'not_found' }
  }
  if (row.status === 'deleted' || row.scanState === 'infected') return { decision: 'gone' }
  return { decision: 'allow' }
}

// ── Permissions (S20) ──────────────────────────────────────────────────────────────────────────

// RULED(2026-10-09): [S20] adding to the task itself needs `attach` (creator / assignee /
// list-editor); adding inside a comment needs `comment` (followers and list readers included).
// Viewing and downloading need `view` (see `authorizeTaskAttachmentDownload`).
export function canAddAttachment(roles: TaskRole[], bindKind: TaskAttachmentBindKind): boolean {
  const fn = 'canAddAttachment'
  const r = requireRoles(roles, fn)
  return requireBindKind(bindKind, fn) === 'task' ? can(r, 'attach') : can(r, 'comment')
}

// RULED(2026-10-09): [S20] the uploader may remove their own upload whatever its binding; holders of
// `attach` may also remove TASK-level attachments of the task; a COMMENT-level attachment is
// removable by its uploader only. All of this is among people who can view the owning task: without
// `view` (lock §5.1: no role answers like a missing task) nobody may remove it, the uploader included.
/** For a bound attachment: may this actor remove it? `roles` are the actor's roles on the owning task. */
export function canRemoveAttachment(input: { roles: TaskRole[]; isUploader: boolean; bindKind: TaskAttachmentBindKind }): boolean {
  const fn = 'canRemoveAttachment'
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  const roles = requireRoles(input.roles, fn)
  const bindKind = requireBindKind(input.bindKind, fn)
  if (typeof input.isUploader !== 'boolean') throw new TypeError(`${fn}: isUploader must be a boolean`)
  if (!can(roles, 'view')) return false
  if (input.isUploader) return true
  return bindKind === 'task' && can(roles, 'attach')
}

export interface TaskAttachmentEvent {
  taskId: string
  type: 'attachment_added' | 'attachment_removed'
  userId: string
  occurredAt: Date
  payload: { attachmentId: string; bindKind?: TaskAttachmentBindKind }
}

export interface TaskAttachmentRowForRemoval {
  id: string
  /** The owning task; `null` only for a row that was never bound. */
  taskId: string | null
  uploaderId: string
  status: TaskAttachmentStatus
  bindKind: TaskAttachmentBindKind
  boundAt: Date | null
}

export type PlanRemoveAttachmentResult = { ok: false; reason: 'not_found' | 'forbidden' } | { ok: true; events: TaskAttachmentEvent[] }

/**
 * Removal plan. Missing or already deleted ⇒ `not_found`. A never-bound row (no owning task): its
 * uploader removes it with no task event; anyone else gets `not_found`. A bound row: an actor without
 * `view` on the owning task gets `not_found` — the uploader included (lock §5.1: no role on the task
 * answers exactly like a missing attachment); an actor who can view the task but may not remove the
 * attachment (`canRemoveAttachment`) gets `forbidden`; otherwise one `attachment_removed` on the
 * owning task. `roles` are the actor's roles on the owning task; when that task no longer exists or
 * is soft-deleted the caller passes `['none']`, so nobody removes its attachments (S23 keeps them).
 * There is no org input: the route must load the row within the session's org only (the approval
 * precedent's removal route does the same), so another org's row reaches this function as `null`. The row is marked
 * `deleted` (and its purge intent written) by the service layer in the same transaction.
 */
export function planRemoveAttachment(input: {
  row: TaskAttachmentRowForRemoval | null
  actorId: string
  roles: TaskRole[]
  now: Date
}): PlanRemoveAttachmentResult {
  const fn = 'planRemoveAttachment'
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  const actorId = requireActor(input.actorId, fn)
  const roles = requireRoles(input.roles, fn)
  const now = requireDate(input.now, 'now', fn)
  if (input.row === null) return { ok: false, reason: 'not_found' }
  if (!isPlainObject(input.row)) throw new TypeError(`${fn}: row must be an object or null`)
  const row = input.row as TaskAttachmentRowForRemoval
  if (!isValidTaskDomainId(row.id) || typeof row.uploaderId !== 'string') throw new TypeError(`${fn}: row.id and row.uploaderId are required`)
  requireConsistentBinding(input.row, fn)
  const bindKind = requireBindKind(row.bindKind, fn)
  if (row.status === 'deleted') return { ok: false, reason: 'not_found' }
  const isUploader = actorId === row.uploaderId
  if (row.boundAt === null) {
    return isUploader ? { ok: true, events: [] } : { ok: false, reason: 'not_found' }
  }
  if (!isValidTaskDomainId(row.taskId)) throw new TypeError(`${fn}: a bound row needs its taskId`)
  if (!can(roles, 'view')) return { ok: false, reason: 'not_found' }
  if (!canRemoveAttachment({ roles, isUploader, bindKind })) return { ok: false, reason: 'forbidden' }
  return {
    ok: true,
    events: [{ taskId: row.taskId as string, type: 'attachment_removed', userId: actorId, occurredAt: now, payload: { attachmentId: row.id } }],
  }
}

function dedupeIds(ids: unknown[]): string[] | null {
  const seen = new Set<string>()
  for (const id of ids) {
    if (!isValidTaskDomainId(id)) return null
    seen.add(id as string)
  }
  return [...seen]
}

// RULED(2026-10-09): [S19] one `attachment_added` per attachment, on the owning task, for both
// bindings.
export function planAttachmentAddedEvents(input: {
  taskId: string
  attachmentIds: readonly string[]
  bindKind: TaskAttachmentBindKind
  actorId: string
  now: Date
}): TaskAttachmentEvent[] {
  const fn = 'planAttachmentAddedEvents'
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  if (!isValidTaskDomainId(input.taskId)) throw new TypeError(`${fn}: taskId must be a valid task id`)
  const bindKind = requireBindKind(input.bindKind, fn)
  const actorId = requireActor(input.actorId, fn)
  const now = requireDate(input.now, 'now', fn)
  const ids = Array.isArray(input.attachmentIds) ? dedupeIds(input.attachmentIds) : null
  if (ids === null) throw new TypeError(`${fn}: attachmentIds must be an array of valid ids`)
  return ids.map((attachmentId) => ({
    taskId: input.taskId,
    type: 'attachment_added',
    userId: actorId,
    occurredAt: now,
    payload: { attachmentId, bindKind },
  }))
}

// RULED(2026-10-09): [S19] a comment carries at most 5 distinct attachment ids; the binding UPDATE
// itself (uploader, org, status and bind kind all matched; affected rows = distinct ids, or the
// comment is rolled back) is the route's transaction.
/** Absent ⇒ no attachments. Each id must be a well-formed id; duplicates collapse; more than 5 ⇒ `limit`. */
export function planCommentAttachmentBind(input: { attachmentIds?: unknown }): { ok: true; ids: string[] } | { ok: false; reason: 'invalid_ids' | 'limit' } {
  const fn = 'planCommentAttachmentBind'
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  if (input.attachmentIds === undefined) return { ok: true, ids: [] }
  if (!Array.isArray(input.attachmentIds)) return { ok: false, reason: 'invalid_ids' }
  const ids = dedupeIds(input.attachmentIds)
  if (ids === null) return { ok: false, reason: 'invalid_ids' }
  if (ids.length > TASK_ATTACHMENT_LIMITS.maxPerComment) return { ok: false, reason: 'limit' }
  return { ok: true, ids }
}

function requireSizes(sizes: unknown, fn: string): number[] {
  if (!Array.isArray(sizes) || sizes.some((s) => typeof s !== 'number' || !Number.isSafeInteger(s) || s <= 0)) {
    throw new TypeError(`${fn}: sizes must be an array of positive integers`)
  }
  return sizes as number[]
}

/** The rows a comment binds: at most 5, together at most 25 MiB. */
export function checkCommentAttachmentTotals(sizes: readonly number[]): { ok: true } | { ok: false; reason: 'limit' } {
  const list = requireSizes(sizes, 'checkCommentAttachmentTotals')
  if (list.length > TASK_ATTACHMENT_LIMITS.maxPerComment) return { ok: false, reason: 'limit' }
  const total = list.reduce((sum, s) => sum + s, 0)
  return total > TASK_ATTACHMENT_LIMITS.maxCommentBytes ? { ok: false, reason: 'limit' } : { ok: true }
}

// ASSUMPTION(task-e, own choice): the per-task ceiling counts every undeleted, bound attachment of
// the task, comment attachments included (they all show in the task's attachment panel).
export function checkTaskAttachmentQuota(input: { existingCount: number; adding: number }): { ok: true } | { ok: false; reason: 'limit' } {
  const fn = 'checkTaskAttachmentQuota'
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  const { existingCount, adding } = input
  if (typeof existingCount !== 'number' || !Number.isSafeInteger(existingCount) || existingCount < 0) {
    throw new TypeError(`${fn}: existingCount must be a non-negative integer`)
  }
  if (typeof adding !== 'number' || !Number.isSafeInteger(adding) || adding < 1) {
    throw new TypeError(`${fn}: adding must be a positive integer`)
  }
  return existingCount + adding > TASK_ATTACHMENT_LIMITS.maxPerTask ? { ok: false, reason: 'limit' } : { ok: true }
}

// RULED(2026-10-09): [S21] the 200-id ceiling counts the RAW array, before de-duplication and
// before the ids are checked, as the approval refs resolver that S21 cites does.
/** Body of the refs resolver: an array of at most 200 entries, each a well-formed id; returns the distinct ids. */
export function parseAttachmentRefIds(raw: unknown): { ok: true; ids: string[] } | { ok: false; reason: 'invalid_ids' | 'limit' } {
  if (!Array.isArray(raw)) return { ok: false, reason: 'invalid_ids' }
  if (raw.length > TASK_ATTACHMENT_LIMITS.maxRefIds) return { ok: false, reason: 'limit' }
  const ids = dedupeIds(raw)
  if (ids === null) return { ok: false, reason: 'invalid_ids' }
  return { ok: true, ids }
}

// ── Response headers (S21 / D6) ────────────────────────────────────────────────────────────────

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** RFC 5987 `value-chars`: UTF-8 bytes, everything outside `attr-char` percent-encoded. */
function encodeRfc5987(text: string): string {
  return encodeURIComponent(text.replace(LONE_SURROGATE_RE, '\uFFFD')).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** Quoted-string fallback: printable ASCII only, with `"` and `\` replaced. */
function asciiFallbackName(text: string): string {
  const cleaned = text.replace(/[^\x20-\x7E]|["\\]/g, '_')
  return cleaned.length === 0 ? 'attachment' : cleaned
}

// RULED(2026-10-09): [S21] four fixed headers on every download: the stored type, an
// `attachment` disposition with both `filename` and RFC 5987 `filename*`, `nosniff`, and a CSP of
// `default-src 'none'`. Never `inline`, never a signed URL or redirect.
// ASSUMPTION(task-e): [D6] the stored type, `nosniff` and the CSP value are those of the approval
// download route.
export function buildTaskAttachmentDownloadHeaders(input: { mimeType: string; fileName: string }): Record<string, string> {
  const fn = 'buildTaskAttachmentDownloadHeaders'
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  if (typeof input.mimeType !== 'string' || !allowedExtensionsFor(input.mimeType)) {
    throw new TypeError(`${fn}: mimeType must be an allowlisted type`)
  }
  if (typeof input.fileName !== 'string') throw new TypeError(`${fn}: fileName must be a string`)
  const name = input.fileName.length === 0 ? 'attachment' : input.fileName
  return {
    'Content-Type': input.mimeType,
    'Content-Disposition': `attachment; filename="${asciiFallbackName(name)}"; filename*=UTF-8''${encodeRfc5987(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  }
}

/** A never-bound row is collectable once `TASK_ATTACHMENT_UNBOUND_TTL_MS` has passed since it was created. */
export function isUnboundAttachmentExpired(input: { createdAt: Date; now: Date }): boolean {
  const fn = 'isUnboundAttachmentExpired'
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  const createdAt = requireDate(input.createdAt, 'createdAt', fn)
  const now = requireDate(input.now, 'now', fn)
  return now.getTime() - createdAt.getTime() >= TASK_ATTACHMENT_UNBOUND_TTL_MS
}
