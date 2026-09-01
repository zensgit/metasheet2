import { randomUUID } from 'node:crypto'

import {
  ELEARNING_OFFLINE_QR_TTL_SECONDS,
  ELEARNING_OFFLINE_REQUEST_HASH_VERSION,
  ElearningOfflineError,
  createElearningOfflineQrToken,
  digestElearningOfflineQrToken,
  hashElearningOfflineRequest,
  normalizeIssueElearningOfflineQr,
  normalizePublishElearningOfflineTraining,
  normalizeRecordElearningOfflineAttendance,
  normalizeSetElearningOfflineTrainingStatus,
  type ElearningOfflineAttendanceAction,
  type ElearningOfflineAttendanceMode,
  type ElearningOfflineTrainingStatus,
} from './elearning-offline-training'

export const ELEARNING_OFFLINE_QR_SECRET_ENV = 'ELEARNING_OFFLINE_QR_SIGNING_SECRET' as const

export interface ElearningOfflineQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningOfflineDb extends ElearningOfflineQueryable {
  transaction<T>(handler: (tx: ElearningOfflineQueryable) => Promise<T>): Promise<T>
}

export interface PublishElearningOfflineTrainingInput {
  orgId: string
  actorId: string
  command: unknown
}

export interface IssueElearningOfflineQrInput {
  orgId: string
  actorId: string
  command: unknown
}

export interface RecordElearningOfflineAttendanceInput {
  orgId: string
  userId: string
  command: unknown
}

export interface SetElearningOfflineTrainingStatusInput {
  orgId: string
  actorId: string
  trainingId: string
  command: unknown
}

export interface ElearningOfflineTargetResult {
  targetId: string
  position: number
  title: string
  startsAt: string
  endsAt: string
  checkInOpensAt: string
  checkInClosesAt: string
  checkOutOpensAt: string
  checkOutClosesAt: string
}

export interface ElearningOfflinePublishResult {
  trainingId: string
  revisionId: string
  title: string
  location: string
  attendanceMode: ElearningOfflineAttendanceMode
  targets: ElearningOfflineTargetResult[]
  memberCount: number
  createdAt: string
  duplicate: boolean
}

export interface ElearningOfflineQrResult {
  trainingId: string
  revisionId: string
  targetId: string
  action: ElearningOfflineAttendanceAction
  token: string
  issuedAt: string
  expiresAt: string
  duplicate: boolean
}

export interface ElearningOfflineAttendanceResult {
  eventId: string
  trainingId: string
  revisionId: string
  targetId: string
  action: ElearningOfflineAttendanceAction
  occurredAt: string
  targetStatus: 'checked_in' | 'checked_out'
  completionStatus: 'completed' | 'in_progress'
  completedTargetCount: number
  totalTargetCount: number
  duplicate: boolean
}

export interface ElearningOfflineTrainingStatusResult {
  trainingId: string
  status: ElearningOfflineTrainingStatus
  reason: string
  changedAt: string
  duplicate: boolean
}

export interface ElearningOfflineLearnerTraining {
  trainingId: string
  revisionId: string
  title: string
  location: string
  attendanceMode: ElearningOfflineAttendanceMode
  status: 'active' | 'archived'
  targets: Array<ElearningOfflineTargetResult & {
    attendanceStatus: 'checked_in' | 'checked_out' | 'not_checked_in'
    checkedInAt: string | null
    checkedOutAt: string | null
  }>
  completionStatus: 'completed' | 'in_progress'
}

function fail(code: ConstructorParameters<typeof ElearningOfflineError>[0]): never {
  throw new ElearningOfflineError(code)
}

function value(row: Record<string, unknown>, key: string): string {
  const result = row[key]
  if (typeof result !== 'string' || result === '') fail('unavailable')
  return result
}

function integer(row: Record<string, unknown>, key: string): number {
  const raw = row[key]
  const result = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(result) || result < 0) fail('unavailable')
  return result
}

function instant(row: Record<string, unknown>, key: string): string {
  const raw = row[key]
  const date = raw instanceof Date ? raw : typeof raw === 'string' ? new Date(raw) : null
  if (!date || !Number.isFinite(date.getTime())) fail('unavailable')
  return date.toISOString()
}

