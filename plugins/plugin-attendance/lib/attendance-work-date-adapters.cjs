'use strict'

/**
 * Thin channel adapters over AttendanceWorkDateResolver (W2 / #4556).
 * Each adapter only shapes channel-specific input/output; all selection logic
 * lives in the shared resolver.
 */

const {
  OVERTIME_ATTRIBUTION_KEY,
  FROZEN_ATTRIBUTION_KEY,
  REASON,
  parseOvertimeAttributionV1,
  buildOvertimeAttributionV1,
  anchorsEqual,
  parseFrozenWorkDateAttribution,
  buildFrozenWorkDateAttribution,
} = require('./attendance-work-date-resolver.cjs')

const OVERTIME_ATTRIBUTION_SNAPSHOT_REQUIRED = 'OVERTIME_ATTRIBUTION_SNAPSHOT_REQUIRED'

function assertResolver(resolver) {
  if (!resolver || typeof resolver.resolve !== 'function') {
    throw new Error('adapter requires AttendanceWorkDateResolver instance')
  }
}

function createLivePunchWorkDateAdapter(resolver) {
  assertResolver(resolver)
  return {
    channel: 'live',
    async resolvePunchWorkDate(input) {
      return resolver.resolve({
        ...input,
        channel: 'live',
      })
    },
  }
}

function createImportWorkDateAdapter(resolver) {
  assertResolver(resolver)
  return {
    channel: 'import',
    async resolveImportWorkDate(input) {
      return resolver.resolve({
        ...input,
        channel: 'import',
        // Import may supply an authorized explicit work date; shift still required for resolved.
        explicitWorkDate: input.explicitWorkDate || input.workDate || null,
        explicitShiftId: input.explicitShiftId || input.shiftId || null,
        explicitWorkDateOnly: input.explicitWorkDateOnly === true,
      })
    },
  }
}

function createCorrectionWorkDateAdapter(resolver) {
  assertResolver(resolver)
  return {
    channel: 'correction',
    async resolveCorrectionWorkDate(input) {
      const frozen = input.frozenAttribution
        ?? input.recordMeta?.[FROZEN_ATTRIBUTION_KEY]
        ?? input.recordMeta?.workDateAttributionV1
        ?? null
      return resolver.resolve({
        ...input,
        channel: 'correction',
        frozenAttribution: frozen,
      })
    },
  }
}