function nullableInstant(row: Record<string, unknown>, key: string): string | null {
  return row[key] === null ? null : instant(row, key)
}

function mode(row: Record<string, unknown>): ElearningOfflineAttendanceMode {
  const raw = value(row, 'attendance_mode')
  if (raw !== 'training' && raw !== 'session') fail('unavailable')
  return raw
}

function attendanceAction(row: Record<string, unknown>): ElearningOfflineAttendanceAction {
  const raw = value(row, 'action')
  if (raw !== 'check_in' && raw !== 'check_out') fail('unavailable')
  return raw
}

function trainingStatus(row: Record<string, unknown>, key = 'status'): ElearningOfflineTrainingStatus {
  const raw = value(row, key)
  if (raw !== 'active' && raw !== 'archived' && raw !== 'withdrawn') fail('unavailable')
  return raw
}

function hashWithoutRequestId(command: Record<string, unknown>, domain: string): string {
  const { requestId: _requestId, ...payload } = command
  return hashElearningOfflineRequest(domain, payload)
}

async function lockRequest(tx: ElearningOfflineQueryable, domain: string, identity: string): Promise<void> {
  await tx.query(
    `/* elearning-offline:request-lock */
     SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
    [domain, identity],
  )
}

async function requireActiveOrgUser(
  tx: ElearningOfflineQueryable,
  orgId: string,
  userId: string,
): Promise<void> {
  const result = await tx.query(
    `/* elearning-offline:active-user */
     SELECT 1 AS ok
     FROM user_orgs membership
     JOIN users account ON account.id = membership.user_id
     WHERE membership.org_id = $1 AND membership.user_id = $2
       AND membership.is_active = true AND account.is_active = true
     FOR SHARE OF membership, account`,
    [orgId, userId],
  )
  if (result.rows.length !== 1) fail('forbidden')
}

async function databaseNow(tx: ElearningOfflineQueryable): Promise<string> {
  const result = await tx.query('SELECT clock_timestamp() AS now')
  if (result.rows.length !== 1) fail('unavailable')
  return instant(result.rows[0]!, 'now')
}

function targetResult(row: Record<string, unknown>): ElearningOfflineTargetResult {
  return {
    targetId: value(row, 'target_id'),
    position: integer(row, 'position'),
    title: value(row, 'title'),
    startsAt: instant(row, 'starts_at'),
    endsAt: instant(row, 'ends_at'),
    checkInOpensAt: instant(row, 'check_in_opens_at'),
    checkInClosesAt: instant(row, 'check_in_closes_at'),
    checkOutOpensAt: instant(row, 'check_out_opens_at'),
    checkOutClosesAt: instant(row, 'check_out_closes_at'),
  }
}

async function loadPublishResult(
  tx: ElearningOfflineQueryable,
  orgId: string,
  trainingId: string,
  revisionId: string,
  duplicate: boolean,
): Promise<ElearningOfflinePublishResult> {
  const head = await tx.query(
    `/* elearning-offline:publish-result */
     SELECT revision.title, revision.location, revision.attendance_mode,
            revision.created_at,
            (SELECT count(*)::integer FROM elearning_offline_training_members member
             WHERE member.org_id = revision.org_id AND member.revision_id = revision.id) AS member_count
     FROM elearning_offline_training_revisions revision
     JOIN elearning_offline_trainings training
       ON training.org_id = revision.org_id
      AND training.id = revision.training_id
      AND training.active_revision_id = revision.id
     WHERE revision.org_id = $1 AND revision.training_id = $2::uuid AND revision.id = $3::uuid`,
    [orgId, trainingId, revisionId],
  )
  const targets = await tx.query(
    `/* elearning-offline:publish-targets */
     SELECT id::text AS target_id, position, title, starts_at, ends_at,
            check_in_opens_at, check_in_closes_at, check_out_opens_at, check_out_closes_at
     FROM elearning_offline_training_targets
     WHERE org_id = $1 AND training_id = $2::uuid AND revision_id = $3::uuid
     ORDER BY position ASC`,
    [orgId, trainingId, revisionId],
  )
  if (head.rows.length !== 1 || targets.rows.length === 0) fail('unavailable')
  const row = head.rows[0]!
  return {
    trainingId,
    revisionId,
    title: value(row, 'title'),
    location: value(row, 'location'),
    attendanceMode: mode(row),
    targets: targets.rows.map(targetResult),
    memberCount: integer(row, 'member_count'),
    createdAt: instant(row, 'created_at'),
    duplicate,
  }
}

export async function publishElearningOfflineTraining(
  db: ElearningOfflineDb,
  input: PublishElearningOfflineTrainingInput,
): Promise<ElearningOfflinePublishResult> {
  const command = normalizePublishElearningOfflineTraining(input.command)
  const requestHash = hashWithoutRequestId(command as unknown as Record<string, unknown>, 'publish')
  return db.transaction(async (tx) => {
    await lockRequest(tx, 'elearning-offline-publish', `${input.orgId}:${command.requestId}`)
    await requireActiveOrgUser(tx, input.orgId, input.actorId)
    const replay = await tx.query(
      `SELECT request_hash, request_hash_version, training_id::text, revision_id::text
       FROM elearning_offline_publish_requests
       WHERE org_id = $1 AND request_id = $2::uuid`,
      [input.orgId, command.requestId],
    )
    if (replay.rows.length > 0) {
      const row = replay.rows[0]!
      if (value(row, 'request_hash') !== requestHash
        || integer(row, 'request_hash_version') !== ELEARNING_OFFLINE_REQUEST_HASH_VERSION) fail('conflict')
      return loadPublishResult(
        tx,
        input.orgId,
        value(row, 'training_id'),
        value(row, 'revision_id'),
        true,
      )
    }
    const members = await tx.query(
      `/* elearning-offline:members */
       SELECT membership.user_id
       FROM user_orgs membership
       JOIN users account ON account.id = membership.user_id
       WHERE membership.org_id = $1
         AND membership.user_id = ANY($2::text[])
         AND membership.is_active = true AND account.is_active = true
       FOR SHARE OF membership, account`,
      [input.orgId, command.memberUserIds],
    )
    if (members.rows.length !== command.memberUserIds.length) fail('forbidden')

    const trainingId = randomUUID()
    const revisionId = randomUUID()
    await tx.query(
      `INSERT INTO elearning_offline_training_revisions
         (id, org_id, training_id, revision, title, location, attendance_mode, created_by)
       VALUES ($1::uuid, $2, $3::uuid, 1, $4, $5, $6, $7)`,
      [revisionId, input.orgId, trainingId, command.title, command.location,
        command.attendanceMode, input.actorId],
    )
    for (const [index, target] of command.targets.entries()) {
      await tx.query(
        `INSERT INTO elearning_offline_training_targets
           (org_id, training_id, revision_id, position, title, starts_at, ends_at,
            check_in_opens_at, check_in_closes_at, check_out_opens_at, check_out_closes_at)
         VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6::timestamptz, $7::timestamptz,
                 $8::timestamptz, $9::timestamptz, $10::timestamptz, $11::timestamptz)`,
        [input.orgId, trainingId, revisionId, index + 1, target.title, target.startsAt,
          target.endsAt, target.checkInOpensAt, target.checkInClosesAt,
          target.checkOutOpensAt, target.checkOutClosesAt],
      )
    }
    for (const userId of command.memberUserIds) {
      await tx.query(
        `INSERT INTO elearning_offline_training_members
           (org_id, training_id, revision_id, user_id)
         VALUES ($1, $2::uuid, $3::uuid, $4)`,
        [input.orgId, trainingId, revisionId, userId],
      )
    }
    await tx.query(
      `INSERT INTO elearning_offline_trainings
         (id, org_id, active_revision_id, created_by)
       VALUES ($1::uuid, $2, $3::uuid, $4)`,
      [trainingId, input.orgId, revisionId, input.actorId],
    )
    await tx.query(
      `INSERT INTO elearning_offline_publish_requests
         (org_id, request_id, request_hash, request_hash_version, training_id, revision_id)
       VALUES ($1, $2::uuid, $3, $4, $5::uuid, $6::uuid)`,
      [input.orgId, command.requestId, requestHash, ELEARNING_OFFLINE_REQUEST_HASH_VERSION,
        trainingId, revisionId],
    )
    return loadPublishResult(tx, input.orgId, trainingId, revisionId, false)
  })
}

async function loadStatusResult(
  tx: ElearningOfflineQueryable,
  orgId: string,
  eventId: string,
  duplicate: boolean,
): Promise<ElearningOfflineTrainingStatusResult> {
  const result = await tx.query(
    `SELECT training_id::text, to_status AS status, reason, changed_at
     FROM elearning_offline_training_status_events
     WHERE org_id = $1 AND id = $2::uuid`,
    [orgId, eventId],
  )
  if (result.rows.length !== 1) fail('unavailable')
  const row = result.rows[0]!
  return {
    trainingId: value(row, 'training_id'),
    status: trainingStatus(row),
    reason: value(row, 'reason'),
    changedAt: instant(row, 'changed_at'),
    duplicate,
  }
}

export async function setElearningOfflineTrainingStatus(
  db: ElearningOfflineDb,
  input: SetElearningOfflineTrainingStatusInput,
): Promise<ElearningOfflineTrainingStatusResult> {
  const command = normalizeSetElearningOfflineTrainingStatus(input.command)
  const { requestId: _requestId, ...payload } = command
  const requestHash = hashElearningOfflineRequest('status', {
    trainingId: input.trainingId,
    ...payload,
  })
  return db.transaction(async (tx) => {
    await lockRequest(tx, 'elearning-offline-status', `${input.orgId}:${command.requestId}`)
    await requireActiveOrgUser(tx, input.orgId, input.actorId)
    const replay = await tx.query(
      `SELECT request_hash, request_hash_version, event_id::text
       FROM elearning_offline_training_status_requests
       WHERE org_id = $1 AND request_id = $2::uuid`,
      [input.orgId, command.requestId],
    )
    if (replay.rows.length > 0) {
      const row = replay.rows[0]!
      if (value(row, 'request_hash') !== requestHash
        || integer(row, 'request_hash_version') !== ELEARNING_OFFLINE_REQUEST_HASH_VERSION) fail('conflict')
      return loadStatusResult(tx, input.orgId, value(row, 'event_id'), true)
    }
    const head = await tx.query(
      `SELECT status FROM elearning_offline_trainings
       WHERE org_id = $1 AND id = $2::uuid
       FOR UPDATE`,
      [input.orgId, input.trainingId],
    )
    if (head.rows.length !== 1) fail('not_found')
    const fromStatus = trainingStatus(head.rows[0]!)
    const allowed = (fromStatus === 'active' && (command.status === 'archived' || command.status === 'withdrawn'))
      || (fromStatus === 'archived' && (command.status === 'active' || command.status === 'withdrawn'))
      || (fromStatus === 'withdrawn' && command.status === 'active')
    if (!allowed) fail('conflict')
    const eventId = randomUUID()
    const event = await tx.query(
      `INSERT INTO elearning_offline_training_status_events
         (id, org_id, training_id, from_status, to_status, actor_id, reason)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7)
       RETURNING changed_at`,
      [eventId, input.orgId, input.trainingId, fromStatus, command.status, input.actorId, command.reason],
    )
    if (event.rows.length !== 1) fail('unavailable')
    await tx.query(
      `SELECT set_config('metasheet.elearning_offline_status_event_id', $1, true)`,
      [eventId],
    )
    const updated = await tx.query(
      `UPDATE elearning_offline_trainings SET status = $3
       WHERE org_id = $1 AND id = $2::uuid AND status = $4
       RETURNING id::text`,
      [input.orgId, input.trainingId, command.status, fromStatus],
    )
    if (updated.rows.length !== 1) fail('conflict')
    await tx.query(
      `INSERT INTO elearning_offline_training_status_requests
         (org_id, request_id, request_hash, request_hash_version, event_id)
       VALUES ($1, $2::uuid, $3, $4, $5::uuid)`,
      [input.orgId, command.requestId, requestHash, ELEARNING_OFFLINE_REQUEST_HASH_VERSION, eventId],
    )
    return loadStatusResult(tx, input.orgId, eventId, false)
  })
}

function qrSecret(env: NodeJS.ProcessEnv): string {
  const value = env[ELEARNING_OFFLINE_QR_SECRET_ENV]
  if (typeof value !== 'string') fail('unavailable')
  const byteLength = Buffer.byteLength(value, 'utf8')
  if (byteLength < 32 || byteLength > 1024) fail('unavailable')
  return value
}

async function loadQrResult(
  tx: ElearningOfflineQueryable,
  orgId: string,
  challengeId: string,
  env: NodeJS.ProcessEnv,
  duplicate: boolean,
): Promise<ElearningOfflineQrResult> {
  const result = await tx.query(
    `SELECT id::text AS challenge_id, training_id::text, revision_id::text,
            target_id::text, action, issued_at, expires_at
     FROM elearning_offline_qr_challenges
     WHERE org_id = $1 AND id = $2::uuid`,
    [orgId, challengeId],
  )
  if (result.rows.length !== 1) fail('unavailable')
  const row = result.rows[0]!
  const issuedAt = instant(row, 'issued_at')
  const expiresAt = instant(row, 'expires_at')
  const trainingId = value(row, 'training_id')
  const revisionId = value(row, 'revision_id')
  const targetId = value(row, 'target_id')
  const action = attendanceAction(row)
  return {
    trainingId,
    revisionId,
    targetId,
    action,
    token: createElearningOfflineQrToken(challengeId, qrSecret(env)),
    issuedAt,
    expiresAt,
    duplicate,
  }
}

export async function issueElearningOfflineQr(
  db: ElearningOfflineDb,
  input: IssueElearningOfflineQrInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ElearningOfflineQrResult> {
  const command = normalizeIssueElearningOfflineQr(input.command)
  qrSecret(env)
  const requestHash = hashWithoutRequestId(command as unknown as Record<string, unknown>, 'qr-issue')
  return db.transaction(async (tx) => {
    await lockRequest(tx, 'elearning-offline-qr', `${input.orgId}:${command.requestId}`)
    await requireActiveOrgUser(tx, input.orgId, input.actorId)
    const replay = await tx.query(
      `SELECT request_hash, request_hash_version, challenge_id::text
       FROM elearning_offline_qr_requests WHERE org_id = $1 AND request_id = $2::uuid`,
      [input.orgId, command.requestId],
    )
    if (replay.rows.length > 0) {
      const row = replay.rows[0]!
      if (value(row, 'request_hash') !== requestHash
        || integer(row, 'request_hash_version') !== ELEARNING_OFFLINE_REQUEST_HASH_VERSION) fail('conflict')
      return loadQrResult(tx, input.orgId, value(row, 'challenge_id'), env, true)
    }
    const context = await tx.query(
      `SELECT training.active_revision_id::text AS revision_id
       FROM elearning_offline_trainings training
       JOIN elearning_offline_training_targets target
         ON target.org_id = training.org_id
        AND target.training_id = training.id
        AND target.revision_id = training.active_revision_id
       WHERE training.org_id = $1 AND training.id = $2::uuid
         AND target.id = $3::uuid AND training.status = 'active'
       FOR SHARE OF training, target`,
      [input.orgId, command.trainingId, command.targetId],
    )
    if (context.rows.length !== 1) fail('not_found')
    const revisionId = value(context.rows[0]!, 'revision_id')
    await lockRequest(
      tx,
      'elearning-offline-qr-effect',
      `${input.orgId}:${revisionId}:${command.targetId}:${command.action}`,
    )
    const issuedAt = await databaseNow(tx)
    const expiresAt = new Date(Date.parse(issuedAt) + ELEARNING_OFFLINE_QR_TTL_SECONDS * 1000)
      .toISOString()
    const challengeId = randomUUID()
    const token = createElearningOfflineQrToken(challengeId, qrSecret(env))
    const tokenDigest = digestElearningOfflineQrToken(token)
    await tx.query(
      `UPDATE elearning_offline_qr_challenges
       SET superseded_at = $5::timestamptz
       WHERE org_id = $1 AND revision_id = $2::uuid AND target_id = $3::uuid
         AND action = $4 AND superseded_at IS NULL`,
      [input.orgId, revisionId, command.targetId, command.action, issuedAt],
    )
    await tx.query(
      `INSERT INTO elearning_offline_qr_challenges
         (id, org_id, training_id, revision_id, target_id, action, issued_by,
          issued_at, expires_at, token_digest)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7,
               $8::timestamptz, $9::timestamptz, $10)`,
      [challengeId, input.orgId, command.trainingId, revisionId, command.targetId,
        command.action, input.actorId, issuedAt, expiresAt, tokenDigest],
    )
    await tx.query(
      `INSERT INTO elearning_offline_qr_requests
         (org_id, request_id, request_hash, request_hash_version, challenge_id)
       VALUES ($1, $2::uuid, $3, $4, $5::uuid)`,
      [input.orgId, command.requestId, requestHash, ELEARNING_OFFLINE_REQUEST_HASH_VERSION,
        challengeId],
    )
    return {
      trainingId: command.trainingId,
      revisionId,
      targetId: command.targetId,
      action: command.action,
      token,
      issuedAt,
      expiresAt,
      duplicate: false,
    }
  })
}

async function loadAttendanceResult(
  tx: ElearningOfflineQueryable,
  orgId: string,
  userId: string,
  eventId: string,
  duplicate: boolean,
): Promise<ElearningOfflineAttendanceResult> {
  const result = await tx.query(
    `SELECT event.id::text AS event_id, event.training_id::text,
            event.revision_id::text, event.target_id::text, event.action,
            event.occurred_at,
            (SELECT count(*)::integer FROM elearning_offline_training_targets target
             WHERE target.org_id = event.org_id AND target.revision_id = event.revision_id)
              AS total_target_count,
            (SELECT count(DISTINCT checkout.target_id)::integer
             FROM elearning_offline_attendance_events checkout
             WHERE checkout.org_id = event.org_id AND checkout.revision_id = event.revision_id
               AND checkout.user_id = $3 AND checkout.action = 'check_out')
              AS completed_target_count
     FROM elearning_offline_attendance_events event
     WHERE event.org_id = $1 AND event.id = $2::uuid AND event.user_id = $3`,
    [orgId, eventId, userId],
  )
  if (result.rows.length !== 1) fail('unavailable')
  const row = result.rows[0]!
  const completedTargetCount = integer(row, 'completed_target_count')
  const totalTargetCount = integer(row, 'total_target_count')
  const eventAction = attendanceAction(row)
  return {
    eventId: value(row, 'event_id'),
    trainingId: value(row, 'training_id'),
    revisionId: value(row, 'revision_id'),
    targetId: value(row, 'target_id'),
    action: eventAction,
    occurredAt: instant(row, 'occurred_at'),
    targetStatus: eventAction === 'check_out' ? 'checked_out' : 'checked_in',
    completionStatus: completedTargetCount === totalTargetCount ? 'completed' : 'in_progress',
    completedTargetCount,
    totalTargetCount,
    duplicate,
  }
}

export async function recordElearningOfflineAttendance(
  db: ElearningOfflineDb,
  input: RecordElearningOfflineAttendanceInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ElearningOfflineAttendanceResult> {
  const command = normalizeRecordElearningOfflineAttendance(input.command)
  qrSecret(env)
  const tokenDigest = digestElearningOfflineQrToken(command.token)
  const requestHash = hashElearningOfflineRequest('attendance', { tokenDigest })
  return db.transaction(async (tx) => {
    await lockRequest(tx, 'elearning-offline-attendance', `${input.orgId}:${input.userId}:${command.requestId}`)
    await requireActiveOrgUser(tx, input.orgId, input.userId)
    const replay = await tx.query(
      `SELECT request_hash, request_hash_version, event_id::text
       FROM elearning_offline_attendance_requests
       WHERE org_id = $1 AND user_id = $2 AND request_id = $3::uuid`,
      [input.orgId, input.userId, command.requestId],
    )
    if (replay.rows.length > 0) {
      const row = replay.rows[0]!
      if (value(row, 'request_hash') !== requestHash
        || integer(row, 'request_hash_version') !== ELEARNING_OFFLINE_REQUEST_HASH_VERSION) fail('conflict')
      return loadAttendanceResult(tx, input.orgId, input.userId, value(row, 'event_id'), true)
    }
    const now = await databaseNow(tx)
    const challenge = await tx.query(
      `SELECT challenge.id::text AS challenge_id, challenge.training_id::text,
              challenge.revision_id::text,
              challenge.target_id::text, challenge.action
       FROM elearning_offline_qr_challenges challenge
       JOIN elearning_offline_trainings training
         ON training.org_id = challenge.org_id AND training.id = challenge.training_id
        AND training.active_revision_id = challenge.revision_id
       WHERE challenge.org_id = $1 AND challenge.token_digest = $2
         AND challenge.superseded_at IS NULL
         AND challenge.issued_at <= $3::timestamptz AND challenge.expires_at > $3::timestamptz
         AND training.status = 'active'
       FOR SHARE OF challenge, training`,
      [input.orgId, tokenDigest, now],
    )
    if (challenge.rows.length !== 1) fail('invalid_token')
    const challengeRow = challenge.rows[0]!
    const revisionId = value(challengeRow, 'revision_id')
    const targetId = value(challengeRow, 'target_id')
    const challengeAction = attendanceAction(challengeRow)
    const membership = await tx.query(
      `SELECT target.check_in_opens_at, target.check_in_closes_at,
              target.check_out_opens_at, target.check_out_closes_at
       FROM elearning_offline_training_members member
       JOIN elearning_offline_training_targets target
         ON target.org_id = member.org_id AND target.training_id = member.training_id
        AND target.revision_id = member.revision_id
       WHERE member.org_id = $1 AND member.revision_id = $2::uuid
         AND member.user_id = $3 AND target.id = $4::uuid
       FOR SHARE OF member, target`,
      [input.orgId, revisionId, input.userId, targetId],
    )
    if (membership.rows.length !== 1) fail('forbidden')
    const target = membership.rows[0]!
    const opensAt = instant(target, challengeAction === 'check_in' ? 'check_in_opens_at' : 'check_out_opens_at')
    const closesAt = instant(target, challengeAction === 'check_in' ? 'check_in_closes_at' : 'check_out_closes_at')
    if (Date.parse(now) < Date.parse(opensAt)) fail('window_not_open')
    if (Date.parse(now) >= Date.parse(closesAt)) fail('window_closed')
    if (challengeAction === 'check_out') {
      const checkedIn = await tx.query(
        `SELECT 1 AS ok FROM elearning_offline_attendance_events
         WHERE org_id = $1 AND revision_id = $2::uuid AND target_id = $3::uuid
           AND user_id = $4 AND action = 'check_in'
         FOR SHARE`,
        [input.orgId, revisionId, targetId, input.userId],
      )
      if (checkedIn.rows.length !== 1) fail('check_in_required')
    }
    const eventId = randomUUID()
    const inserted = await tx.query(
      `INSERT INTO elearning_offline_attendance_events
         (id, org_id, training_id, revision_id, target_id, user_id, action,
          challenge_id, occurred_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8::uuid, $9::timestamptz)
       ON CONFLICT (org_id, revision_id, target_id, user_id, action) DO NOTHING
       RETURNING id::text AS event_id`,
      [eventId, input.orgId, value(challengeRow, 'training_id'), revisionId, targetId,
        input.userId, challengeAction, value(challengeRow, 'challenge_id'), now],
    )
    const effectiveEventId = inserted.rows.length === 1
      ? value(inserted.rows[0]!, 'event_id')
      : value((await tx.query(
        `SELECT id::text AS event_id FROM elearning_offline_attendance_events
         WHERE org_id = $1 AND revision_id = $2::uuid AND target_id = $3::uuid
           AND user_id = $4 AND action = $5`,
        [input.orgId, revisionId, targetId, input.userId, challengeAction],
      )).rows[0] ?? {}, 'event_id')
    await tx.query(
      `INSERT INTO elearning_offline_attendance_requests
         (org_id, user_id, request_id, request_hash, request_hash_version, event_id)
       VALUES ($1, $2, $3::uuid, $4, $5, $6::uuid)`,
      [input.orgId, input.userId, command.requestId, requestHash,
        ELEARNING_OFFLINE_REQUEST_HASH_VERSION, effectiveEventId],
    )
    return loadAttendanceResult(
      tx,
      input.orgId,
      input.userId,
      effectiveEventId,
      inserted.rows.length === 0,
    )
  })
}

async function loadMyElearningOfflineTrainings(
  db: ElearningOfflineQueryable,
  input: { orgId: string; userId: string },
): Promise<ElearningOfflineLearnerTraining[]> {
  const rows = await db.query(
    `SELECT training.id::text AS training_id, revision.id::text AS revision_id,
            revision.title AS training_title, revision.location, revision.attendance_mode,
            training.status, target.id::text AS target_id, target.position,
            target.title, target.starts_at, target.ends_at,
            target.check_in_opens_at, target.check_in_closes_at,
            target.check_out_opens_at, target.check_out_closes_at,
            checkin.occurred_at AS checked_in_at, checkout.occurred_at AS checked_out_at
     FROM elearning_offline_training_members member
     JOIN elearning_offline_trainings training
       ON training.org_id = member.org_id AND training.id = member.training_id
      AND training.active_revision_id = member.revision_id
     JOIN elearning_offline_training_revisions revision
       ON revision.org_id = member.org_id AND revision.id = member.revision_id
     JOIN elearning_offline_training_targets target
       ON target.org_id = member.org_id AND target.revision_id = member.revision_id
     LEFT JOIN elearning_offline_attendance_events checkin
       ON checkin.org_id = member.org_id AND checkin.revision_id = member.revision_id
      AND checkin.target_id = target.id AND checkin.user_id = member.user_id
      AND checkin.action = 'check_in'
     LEFT JOIN elearning_offline_attendance_events checkout
       ON checkout.org_id = member.org_id AND checkout.revision_id = member.revision_id
      AND checkout.target_id = target.id AND checkout.user_id = member.user_id
      AND checkout.action = 'check_out'
     WHERE member.org_id = $1 AND member.user_id = $2 AND training.status <> 'withdrawn'
     ORDER BY revision.created_at DESC, training.id, target.position ASC`,
    [input.orgId, input.userId],
  )
  const grouped = new Map<string, ElearningOfflineLearnerTraining>()
  for (const row of rows.rows) {
    const trainingId = value(row, 'training_id')
    const status = value(row, 'status')
    if (status !== 'active' && status !== 'archived') fail('unavailable')
    let training = grouped.get(trainingId)
    if (!training) {
      training = {
        trainingId,
        revisionId: value(row, 'revision_id'),
        title: value(row, 'training_title'),
        location: value(row, 'location'),
        attendanceMode: mode(row),
        status,
        targets: [],
        completionStatus: 'in_progress',
      }
      grouped.set(trainingId, training)
    }
    const checkedInAt = nullableInstant(row, 'checked_in_at')
    const checkedOutAt = nullableInstant(row, 'checked_out_at')
    training.targets.push({
      ...targetResult(row),
      attendanceStatus: checkedOutAt ? 'checked_out' : checkedInAt ? 'checked_in' : 'not_checked_in',
      checkedInAt,
      checkedOutAt,
    })
  }
  for (const training of grouped.values()) {
    training.completionStatus = training.targets.every((target) => target.checkedOutAt !== null)
      ? 'completed'
      : 'in_progress'
  }
  return [...grouped.values()]
}

export async function listMyElearningOfflineTrainings(
  db: ElearningOfflineDb,
  input: { orgId: string; userId: string },
): Promise<ElearningOfflineLearnerTraining[]> {
  return db.transaction(async (tx) => {
    await requireActiveOrgUser(tx, input.orgId, input.userId)
    return loadMyElearningOfflineTrainings(tx, input)
  })
}