function createOvertimeWorkDateAdapter(resolver) {
  assertResolver(resolver)
  return {
    channel: 'overtime',
    /**
     * Freeze overtimeAttributionV1 from exactly one org-scoped published candidate.
     * No row-order / default-rule inference.
     */
    async freezeRequestCreationAnchor(input) {
      const result = await resolver.resolve({
        ...input,
        channel: 'overtime',
        mode: 'freeze_request_anchor',
        explicitWorkDate: input.workDate,
      })
      if (result.kind !== 'resolved') {
        return { ok: false, result, anchor: null }
      }
      const source = result.evidenceSnapshot?.source
      const assignmentId = result.evidenceSnapshot?.assignmentId
      if ((source !== 'shift' && source !== 'rotation') || !assignmentId) {
        return {
          ok: false,
          result: {
            kind: 'unresolved',
            reasonCode: REASON.NO_PUBLISHED_CANDIDATE,
            evidenceSnapshot: { reason: 'resolved candidate missing source/assignmentId' },
          },
          anchor: null,
        }
      }
      const anchor = buildOvertimeAttributionV1({
        orgId: input.orgId,
        userId: input.userId,
        workDate: result.workDate,
        shiftId: result.shiftId,
        source,
        assignmentId,
      })
      return { ok: true, result, anchor }
    },

    /**
     * Pending update: preserve existing anchor. Legacy pending without anchor fails closed
     * before side effects with OVERTIME_ATTRIBUTION_SNAPSHOT_REQUIRED.
     */
    preserveOrRequirePendingAnchor(existingMetadata) {
      const existing = parseOvertimeAttributionV1(
        existingMetadata?.[OVERTIME_ATTRIBUTION_KEY]
        ?? existingMetadata?.overtimeAttributionV1,
      )
      if (existing) {
        return { ok: true, anchor: existing, preserved: true }
      }
      return {
        ok: false,
        anchor: null,
        preserved: false,
        code: OVERTIME_ATTRIBUTION_SNAPSHOT_REQUIRED,
        error: {
          code: OVERTIME_ATTRIBUTION_SNAPSHOT_REQUIRED,
          message:
            'Legacy overtime request is missing overtimeAttributionV1; refuse mutation before side effects',
        },
      }
    },

    /**
     * Approved OT may extend only the same org/user/workDate/shift named by the frozen anchor.
     * Legacy approved without anchor never extends/backfills.
     */
    canExtendAttributionWindow({ request, candidate, anchor }) {
      const frozen = parseOvertimeAttributionV1(anchor)
        || parseOvertimeAttributionV1(request?.metadata?.[OVERTIME_ATTRIBUTION_KEY])
        || parseOvertimeAttributionV1(request?.metadata?.overtimeAttributionV1)
      if (!frozen) {
        return { ok: false, reason: 'LEGACY_APPROVED_NO_ANCHOR' }
      }
      if (!candidate) {
        return { ok: false, reason: 'NO_CANDIDATE' }
      }
      if (!candidate.orgId || String(frozen.orgId) !== String(candidate.orgId)) {
        return { ok: false, reason: 'ORG_MISMATCH' }
      }
      if (!candidate.userId || String(frozen.userId) !== String(candidate.userId)) {
        return { ok: false, reason: 'USER_MISMATCH' }
      }
      if (!candidate.workDate || String(frozen.workDate) !== String(candidate.workDate)) {
        return { ok: false, reason: 'WORK_DATE_MISMATCH' }
      }
      if (!candidate.shiftId || String(frozen.shiftId) !== String(candidate.shiftId)) {
        return { ok: false, reason: 'SHIFT_MISMATCH' }
      }
      // Compare/copy frozen anchor — identity must match.
      if (request?.metadata) {
        const requestAnchor = parseOvertimeAttributionV1(
          request.metadata[OVERTIME_ATTRIBUTION_KEY] ?? request.metadata.overtimeAttributionV1,
        )
        if (requestAnchor && !anchorsEqual(requestAnchor, frozen)) {
          return { ok: false, reason: 'ANCHOR_MISMATCH' }
        }
      }
      return { ok: true, anchor: frozen }
    },

    attachAnchorToMetadata(metadata, anchor) {
      const next = metadata && typeof metadata === 'object' ? { ...metadata } : {}
      next[OVERTIME_ATTRIBUTION_KEY] = buildOvertimeAttributionV1(anchor)
      return next
    },
  }
}

function createRecomputeWorkDateAdapter(resolver) {
  assertResolver(resolver)
  return {
    channel: 'recompute',
    async resolveRecomputeWorkDate(input) {
      const frozen = input.frozenAttribution
        ?? input.recordMeta?.[FROZEN_ATTRIBUTION_KEY]
        ?? input.recordMeta?.workDateAttributionV1
        ?? null
      return resolver.resolve({
        ...input,
        channel: 'recompute',
        frozenAttribution: frozen,
      })
    },
  }
}

function createScheduledWorkDateAdapter(resolver) {
  assertResolver(resolver)
  return {
    channel: 'scheduled',
    async resolveScheduledWorkDate(input) {
      return resolver.resolve({
        ...input,
        channel: 'scheduled',
      })
    },
  }
}

function createAllWorkDateAdapters(resolver) {
  assertResolver(resolver)
  return {
    live: createLivePunchWorkDateAdapter(resolver),
    import: createImportWorkDateAdapter(resolver),
    correction: createCorrectionWorkDateAdapter(resolver),
    overtime: createOvertimeWorkDateAdapter(resolver),
    recompute: createRecomputeWorkDateAdapter(resolver),
    scheduled: createScheduledWorkDateAdapter(resolver),
  }
}

module.exports = {
  OVERTIME_ATTRIBUTION_SNAPSHOT_REQUIRED,
  OVERTIME_ATTRIBUTION_KEY,
  FROZEN_ATTRIBUTION_KEY,
  createLivePunchWorkDateAdapter,
  createImportWorkDateAdapter,
  createCorrectionWorkDateAdapter,
  createOvertimeWorkDateAdapter,
  createRecomputeWorkDateAdapter,
  createScheduledWorkDateAdapter,
  createAllWorkDateAdapters,
  buildFrozenWorkDateAttribution,
  parseFrozenWorkDateAttribution,
  parseOvertimeAttributionV1,
  buildOvertimeAttributionV1,
  anchorsEqual,
}
