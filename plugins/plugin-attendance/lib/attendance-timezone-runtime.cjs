'use strict'

const { createHash } = require('node:crypto')

const { createAttendanceTimezonePolicyStore, AttendanceTimezonePolicyError } = require('./attendance-timezone-policy-store.cjs')
const { createAttendanceTimezoneContextLoader } = require('./attendance-timezone-context-loader.cjs')
const { buildCalendarTimezoneDay, calendarCandidateKey } = require('./attendance-timezone-calendar-day.cjs')
const { candidateSegmentSelectionKeyV1, createCanonicalSegmentWindowEvidenceV1 } = require('./attendance-segment-window-selection.cjs')

function createAttendanceTimezoneRuntime({
  HttpError, loadPublishedCandidates, mayResolveSegmentSelectionPosture, resolveSegmentSelectionPosture, resolveLocalWallTime, validateIanaTimezone,
  addDaysToDateKey, normalizeTimeString, readApprovedTrips, mapRuleRow, mapHolidayRow, resolveRuleContext: resolveBaseRuleContext, authorizeRequestTarget, prepareRuleContextBatch, loadShiftById, toWorkDate, resolveOvernightFlag,
  loadAttributionTail, loadApprovedOvertime, resolveScheduledCandidate, acquireRuntimeLocks, serverNow, lockOrgPolicy, prepareTripSourceChange, loadCalendarOverrides, selectCalendarCandidates, readCalculationDefinition, validateFrozenContext, validateFrozenAttribution,
}) {
  function fail(code, status = 422) { throw new HttpError(status, code, code) }
  // Only proven ambiguity from this runtime may become a scheduled review target.
  // Keep public errors unchanged; the context-conflict code also covers zero contexts.
  const attributionAmbiguityErrors = new WeakSet()
  function failAttributionAmbiguity(code) {
    const error = new HttpError(409,code,code)
    attributionAmbiguityErrors.add(error)
    throw error
  }
  function queryFor(trx) {
    return async (text, values) => ({ rows: await trx.query(text, values) })
  }
  // Only a request-only wrapper receives this exact subject authorization.
  // Public reads on the original transaction retain their active-member gate.
  const requestReadScopes = new WeakMap()
  function requestReadScope(trx,orgId,userId) {
    const scope = requestReadScopes.get(trx)
    if (!scope) return null
    if (scope.orgId !== orgId || scope.userId !== userId) fail('ATTENDANCE_TIMEZONE_MEMBER_REQUIRED',403)
    return scope
  }
  function resolveRuleContext(input) {
    const scope = requestReadScope(input.db,input.orgId,input.userId)
    return resolveBaseRuleContext({...input,...(scope ? {scopeContext:scope.scopeContext} : {})})
  }
  async function readRequestTimezoneContext(trx,input) {
    if (typeof authorizeRequestTarget !== 'function') fail('ATTENDANCE_TIMEZONE_RUNTIME_UNAVAILABLE',503)
    const {orgId,userId,workDate} = input
    // The adapter has already established the original request authority.
    // Capture calendar scope facts only after the same source-lock prefix.
    await acquireRuntimeLocks(trx,{orgId,userId,mode:'shared'})
    const scopeContext = await authorizeRequestTarget(trx,{orgId,userId})
    if (!scopeContext || scopeContext.userId !== userId) fail('ATTENDANCE_TIMEZONE_MEMBER_REQUIRED',403)
    const scopedTrx = {...trx,query:(text,values) => trx.query(text,values)}
    requestReadScopes.set(scopedTrx,{orgId,userId,scopeContext})
    try {
      const target = await readTargetTimezoneContext(scopedTrx,{orgId,userId,workDate})
      requestTargetFacts.set(trx,requestTargetFacts.get(scopedTrx))
      return target
    } finally {
      requestReadScopes.delete(scopedTrx)
      requestTargetFacts.delete(scopedTrx)
    }
  }
  function loaderFor(trx, { excludeTripRequestId, policyProjection } = {}) {
    const query = queryFor(trx)
    const policyStore = createAttendanceTimezonePolicyStore({
      query, transaction: work => work(query), authorizeManage: async () => false,
      ...(requestReadScopes.has(trx) ? {
        authorizeReadSubject:({orgId,userId}) => requestReadScope(trx,orgId,userId) !== null,
      } : {}),
    })
    let sourceStore = policyStore
    if (policyProjection !== undefined) {
      const projected = policyProjection
      if (!projected || typeof projected.enabled !== 'boolean' || !projected.orgId
        || !Number.isSafeInteger(projected.expectedVersion) || projected.expectedVersion<0) {
        fail('ATTENDANCE_TIMEZONE_PROJECTION_INVALID')
      }
      sourceStore = {...policyStore,readPolicy:async ({orgId}) => {
        if (orgId !== projected.orgId) fail('ATTENDANCE_TIMEZONE_INVALID_REFERENCE')
        const actual = await policyStore.readPolicy({orgId})
        if (actual.version !== projected.expectedVersion) fail('ATTENDANCE_TIMEZONE_CONFIG_CHANGED',409)
        if (!Number.isSafeInteger(actual.version+1)) fail('ATTENDANCE_TIMEZONE_INVALID_REVISION')
        // Counterfactual only: no persisted row/revision is created by this reader.
        return {enabled:projected.enabled,version:actual.version+1}
      }}
    }
    return createAttendanceTimezoneContextLoader({
      query, policyStore:sourceStore,
      readApprovedTrips: readApprovedTrips && (async args => {
        const trips = await readApprovedTrips(args)
        return excludeTripRequestId === undefined ? trips
          : trips.filter(trip => trip.referenceId !== excludeTripRequestId)
      }),
    })
  }
  function boundaryDates(from, to) {
    const dates = new Set()
    // A boundary lookup, not a period calendar: UTC +/- dateline, one overnight
    // day and the existing bounded tail. Never scan every day of a long trip.
    for (const instant of [from, to]) {
      const date = instant.toISOString().slice(0, 10)
      for (let offset = -3; offset <= 1; offset += 1) dates.add(addDaysToDateKey(date, offset))
    }
    return [...dates].sort()
  }
  function uniqueWallInstant(workDate, time, timezone) {
    const normalized = normalizeTimeString(time)
    if (!normalized) fail('ATTENDANCE_TIMEZONE_WALL_INVALID')
    const result = resolveLocalWallTime(workDate, normalized, 0, timezone)
    if (result.posture === 'fold') fail('ATTENDANCE_TIMEZONE_WALL_AMBIGUOUS')
    if (result.posture !== 'unique') fail('ATTENDANCE_TIMEZONE_WALL_INVALID')
    return new Date(result.epochMs)
  }
  async function readPublishedTimezoneWindows(trx, input, batch) {
    const { orgId, userId, from, to, timezone, excludeTripRequestId, fullPeriod = false, targetWorkDates, includeRestDay = false, policyProjection } = input || {}
    if (!orgId || !userId || !(from instanceof Date) || !(to instanceof Date)
      || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) {
      fail('ATTENDANCE_TIMEZONE_WINDOW_INPUT_INVALID')
    }
    try {
      let explicitZone = null
      if (timezone !== undefined) {
        try { explicitZone = validateIanaTimezone(timezone) }
        catch (_) { fail('ATTENDANCE_TIMEZONE_INVALID_ZONE') }
      }
      const load = loaderFor(trx, { excludeTripRequestId,policyProjection })
      const contexts = new Map()
      const calendarOverrides = batch?.calendarOverrides ?? await loadCalendarOverrides(trx)
      let workDates = boundaryDates(from, to)
      if (targetWorkDates !== undefined) {
        if (!Array.isArray(targetWorkDates) || targetWorkDates.some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
          fail('ATTENDANCE_TIMEZONE_WINDOW_INPUT_INVALID')
        }
        workDates = [...new Set(targetWorkDates)].sort()
      } else if (fullPeriod === true) {
        const zone = explicitZone ?? (await load({
          orgId,userId,occurredAt:from,workDate:from.toISOString().slice(0,10),
        })).timezone
        const representativeDates = await require('./attendance-trip-context-transition-dates.cjs')
          .readTripContextTransitionDates(trx,{orgId,userId,from,to,timezone:zone})
        const dates = new Set(representativeDates)
        // Exact ICU wall checks on every possibly relevant target workDate.
        // Structural weekly/rotation representatives alone cannot prove DST.
        const first = addDaysToDateKey(from.toISOString().slice(0,10),-2)
        const last = addDaysToDateKey(to.toISOString().slice(0,10),2)
        for (let date = first; date <= last; date = addDaysToDateKey(date,1)) dates.add(date)
        workDates = [...dates].sort()
      }
      const candidates = batch ? batch.candidates.filter(candidate=>workDates.includes(candidate.workDate))
        : await loadPublishedCandidates(trx, {orgId,userId,workDates,strictSources:true})
      const defaultRows = await trx.query(
        'SELECT * FROM attendance_rules WHERE org_id = $1 AND is_default = true',
        [orgId],
      )
      // The strict loader validates the same unique default and governed revision.
      if (defaultRows.length !== 1) fail('ATTENDANCE_TIMEZONE_INVALID_DEFAULT')
      for (const workDate of workDates) {
        if (candidates.some(candidate => candidate.workDate === workDate)) continue
        const timezoneContext = await load({ orgId, userId, occurredAt: from, workDate })
        contexts.set(workDate, timezoneContext)
        const context = await (batch?.resolveRuleContext ?? resolveRuleContext)({
          db: trx, orgId, userId, workDate, defaultRule: mapRuleRow(defaultRows[0]),
          timezoneContext, calendarOverrides, strictSources:true,
          ...(batch ? {publishedSourcesAbsent:true,holidayPrefetched:true,holidayOverride:batch.holidays.get(workDate) ?? null} : {}),
        })
        if (context.isWorkingDay !== true && includeRestDay !== true) continue
        candidates.push({
          orgId, userId, workDate, shiftId: null, assignmentId: null, source: 'rule',
          workStartTime: context.rule.workStartTime, workEndTime: context.rule.workEndTime,
          isOvernight: context.rule.isOvernight === true, rule: context.rule,
          isWorkingDay:context.isWorkingDay,holidayKind:context.holiday?.kind ?? null,sourceContext:context,
        })
      }
      const windows = []
      for (const candidate of candidates) {
        if (candidate.orgId !== orgId || candidate.userId !== userId) {
          fail('ATTENDANCE_TIMEZONE_INVALID_REFERENCE')
        }
        if (!contexts.has(candidate.workDate)) {
          contexts.set(candidate.workDate, await load({ orgId, userId, occurredAt: from, workDate: candidate.workDate }))
        }
        let zone = explicitZone
        if (zone === null) {
          if (!contexts.has(candidate.workDate)) {
            contexts.set(candidate.workDate, await load({
              orgId, userId, occurredAt: new Date(from.getTime()), workDate: candidate.workDate,
            }))
          }
          zone = contexts.get(candidate.workDate).timezone
        }
        const profile = candidate.rule ?? await loadShiftById(trx, orgId, candidate.shiftId)
        if (!profile) fail('ATTENDANCE_TIMEZONE_INVALID_REFERENCE')
        const rule = { ...profile, timezone: zone }
        const sourceContext = candidate.sourceContext ?? await (batch?.resolveRuleContext ?? resolveRuleContext)({
          db:trx,orgId,userId,workDate:candidate.workDate,defaultRule:mapRuleRow(defaultRows[0]),
          timezoneContext:{...contexts.get(candidate.workDate),timezone:zone},calendarOverrides,strictSources:true,
          publishedProfile:{rule,source:candidate.source,assignmentId:candidate.assignmentId,rotationRuleId:candidate.rotationRuleId},
          ...(batch ? {holidayPrefetched:true,holidayOverride:batch.holidays.get(candidate.workDate) ?? null} : {}),
        })
        const calculationDefinition = candidate.shiftId === null ? {
          kind:'rule',isWorkday:sourceContext.isWorkingDay === true,holidayKind:sourceContext.holiday?.kind ?? null,
          rule:canonicalRuleProfile(rule),
        } : await readCalculationDefinition(trx,{
          orgId,userId,workDate:candidate.workDate,shiftId:candidate.shiftId,timezone:zone,
          isWorkday:sourceContext.isWorkingDay === true,holidayKind:sourceContext.holiday?.isWorkingDay === false ? 'holiday' : null,defaultRule:mapRuleRow(defaultRows[0]),
        })
        const relevantDates = new Set([from, to].flatMap(instant => {
          const localDate = toWorkDate(instant, zone)
          return [localDate, addDaysToDateKey(localDate, -1)]
        }))
        if (targetWorkDates === undefined && fullPeriod !== true && !relevantDates.has(candidate.workDate)) continue
        const endDate = candidate.isOvernight
          ? addDaysToDateKey(candidate.workDate, 1) : candidate.workDate
        const startTime = normalizeTimeString(candidate.workStartTime)
        const endTime = normalizeTimeString(candidate.workEndTime)
        if (!startTime || !endTime) fail('ATTENDANCE_TIMEZONE_WALL_INVALID')
        const endResult = resolveLocalWallTime(endDate,endTime,0,zone)
        const startResult = resolveLocalWallTime(candidate.workDate,startTime,0,zone)
        if (fullPeriod === true && targetWorkDates === undefined) {
          if (endResult.posture === 'unique' && endResult.epochMs <= from.getTime()) continue
          if (endResult.posture === 'fold' && endResult.later.epochMs <= from.getTime()) continue
          if (startResult.posture === 'unique' && startResult.epochMs >= to.getTime()) continue
          if (startResult.posture === 'fold' && startResult.earlier.epochMs >= to.getTime()) continue
        } else if (targetWorkDates === undefined && !candidate.isOvernight
          && candidate.workDate < toWorkDate(from,zone)) {
          continue
        }
        const startAt = uniqueWallInstant(candidate.workDate,startTime,zone)
        const endAt = uniqueWallInstant(endDate,endTime,zone)
        if (endAt <= startAt) fail('ATTENDANCE_TIMEZONE_WINDOW_INVALID')
        // Include boundary-crossing and adjacent windows; do not require start>=from.
        windows.push({
          workDate: candidate.workDate, shiftId: candidate.shiftId,
          assignmentId: candidate.assignmentId, source: candidate.source,
          startAt, endAt, timezone: zone, isWorkingDay:sourceContext.isWorkingDay === true,
          timezoneContext: explicitZone === null ? canonicalTimezoneProvenance(contexts.get(candidate.workDate)) : null,
          rule, calculationDefinition, sourceContext,
          projectionBasis: explicitZone === null ? null : {
            policyVersion: contexts.get(candidate.workDate).policyVersion,
            calculationGroupMembership: contexts.get(candidate.workDate).calculationGroupMembership,
            rule: canonicalRuleProfile(rule), calculationDefinition,
          },
          contextFingerprint: explicitZone === null ? canonicalContextFingerprint({
            workDate: candidate.workDate, shiftId: candidate.shiftId ?? null,
            assignmentId: candidate.assignmentId ?? null, source: candidate.source,
            startAt: startAt.toISOString(), endAt: endAt.toISOString(), timezone: zone,
            timezoneContext: canonicalTimezoneProvenance(contexts.get(candidate.workDate)),
            rule: canonicalRuleProfile(rule), calculationDefinition,
          }) : null,
        })
      }
      return windows
    } catch (error) {
      if (error instanceof HttpError) throw error
      if (error instanceof AttendanceTimezonePolicyError) fail(error.code, error.status)
      if (error?.code === 'ATTENDANCE_TRIP_TRANSITION_SOURCE_UNAVAILABLE') fail(error.code,503)
      fail('ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE', 503)
    }
  }
  const frames = new WeakMap()
  const { createAttendanceTimezoneCompanionStore, admitsPreCompanionLegacyTarget } = require('./attendance-timezone-companion-store.cjs')
  const companion = createAttendanceTimezoneCompanionStore({ HttpError,validateFrozenContext,validateFrozenAttribution })
  async function assertLegacyRepairPosture(trx, frame) {
    if (frame?.identity?.source !== 'legacy_repair') return
    // An unresolved historical rule is not an issued segment-calculation context.
    // Check persisted posture even when the environment currently masks it.
    const rows = await trx.query('SELECT state,scope FROM attendance_calculation_rollout_state WHERE org_id=$1',[frame.orgId])
    if (rows.length > 1 || (rows.length === 1
      && (rows[0].state !== 'legacy' || rows[0].scope !== 'synthetic_staging'))) {
      fail('ATTENDANCE_TIMEZONE_REPAIR_POSTURE_UNSUPPORTED',409)
    }
  }
  async function readLegacyRepairRequestTarget(trx, input) {
    const existing = await companion.readForWorkDate(trx,input)
    if (existing?.frame.identity.source !== 'legacy_repair') return null
    return readTargetTimezoneContext(trx,input)
  }
  async function prepareLivePunch(trx, input) {
    const occurredAt = new Date(input.occurredAtResolved ?? input.occurredAt)
    const { orgId, userId, eventType } = input
    await acquireRuntimeLocks(trx, { orgId, userId, mode: input.runtimeLockMode ?? 'shared' })
    try {
      const repaired = await companion.readEligibleLegacyRepair(trx,{orgId,userId,occurredAt,eventType})
      if (eventType === 'check_out') {
        const existing = await companion.readEligibleOpen(trx,{orgId,userId,occurredAt})
        const legacy = await companion.readLegacyFrozenV2(trx,{orgId,userId,occurredAt})
        if ((existing && legacy) || (repaired && legacy)
          || (repaired && existing && repaired.fingerprint !== existing.fingerprint)) fail('ATTENDANCE_TIMEZONE_OPEN_CONTEXT_AMBIGUOUS',409)
        const frozen = existing ?? legacy?.frame ?? repaired
        if (frozen) {
          await assertLegacyRepairPosture(trx,frozen)
          assertClientTimezone(input.clientTimezone,frozen.timezone)
          frames.set(trx,frozen)
          return frozen
        }
      }
      if (repaired) {
        await assertLegacyRepairPosture(trx,repaired)
        assertClientTimezone(input.clientTimezone,repaired.timezone)
        frames.set(trx,repaired)
        return repaired
      }
      const load = loaderFor(trx)
      const contexts = new Map()
      const dates = boundaryDates(occurredAt, occurredAt)
      async function contextAt(workDate) {
        if (!contexts.has(workDate)) contexts.set(workDate, await load({ orgId, userId, occurredAt, workDate }))
        return contexts.get(workDate)
      }
      const natural = []
      for (const workDate of dates) {
        const context = await contextAt(workDate)
        if (toWorkDate(occurredAt, context.timezone) === workDate) natural.push({ workDate, context })
      }
      if (natural.length !== 1) fail('ATTENDANCE_TIMEZONE_WORK_DATE_AMBIGUOUS', 409)
      const defaultRows = await trx.query(
        'SELECT * FROM attendance_rules WHERE org_id=$1 AND is_default=true', [orgId],
      )
      if (defaultRows.length !== 1) fail('ATTENDANCE_TIMEZONE_INVALID_DEFAULT')
      const defaultRule = mapRuleRow(defaultRows[0])
      const candidates = await loadPublishedCandidates(trx, { orgId, userId, workDates: dates,
        lockScheduleFacts: true, strictSources: true })
      for (const candidate of candidates) {
        if (candidate.orgId !== orgId || candidate.userId !== userId) fail('ATTENDANCE_TIMEZONE_INVALID_REFERENCE')
        candidate.timezone = (await contextAt(candidate.workDate)).timezone
      }
      const relevantCandidates = candidates.filter(candidate => {
        const localDate = toWorkDate(occurredAt, candidate.timezone)
        return candidate.workDate === localDate || candidate.workDate === addDaysToDateKey(localDate, -1)
      })
      candidates.splice(0, candidates.length, ...relevantCandidates)
      const tail = await loadAttributionTail(trx)
      const overtime = await loadApprovedOvertime(trx, { orgId, userId, workDates: dates })
      const { createAttendanceWorkDateResolver, buildAbsoluteWindow, buildAttributionWindow } =
        require('./attendance-work-date-resolver.cjs')
      const built = candidates.map(candidate => {
        const absoluteWindow = buildAbsoluteWindow({
          ...candidate, workStartTime: normalizeTimeString(candidate.workStartTime),
          workEndTime: normalizeTimeString(candidate.workEndTime),
          buildZonedDate: uniqueWallInstant, addDaysToDateKey,
        })
        const attributionWindow = buildAttributionWindow(absoluteWindow, {
          attributionTailMinutes: tail, approvedOvertimeWindows: overtime, orgId, userId,
          workDate: candidate.workDate, shiftId: candidate.shiftId,
        })
        return { ...candidate, absoluteWindow, attributionWindow }
      })
      // The query-free negative hint preserves the default OFF path. A true
      // hint NEVER grants references: the original same-transaction posture does.
      const selectionCandidates = built.filter(candidate => candidate.workDate === natural[0].workDate)
      const selectionSources = new Map()
      let segmentEvidence = null
      let selectionCalendarOverrides
      if (selectionCandidates.length > 1 && typeof mayResolveSegmentSelectionPosture === 'function'
        && mayResolveSegmentSelectionPosture(orgId) === true) {
        if (typeof resolveSegmentSelectionPosture !== 'function') fail('ATTENDANCE_TIMEZONE_RUNTIME_UNAVAILABLE',503)
        const posture = await resolveSegmentSelectionPosture(trx,orgId)
        if (posture?.referenceSegments === true) {
          selectionCalendarOverrides = await loadCalendarOverrides(trx)
          const entries = []
          for (const candidate of selectionCandidates) {
            const candidateTimezone = await contextAt(candidate.workDate)
            const rule = {...await loadShiftById(trx,orgId,candidate.shiftId),timezone:candidate.timezone}
            if (!rule.workStartTime || !rule.workEndTime) fail('ATTENDANCE_TIMEZONE_INVALID_REFERENCE')
            const baseContext = await resolveRuleContext({db:trx,orgId,userId,workDate:candidate.workDate,
              defaultRule,timezoneContext:candidateTimezone,calendarOverrides:selectionCalendarOverrides,strictSources:true,
              publishedProfile:{rule,source:candidate.source,assignmentId:candidate.assignmentId,rotationRuleId:candidate.rotationRuleId},
            })
            const definition = await readCalculationDefinition(trx,{orgId,userId,workDate:candidate.workDate,
              shiftId:candidate.shiftId,timezone:candidate.timezone,isWorkday:baseContext.isWorkingDay,
              holidayKind:baseContext.holiday?.isWorkingDay === false ? 'holiday' : null,defaultRule,
            })
            const key = candidateSegmentSelectionKeyV1(candidate)
            if (!key || selectionSources.has(key)) fail('ATTENDANCE_TIMEZONE_CALCULATION_SOURCE_INVALID',503)
            entries.push({candidate,definition})
            selectionSources.set(key,{rule,baseContext,calculationDefinition:definition})
          }
          segmentEvidence = createCanonicalSegmentWindowEvidenceV1(entries,{
            resolveInstant:uniqueWallInstant,addDaysToDateKey,
          })
          if (!segmentEvidence) fail('ATTENDANCE_TIMEZONE_CALCULATION_SOURCE_INVALID',503)
        }
      }
      const containsActualSegment = segmentEvidence === null ? undefined : (candidate,instant) => {
        const contains = segmentEvidence.contains(candidate,instant)
        if (contains !== true && contains !== false) fail('ATTENDANCE_TIMEZONE_CALCULATION_SOURCE_INVALID',503)
        return contains
      }
      const resolver = createAttendanceWorkDateResolver({
        containsActualSegment,
        toWorkDate, buildZonedDate: uniqueWallInstant, addDaysToDateKey, normalizeTimeString,
        resolveOvernightFlag,
        loadPublishedCandidates: async () => candidates,
        loadOpenRecords: async () => [],
        loadApprovedOvertimeWindows: async () => overtime,
        getAttributionTailMinutes: async () => tail,
      })
      const resolution = await resolver.resolve({
        orgId, userId, occurredAt, timezone: natural[0].context.timezone,
        calendarWorkDate: natural[0].workDate, channel: 'live', includeFullWinner: true,
      })
      if (resolution.kind === 'ambiguous') fail('ATTENDANCE_TIMEZONE_WORK_DATE_AMBIGUOUS', 409)
      const workDate = resolution.kind === 'resolved' ? resolution.workDate : natural[0].workDate
      const uniqueSegmentWinner = containsActualSegment !== undefined && resolution.kind === 'resolved'
        && workDate === natural[0].workDate && resolution.fullWinner !== null
        && containsActualSegment(resolution.fullWinner,occurredAt) === true
        && selectionCandidates.filter(candidate => containsActualSegment(candidate,occurredAt)).length === 1
      if (built.filter(candidate => candidate.workDate === workDate).length > 1 && !uniqueSegmentWinner) {
        fail('ATTENDANCE_TIMEZONE_WORK_DATE_CONTEXT_CONFLICT', 409)
      }
      // A closed repair is reusable only after ordinary attribution selected its
      // date. Its old tail must never steal the next day's new check-in.
      const prior = await companion.readForWorkDate(trx,{orgId,userId,workDate})
      if (prior?.frame.identity.source === 'legacy_repair') {
        await assertLegacyRepairPosture(trx,prior.frame)
        assertClientTimezone(input.clientTimezone,prior.frame.timezone)
        frames.set(trx,prior.frame)
        return prior.frame
      }
      const timezoneContext = await contextAt(workDate)
      const timezone = timezoneContext.timezone
      assertClientTimezone(input.clientTimezone, timezone)
      const calendarOverrides = selectionCalendarOverrides ?? await loadCalendarOverrides(trx)
      const selected = resolution.kind === 'resolved'
        ? built.find(candidate => candidate.workDate === workDate && candidate.shiftId === resolution.shiftId
          && candidate.assignmentId === resolution.fullWinner?.assignmentId
          && (!uniqueSegmentWinner || candidate.source === resolution.fullWinner?.source)) : null
      if (resolution.kind === 'resolved' && !selected) fail('ATTENDANCE_TIMEZONE_INVALID_REFERENCE')
      const selectedSource = uniqueSegmentWinner ? selectionSources.get(candidateSegmentSelectionKeyV1(selected)) : null
      if (uniqueSegmentWinner && !selectedSource) fail('ATTENDANCE_TIMEZONE_CALCULATION_SOURCE_INVALID',503)
      const publishedRule = selectedSource?.rule ?? (resolution.kind === 'resolved'
        ? { ...await loadShiftById(trx, orgId, resolution.shiftId), timezone } : null)
      const baseContext = selectedSource?.baseContext ?? await resolveRuleContext({ db: trx, orgId, userId, workDate,
        defaultRule, timezoneContext, calendarOverrides, strictSources:true,
        ...(selected ? { publishedProfile: {
          rule:publishedRule,source:selected.source,assignmentId:selected.assignmentId,rotationRuleId:selected.rotationRuleId,
        } } : {}),
      })
      const rule = publishedRule ?? baseContext.rule
      if (!rule || !rule.workStartTime || !rule.workEndTime) fail('ATTENDANCE_TIMEZONE_INVALID_REFERENCE')
      const absoluteWindow = selected?.absoluteWindow ?? buildAbsoluteWindow({
        workDate, workStartTime: normalizeTimeString(rule.workStartTime),
        workEndTime: normalizeTimeString(rule.workEndTime), timezone,
        isOvernight: rule.isOvernight === true, buildZonedDate: uniqueWallInstant, addDaysToDateKey,
      })
      const attributionWindow = selected?.attributionWindow ?? buildAttributionWindow(absoluteWindow, {
        attributionTailMinutes: tail, approvedOvertimeWindows: overtime, orgId, userId,
        workDate, shiftId: resolution.kind === 'resolved' ? resolution.shiftId : null,
      })
      if (!absoluteWindow || !attributionWindow) fail('ATTENDANCE_TIMEZONE_WINDOW_INVALID')
      const calculationDefinition = selectedSource?.calculationDefinition ?? (resolution.kind !== 'resolved' ? {
        kind:'rule',isWorkday:baseContext.isWorkingDay === true,holidayKind:baseContext.holiday?.kind ?? null,
        rule:canonicalRuleProfile(rule),
      } : await readCalculationDefinition(trx,{
        orgId,userId,workDate,shiftId:resolution.shiftId,timezone,
        isWorkday:baseContext.isWorkingDay,holidayKind:baseContext.holiday?.isWorkingDay === false ? 'holiday' : null,
        defaultRule,
      }))
      const identity = {
        workDate, shiftId: resolution.kind === 'resolved' ? resolution.shiftId : null,
        assignmentId: selected?.assignmentId ?? null, source: selected?.source ?? 'rule',
        startAt: absoluteWindow.startAt.toISOString(), endAt: absoluteWindow.endAt.toISOString(),
        timezone, timezoneContext: canonicalTimezoneProvenance(timezoneContext), rule: canonicalRuleProfile(rule), calculationDefinition,
      }
      const frame = { orgId, userId, workDate, timezone, timezoneContext: identity.timezoneContext,
        context: { ...baseContext, rule }, resolution, identity,
        absoluteWindow, attributionWindow, fingerprint: canonicalContextFingerprint(identity) }
      if (timezoneContext.mode === 'multi_timezone') {
        const target = await readFreshTargetTimezoneWindow(trx,{orgId,userId,workDate},undefined,uniqueSegmentWinner ? frame : undefined)
        if (target.contextFingerprint !== frame.fingerprint) fail('ATTENDANCE_TIMEZONE_WORK_DATE_CONTEXT_CONFLICT',409)
      }
      frames.set(trx, frame)
      return frame
    } catch (error) {
      if (error instanceof HttpError) throw error
      if (error instanceof AttendanceTimezonePolicyError) fail(error.code, error.status)
      fail('ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE', 503)
    }
  }
  function assertClientTimezone(clientTimezone, timezone) {
    if (clientTimezone === undefined || clientTimezone === null) return
    let zone
    try { zone = validateIanaTimezone(clientTimezone) } catch (_) { fail('ATTENDANCE_TIMEZONE_INVALID_ZONE') }
    if (zone !== timezone) fail('ATTENDANCE_TIMEZONE_CLIENT_ZONE_CONFLICT', 409)
  }
  function frameFor(trx) { return frames.get(trx) ?? null }
  async function assertLiveTarget(trx, input) {
    const frame = frameFor(trx)
    if (!frame || frame.workDate !== input.workDate || frame.timezone !== input.timezone
      || frame.fingerprint !== input.timezoneContextFingerprint) {
      fail('ATTENDANCE_TIMEZONE_CONTEXT_CHANGED', 409)
    }
    await companion.assertTarget(trx, frame)
  }
  async function bindLiveContext(trx, input, proof) {
    const frame = frameFor(trx)
    if (!frame) fail('ATTENDANCE_TIMEZONE_CONTEXT_UNPREPARED', 503)
    await companion.bindFirst(trx, frame, proof)
  }
  const relatedRecordFrames = new WeakMap()
  async function prepareRelatedRecordContext(trx,{orgId,userId,workDate,expectedContextFingerprint}) {
    try {
      const target = await readTargetTimezoneContext(trx,{orgId,userId,workDate})
      if (expectedContextFingerprint !== undefined && target.contextFingerprint !== expectedContextFingerprint) fail('ATTENDANCE_TIMEZONE_CONTEXT_CHANGED',409)
      const facts = requestTargetFactsFor(trx)
      let frame = facts?.frame
      if (!frame) {
        const window = facts?.window
        if (!window) fail('ATTENDANCE_TIMEZONE_CONTEXT_UNPREPARED',503)
        const absoluteWindow = {startAt:window.startAt,endAt:window.endAt}
        const resolution = await resolveScheduledCandidate(trx,{
          orgId,userId,timezone:target.timezone,calendarWorkDate:workDate,effectiveTimezone:target.timezone,
        })
        if (resolution.kind === 'ambiguous') failAttributionAmbiguity('ATTENDANCE_TIMEZONE_WORK_DATE_AMBIGUOUS')
        let attributionWindow
        if (window.shiftId !== null) {
          const winner = resolution.fullWinner
          if (resolution.kind !== 'resolved' || resolution.workDate !== workDate || resolution.shiftId !== window.shiftId
            || winner?.assignmentId !== window.assignmentId || winner?.timezone !== target.timezone
            || new Date(winner?.absoluteWindow?.startAt).getTime() !== absoluteWindow.startAt.getTime()
            || new Date(winner?.absoluteWindow?.endAt).getTime() !== absoluteWindow.endAt.getTime()) {
            fail('ATTENDANCE_TIMEZONE_CONTEXT_CHANGED',409)
          }
          attributionWindow = {
            startAt:new Date(winner.attributionWindow?.startAt),endAt:new Date(winner.attributionWindow?.endAt),
          }
        } else {
          if (resolution.kind === 'resolved') fail('ATTENDANCE_TIMEZONE_CONTEXT_CHANGED',409)
          const tail = await loadAttributionTail(trx)
          const overtime = await loadApprovedOvertime(trx,{orgId,userId,workDates:[workDate]})
          attributionWindow = require('./attendance-work-date-resolver.cjs').buildAttributionWindow(absoluteWindow,{
            attributionTailMinutes:tail,approvedOvertimeWindows:overtime,orgId,userId,workDate,shiftId:null,
          })
        }
        if (!attributionWindow || !Number.isFinite(attributionWindow.startAt.getTime())
          || !Number.isFinite(attributionWindow.endAt.getTime())
          || attributionWindow.startAt>absoluteWindow.startAt || attributionWindow.endAt<absoluteWindow.endAt) {
          fail('ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_INVALID',409)
        }
        const identity = {
          workDate,shiftId:window.shiftId ?? null,assignmentId:window.assignmentId ?? null,source:window.source,
          startAt:absoluteWindow.startAt.toISOString(),endAt:absoluteWindow.endAt.toISOString(),timezone:target.timezone,
          timezoneContext:window.timezoneContext,rule:canonicalRuleProfile(window.rule),
          calculationDefinition:window.calculationDefinition,
        }
        if (canonicalContextFingerprint(identity) !== target.contextFingerprint) fail('ATTENDANCE_TIMEZONE_CONTEXT_CHANGED',409)
        frame = {orgId,userId,workDate,timezone:target.timezone,timezoneContext:window.timezoneContext,
          context:window.sourceContext,resolution,identity,absoluteWindow,attributionWindow,fingerprint:target.contextFingerprint,
          ...(validateFrozenContext(window.calculationDefinition) ? {issued:{
            arm:window.calculationDefinition.schemaVersion === 2 ? 'group' : 'legacy',context:window.calculationDefinition,reason:null,
          }} : {}),
        }
      }
      await companion.assertTarget(trx,frame)
      relatedRecordFrames.set(trx,frame)
      return target
    } catch (error) {
      if (error instanceof HttpError) throw error
      if (error instanceof AttendanceTimezonePolicyError) fail(error.code,error.status)
      fail('ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE',503)
    }
  }
  async function bindRelatedRecordContext(trx, proof) {
    const frame = relatedRecordFrames.get(trx)
    if (!frame) fail('ATTENDANCE_TIMEZONE_CONTEXT_UNPREPARED',503)
    try { await companion.bindFirst(trx,frame,proof) }
    catch (error) {
      if (error instanceof HttpError) throw error
      fail('ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE',503)
    }
  }
  const scheduledFrames = new WeakMap()
  function scheduledFrameFor(trx, input) {
    const frame = scheduledFrames.get(trx)
    return frame && frame.orgId === input.orgId && frame.userId === input.userId
      && frame.workDate === (input.workDate ?? input.calendarWorkDate) ? frame : null
  }
  function acceptScheduledIssued(trx,input,issued) {
    const frame = scheduledFrameFor(trx,input)
    if (!frame || canonicalContextFingerprint(issued.context) !== canonicalContextFingerprint(frame.identity.calculationDefinition)) {
      fail('ATTENDANCE_TIMEZONE_CONTEXT_CHANGED',409)
    }
    frame.issued = issued
    return issued
  }
  async function acquireScheduledLocks(trx,{orgId,userId}) {
    // Org exclusivity serializes the membership snapshot and prevents an upgrade
    // from shared after the registry's class-00/01 locks have been acquired.
    await lockOrgPolicy(trx,orgId)
    const users = userId ? [{user_id:userId}] : await trx.query(`SELECT uo.user_id
      FROM user_orgs uo JOIN users u ON u.id=uo.user_id
      WHERE uo.org_id=$1 AND uo.is_active=true AND u.is_active=true ORDER BY uo.user_id`,[orgId])
    for (const row of users) await acquireRuntimeLocks(trx,{orgId,userId:row.user_id,mode:'exclusive'})
  }
  async function prepareScheduledContext(trx,input) {
    scheduledFrames.delete(trx)
    relatedRecordFrames.delete(trx)
    const existing = await trx.query(`SELECT timezone,is_workday FROM attendance_records
      WHERE org_id=$1 AND user_id=$2 AND work_date=$3`,[input.orgId,input.userId,input.workDate])
    // Preserve NOT EXISTS and authoritative retirement handling for old records.
    // Their historical bytes need no current-policy read or synthetic migration.
    if (existing.length) return {timezone:existing[0].timezone,isWorkday:existing[0].is_workday === true,existing:true}
    const target = await prepareRelatedRecordContext(trx,input)
    const frame = relatedRecordFrames.get(trx)
    scheduledFrames.set(trx,frame)
    // The related-record reader retained the served mirror definition. Scheduled
    // producers must still issue with purpose persist to retain W7's shadow half.
    delete frame.issued
    return {timezone:target.timezone,isWorkday:target.isWorkingDay,existing:false,
      holidayKind:frame.context.holiday?.isWorkingDay === false ? 'holiday' : null}
  }
  async function resolveScheduledMembers(trx,{orgId,workDate}) {
    const users = await trx.query(`SELECT uo.user_id FROM user_orgs uo JOIN users u ON u.id=uo.user_id
      WHERE uo.org_id=$1 AND uo.is_active=true AND u.is_active=true`,[orgId])
    const members = []
    for (const row of users) {
      const input = {orgId,userId:row.user_id,workDate}
      let target
      try {
        target = await prepareScheduledContext(trx,input)
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 409
          || (error.code !== 'ATTENDANCE_TIMEZONE_WORK_DATE_CONTEXT_CONFLICT'
            && error.code !== 'ATTENDANCE_TIMEZONE_WORK_DATE_AMBIGUOUS')
          || !attributionAmbiguityErrors.has(error)) throw error
        members.push({userId:row.user_id,targetKind:'review',reviewReasonCode:'WORK_DATE_ATTRIBUTION_AMBIGUOUS'})
        continue
      }
      if (!target.isWorkday) continue
      const frame = scheduledFrameFor(trx,input)
      const resolution = frame?.resolution
      const reason = target.existing || (resolution?.kind === 'resolved' && resolution.workDate === workDate)
        || (frame?.context.source === 'rule' && resolution?.reasonCode === 'UNSCHEDULED_NO_SHIFT') ? null
        : resolution?.kind === 'ambiguous' ? 'WORK_DATE_ATTRIBUTION_AMBIGUOUS'
        : resolution?.kind === 'resolved' ? 'WORK_DATE_ATTRIBUTION_MISMATCH'
        : resolution?.reasonCode || 'WORK_DATE_ATTRIBUTION_UNRESOLVED'
      members.push({userId:row.user_id,targetKind:reason ? 'review' : 'generate',reviewReasonCode:reason})
    }
    scheduledFrames.delete(trx)
    relatedRecordFrames.delete(trx)
    return members
  }
  const requestTargetFacts = new WeakMap()
  const requestTargetBatchFacts = new WeakMap()
  const calendarSourceFacts = new WeakMap()
  function readCalendarSourceFactsFor(trx) { return calendarSourceFacts.get(trx) ?? null }
  function requestTargetFactsFor(trx,workDate) {
    return workDate === undefined ? (requestTargetFacts.get(trx) ?? null)
      : (requestTargetBatchFacts.get(trx)?.get(workDate) ?? null)
  }
  // Callers already hold the canonical org-policy/facts prefix. This is the
  // same whole-work-date proof for preview, source changes, and fresh live punch.
  async function readFreshTargetTimezoneWindow(trx,{orgId,userId,workDate,policyProjection},batch,selectedFrame) {
    const midnight = new Date(workDate+'T00:00:00.000Z')
    const q = queryFor(trx)
    const store = createAttendanceTimezonePolicyStore({
      query:q,transaction:work=>work(q),authorizeManage:async()=>false,
    })
    const policy = batch?.policy ?? await store.readPolicy({orgId})
    if (!batch) await store.readDefault({orgId})
    const from = new Date(midnight.getTime()-2*86400_000)
    const to = new Date(midnight.getTime()+3*86400_000)
    const cuts = new Set([from.getTime(),to.getTime()])
    if (policyProjection?.enabled ?? policy.enabled) {
      const sources = batch ? batch.cuts : await trx.query(`SELECT effective_from AS start_at,effective_to AS end_at
        FROM attendance_employee_timezone_overrides WHERE org_id=$1 AND user_id=$2
          AND effective_from<$4 AND (effective_to IS NULL OR effective_to>$3)
        UNION ALL SELECT start_at,effective_end_at AS end_at FROM attendance_business_trip_arrangements
        WHERE org_id=$1 AND user_id=$2 AND start_at<$4 AND effective_end_at>$3`,[orgId,userId,from,to])
      for (const source of sources) for (const value of [source.start_at,source.end_at]) {
        if (value === null) continue
        const epoch = new Date(value).getTime()
        if (!Number.isFinite(epoch)) fail('ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE',503)
        if (epoch>from.getTime() && epoch<to.getTime()) cuts.add(epoch)
      }
    }
    // Live unique-containing proof only; default request/source/calendar
    // callers still prove the whole work date across all candidates.
    const selectedStart = selectedFrame?.absoluteWindow.startAt.getTime()
    const selectedEnd = selectedFrame?.absoluteWindow.endAt.getTime()
    if (selectedFrame) {
      if (selectedFrame.orgId !== orgId || selectedFrame.userId !== userId || selectedFrame.workDate !== workDate
        || !Number.isFinite(selectedStart) || !Number.isFinite(selectedEnd) || selectedEnd <= selectedStart
        || selectedStart < from.getTime() || selectedEnd > to.getTime()) fail('ATTENDANCE_TIMEZONE_INVALID_REFERENCE')
      cuts.add(selectedStart)
      cuts.add(selectedEnd)
    }
    const boundaries = [...cuts].sort((a,b)=>a-b)
    const contexts = new Map()
    let coveredThrough = selectedStart
    for (let index=0;index<boundaries.length-1;index+=1) {
      const start = boundaries[index],end = boundaries[index+1]
      if (selectedFrame && !(start < selectedEnd && selectedStart < end)) continue
      const probe = new Date(start)
      const windows = await readPublishedTimezoneWindows(trx,{
        orgId,userId,from:probe,to:new Date(start+1),targetWorkDates:[workDate],includeRestDay:true,
        ...(policyProjection === undefined ? {} : {policyProjection}),
      },batch)
      if (selectedFrame) {
        const selected = windows.filter(window => window.workDate === workDate
          && window.shiftId === selectedFrame.identity.shiftId
          && window.assignmentId === selectedFrame.identity.assignmentId && window.source === selectedFrame.identity.source)
        // Never discard a required partition because a changed zone moved its
        // reconstructed window elsewhere. Compare the original FULL frame.
        if (selected.length !== 1 || selected[0].startAt.getTime() !== selectedStart
          || selected[0].endAt.getTime() !== selectedEnd || selected[0].contextFingerprint !== selectedFrame.fingerprint
          || start !== coveredThrough) fail('ATTENDANCE_TIMEZONE_WORK_DATE_CONTEXT_CONFLICT',409)
        coveredThrough = end
        contexts.set(selected[0].contextFingerprint,selected[0])
      } else {
        for (const window of windows) {
          if (window.startAt.getTime()<end && start<window.endAt.getTime()) {
            contexts.set(window.contextFingerprint,window)
          }
        }
      }
    }
    if (selectedFrame && coveredThrough !== selectedEnd) fail('ATTENDANCE_TIMEZONE_WORK_DATE_CONTEXT_CONFLICT',409)
    if (batch?.calendarSelection) {
      // Read-only display proof; never used by the single-target/write callers below.
      const day = buildCalendarTimezoneDay([...contexts.values()], {
        candidateOrder: batch.candidates.filter(candidate => candidate.workDate === workDate).map(calendarCandidateKey),
        fingerprint: canonicalContextFingerprint,
      })
      if (!day) fail('ATTENDANCE_TIMEZONE_WORK_DATE_CONTEXT_CONFLICT',409)
      return day
    }
    if (contexts.size > 1) failAttributionAmbiguity('ATTENDANCE_TIMEZONE_WORK_DATE_CONTEXT_CONFLICT')
    if (contexts.size !== 1) fail('ATTENDANCE_TIMEZONE_WORK_DATE_CONTEXT_CONFLICT',409)
    return [...contexts.values()][0]
  }
  async function readTargetTimezoneContext(trx,{orgId,userId,workDate},batch) {
    const midnight = new Date(workDate+'T00:00:00.000Z')
    if (typeof workDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)
      || !Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0,10) !== workDate) {
      fail('ATTENDANCE_TIMEZONE_TARGET_INVALID')
    }
    if (!batch) await acquireRuntimeLocks(trx,{orgId,userId,mode:'shared'})
    try {
      if (!requestReadScope(trx,orgId,userId)) {
        const members = batch ? batch.members : await trx.query(`SELECT u.id FROM users u JOIN user_orgs uo ON uo.user_id=u.id
          WHERE u.id=$1 AND uo.org_id=$2 AND u.is_active=true AND uo.is_active=true`,[userId,orgId])
        if (members.length !== 1) fail('ATTENDANCE_TIMEZONE_MEMBER_REQUIRED',403)
      }
      const existing = batch ? batch.companions.get(workDate) : await companion.readForWorkDate(trx,{orgId,userId,workDate})
      function target(frame,referenceId,frozen) {
        requestTargetFacts.set(trx,{frame})
        return {
          orgId,userId,workDate,timezone:frame.timezone,contextFingerprint:frame.fingerprint,
          frozen,referenceId,provenance:frame.timezoneContext,
          window:{startAt:frame.absoluteWindow.startAt,endAt:frame.absoluteWindow.endAt},
          rule:frame.context.rule,isWorkingDay:frame.context.isWorkingDay === true,
        }
      }
      if (existing) {
        await assertLegacyRepairPosture(trx,existing.frame)
        return target(existing.frame,existing.recordId,true)
      }
      const legacy = batch ? batch.legacy.get(workDate) : await companion.readLegacyFrozenV2(trx,{orgId,userId,workDate})
      if (legacy) return target(legacy.frame,legacy.recordId,true)
      const prior = batch ? (batch.priorDates.get(workDate) ?? []) : await trx.query(`SELECT id,timezone,current_calculation_id FROM attendance_records
        WHERE org_id=$1 AND user_id=$2 AND work_date=$3 AND visibility_state='active'`,[orgId,userId,workDate])
      const window = await readFreshTargetTimezoneWindow(trx,{orgId,userId,workDate},batch)
      // Same rule as companion.assertTarget: only a default-only reading in the
      // record's own zone, under legacy posture, may stand in for a pre-companion record, unfrozen.
      if (prior.length && !await admitsPreCompanionLegacyTarget(trx,orgId,{timezone:window.timezone,timezoneContext:window.timezoneContext},prior)) {
        fail('ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_MIGRATION_REQUIRED',409)
      }
      requestTargetFacts.set(trx,{window})
      return {
        orgId,userId,workDate,timezone:window.timezone,contextFingerprint:window.contextFingerprint,
        frozen:false,referenceId:window.assignmentId ?? window.rule.id,
        provenance:window.timezoneContext,window:{startAt:window.startAt,endAt:window.endAt},
        rule:window.rule,isWorkingDay:window.isWorkingDay,
      }
    } catch (error) {
      if (error instanceof HttpError) throw error
      if (error instanceof AttendanceTimezonePolicyError) fail(error.code,error.status)
      fail('ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE',503)
    }
  }
  async function readTargetTimezoneContexts(trx,{orgId,userId,workDates}) {
    if (!Array.isArray(workDates) || !orgId || !userId || workDates.some(date => {
      const parsed = typeof date === 'string' ? new Date(date+'T00:00:00.000Z') : null
      return !parsed || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10)!==date
    })) fail('ATTENDANCE_TIMEZONE_TARGET_INVALID')
    const dates = [...new Set(workDates)].sort()
    if (!dates.length) return new Map()
    await acquireRuntimeLocks(trx,{orgId,userId,mode:'shared'})
    try {
      const members = await trx.query(`SELECT u.id FROM users u JOIN user_orgs uo ON uo.user_id=u.id
        WHERE u.id=$1 AND uo.org_id=$2 AND u.is_active=true AND uo.is_active=true`,[userId,orgId])
      if (members.length !== 1) fail('ATTENDANCE_TIMEZONE_MEMBER_REQUIRED',403)
      const companions = await companion.readForWorkDates(trx,{orgId,userId,workDates:dates})
      const legacyEntries = await companion.readLegacyFrozenV2(trx,{orgId,userId,workDates:dates})
      const legacy = new Map()
      for (const entry of legacyEntries) {
        if (legacy.has(entry.frame.workDate)) fail('ATTENDANCE_TIMEZONE_OPEN_CONTEXT_AMBIGUOUS',409)
        legacy.set(entry.frame.workDate,entry)
      }
      const priorRows = await trx.query(`SELECT id,timezone,current_calculation_id,work_date::text FROM attendance_records
        WHERE org_id=$1 AND user_id=$2 AND work_date=ANY($3::date[]) AND visibility_state='active'`,[orgId,userId,dates])
      const priorDates = new Map()
      for (const row of priorRows) priorDates.set(row.work_date,[...(priorDates.get(row.work_date) ?? []),row])
      const freshDates = dates.filter(date=>!companions.has(date) && !legacy.has(date))
      // Pre-companion dates are decided per date, after the fresh reading exists.
      const batch = {members,companions,legacy,priorDates,candidates:[],cuts:[],policy:null,holidays:new Map(),calendarOverrides:[]}
      let batchTrx = trx
      if (freshDates.length) {
        const fixedReads = new Map()
        let employees = [],trips = [],memberships = []
        // Only this batch's fixed reference SELECTs are memoized. Every source
        // interval below is fetched once then filtered with its original bounds.
        batchTrx = {...trx,query:async (text,values=[]) => {
          if (/^SELECT id, timezone, version, effective_from, effective_to FROM attendance_employee_timezone_overrides /.test(text)) {
            const at = values[2]
            return employees.filter(row=>new Date(row.effective_from)<=at && (row.effective_to===null || at<new Date(row.effective_to)))
          }
          if (/^SELECT request_id,org_id,user_id,destination_timezone,start_at,effective_end_at,version/.test(text)) {
            const at = values[2]
            return trips.filter(row=>new Date(row.start_at)<=at && at<new Date(row.effective_end_at))
          }
          if (text.startsWith('SELECT id, org_id, user_id, group_id, effective_from::text')) {
            const date = values[2]
            return memberships.filter(row=>row.effective_from<=date && (row.effective_to===null || date<=row.effective_to))
          }
          const fixed = /^\s*SELECT\b/.test(text) && !/\bFOR\s+(?:UPDATE|SHARE|KEY\s+SHARE|NO\s+KEY\s+UPDATE)\b/i.test(text)
            && (text.includes('FROM attendance_timezone_policies')
            || text.includes('FROM attendance_rules') || text.includes('FROM system_configs')
            || text.includes('FROM attendance_groups WHERE id') || text.includes('FROM attendance_group_effect_revisions')
            || text.includes('FROM attendance_shifts') || text.includes('FROM attendance_shift_segments')
            || text.includes('FROM attendance_calculation_context_source_state') || text.includes('FROM users'))
          const key = JSON.stringify([text,values])
          if (fixed && fixedReads.has(key)) return fixedReads.get(key)
          const rows = await trx.query(text,values)
          if (fixed) fixedReads.set(key,rows)
          return rows
        }}
        if (typeof prepareRuleContextBatch === 'function') {
          batch.resolveRuleContext = await prepareRuleContextBatch(batchTrx,orgId)
        }
        const q = queryFor(batchTrx)
        const store = createAttendanceTimezonePolicyStore({query:q,transaction:work=>work(q),authorizeManage:async()=>false})
        batch.policy = await store.readPolicy({orgId})
        await store.readDefault({orgId})
        batch.calendarOverrides = await loadCalendarOverrides(batchTrx)
        batch.candidates = await loadPublishedCandidates(batchTrx,{orgId,userId,workDates:freshDates,strictSources:true})
        if (typeof selectCalendarCandidates !== 'function') fail('ATTENDANCE_TIMEZONE_RUNTIME_UNAVAILABLE',503)
        const selected = await selectCalendarCandidates(batchTrx,{orgId,userId,workDates:freshDates,candidates:batch.candidates})
        batch.candidates = selected.candidates
        batch.multiShiftDay = selected.multiShiftDay
        batch.calendarPrefetch = selected.prefetched
        batch.calendarSelection = true
        const holidays = await trx.query(`SELECT id,org_id,holiday_date::text AS holiday_date,name,is_working_day,origin
          FROM attendance_holidays WHERE org_id=$1 AND holiday_date=ANY($2::date[])`,[orgId,freshDates])
        for (const row of holidays) {
          if (row.org_id !== orgId || !freshDates.includes(row.holiday_date) || batch.holidays.has(row.holiday_date)) {
            fail('ATTENDANCE_SETTINGS_SOURCE_INVALID',503)
          }
          batch.holidays.set(row.holiday_date,mapHolidayRow(row))
        }
        if (batch.policy.enabled) {
          const from = new Date(addDaysToDateKey(freshDates[0],-2)+'T00:00:00.000Z')
          const to = new Date(addDaysToDateKey(freshDates[freshDates.length-1],3)+'T00:00:00.000Z')
          employees = await trx.query(`SELECT id,timezone,version,effective_from,effective_to
            FROM attendance_employee_timezone_overrides WHERE org_id=$1 AND user_id=$2
              AND effective_from<$4 AND (effective_to IS NULL OR effective_to>$3)`,[orgId,userId,from,to])
          trips = await trx.query(`SELECT request_id,org_id,user_id,destination_timezone,start_at,effective_end_at,version
            FROM attendance_business_trip_arrangements WHERE org_id=$1 AND user_id=$2 AND start_at<$4 AND effective_end_at>$3`,
          [orgId,userId,from,to])
          memberships = await trx.query(`SELECT id,org_id,user_id,group_id,effective_from::text AS effective_from,effective_to::text AS effective_to
            FROM attendance_calculation_group_memberships WHERE org_id=$1 AND user_id=$2
              AND effective_from<=$4::date AND (effective_to IS NULL OR effective_to>=$3::date)`,
          [orgId,userId,freshDates[0],freshDates[freshDates.length-1]])
          batch.cuts = [...employees.map(row=>({start_at:row.effective_from,end_at:row.effective_to})),
            ...trips.map(row=>({start_at:row.start_at,end_at:row.effective_end_at}))]
        }
      }
      const result = new Map()
      const details = new Map()
      for (const workDate of dates) {
        result.set(workDate,await readTargetTimezoneContext(batchTrx,{orgId,userId,workDate},batch))
        details.set(workDate,requestTargetFacts.get(batchTrx))
      }
      requestTargetBatchFacts.set(trx,details)
      calendarSourceFacts.set(trx,{calendarOverrides:batch.calendarOverrides,multiShiftDay:batch.multiShiftDay,prefetched:batch.calendarPrefetch,byDate:details})
      return result
    } catch (error) {
      if (error instanceof HttpError) throw error
      if (error instanceof AttendanceTimezonePolicyError) fail(error.code,error.status)
      fail('ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE',503)
    }
  }
  async function assertFutureEmployeeBoundaries(trx,{orgId,users,now,mutation,policyProjection}) {
    const q = queryFor(trx)
    const store = createAttendanceTimezonePolicyStore({query:q,transaction:work=>work(q),authorizeManage:async()=>false})
    const policy = await store.readPolicy({orgId})
    // OFF ignores optional sources, including invalid or unavailable overrides.
    if (!(policyProjection?.enabled ?? policy.enabled)) return
    for (const userId of users) {
      // Employee mutations concern only the row just created/closed. Broader
      // rule/policy/schedule changes must recheck all affected future boundaries.
      const filter = mutation?.kind === 'employee_override_create' ? ' AND effective_from=$4'
        : mutation?.kind === 'employee_override_close' ? ' AND id=$4' : ''
      const values = [orgId,userId,now]
      if (mutation?.kind === 'employee_override_create') values.push(mutation.effectiveFrom)
      else if (mutation?.kind === 'employee_override_close') values.push(mutation.referenceId)
      const rows = await trx.query(`SELECT effective_from,effective_to FROM attendance_employee_timezone_overrides
        WHERE org_id=$1 AND user_id=$2 AND (effective_from >= $3 OR effective_to >= $3)`+filter,values)
      const cuts = new Set()
      for (const row of rows) for (const value of [row.effective_from,row.effective_to]) {
        if (value === null) continue
        const epoch = new Date(value).getTime()
        if (!Number.isFinite(epoch)) fail('ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE',503)
        if (epoch >= now.getTime()) cuts.add(epoch)
      }
      const dates = new Set()
      for (const cut of cuts) {
        // Evaluate both source selections. Dateline/overnight windows may belong
        // to different target dates; a rest day alone must not prohibit a change.
        for (const epoch of [cut-1,cut]) {
          const windows = await readPublishedTimezoneWindows(trx,{
            orgId,userId,from:new Date(epoch),to:new Date(epoch+1),
            ...(policyProjection === undefined ? {} : {policyProjection}),
          })
          for (const window of windows) if (window.isWorkingDay === true) dates.add(window.workDate)
        }
      }
      for (const workDate of dates) {
        await readFreshTargetTimezoneWindow(trx,{orgId,userId,workDate,policyProjection})
      }
    }
  }
  async function prepareSourceChange(trx, { orgId, userIds = null, now = serverNow(), mutation, policyProjection }) {
    await lockOrgPolicy(trx, orgId)
    if (mutation?.kind === 'empty_group_create') {
      const query = queryFor(trx)
      const store = createAttendanceTimezonePolicyStore({
        query,transaction:work => work(query),authorizeManage:async () => false,
      })
      const policy = await store.readPolicy({orgId})
      // Empty groups have no OFF effect. ON still changes the organization-wide
      // group revision, so existing group-sourced windows require the full guard.
      userIds = policy.enabled === false ? [] : null
    }
    const members = await trx.query(`SELECT uo.user_id FROM user_orgs uo JOIN users u ON u.id=uo.user_id
      WHERE uo.org_id=$1 AND uo.is_active=true AND u.is_active=true
      AND ($2::text[] IS NULL OR uo.user_id::text=ANY($2::text[])) ORDER BY uo.user_id`,[orgId,userIds])
    const users = [...new Set(members.map(row => String(row.user_id)))].sort()
    if (userIds !== null && users.length !== new Set(userIds).size) fail('ATTENDANCE_TIMEZONE_MEMBER_REQUIRED', 403)
    for (const userId of users) await acquireRuntimeLocks(trx, {orgId,userId,mode:'exclusive'})
    // OFF recovery is restricted to errors from the strict default reader itself.
    // Membership, policy/CAS, database faults and all valid-default guards remain active.
    if (mutation?.kind === 'policy' && mutation.enabled === false) {
      const q = queryFor(trx)
      const strictStore = createAttendanceTimezonePolicyStore({
        query:q, transaction:work => work(q), authorizeManage:async () => false,
      })
      try { await strictStore.readDefault({orgId}) }
      catch (error) {
        if (!(error instanceof AttendanceTimezonePolicyError) || ![
          'ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED','ATTENDANCE_TIMEZONE_MULTIPLE_DEFAULTS',
          'ATTENDANCE_TIMEZONE_INVALID_ZONE','ATTENDANCE_TIMEZONE_INVALID_REVISION',
          'ATTENDANCE_TIMEZONE_INVALID_REFERENCE',
        ].includes(error.code)) throw error
        return async () => {
          const current = await strictStore.readPolicy({orgId})
          if (current.enabled !== false) fail('ATTENDANCE_TIMEZONE_CONTEXT_CHANGED',409)
        }
      }
    }
    const defaults = await trx.query('SELECT id FROM attendance_rules WHERE org_id=$1 AND is_default=true',[orgId])
    if (defaults.length === 0) {
      if (mutation?.kind === 'default_rule_create') {
        return require('./attendance-timezone-default-recovery.cjs').prepareAttendanceTimezoneDefaultRecovery(trx,{
          orgId,now,timezone:mutation.timezone,HttpError,
          readFrozenContext:async (db,input) => await companion.readForWorkDate(db,input)
            ?? await companion.readLegacyFrozenV2(db,input),
          readPublishedCandidates:loadPublishedCandidates,fingerprint:canonicalContextFingerprint,
          readCurrentSemantics:async (db,{orgId,userId,workDate,now}) => (await readPublishedTimezoneWindows(db,{
            orgId,userId,from:now,to:new Date(now.getTime()+1),targetWorkDates:[workDate],
          })).map(window => ({
            workDate:window.workDate,shiftId:window.shiftId ?? null,assignmentId:window.assignmentId ?? null,
            source:window.source,startAt:window.startAt.toISOString(),endAt:window.endAt.toISOString(),
            timezone:window.timezone,rule:canonicalRuleProfile(window.rule),calculationDefinition:window.calculationDefinition,
          })),
        })
      }
      const existing = await trx.query(`SELECT
        EXISTS(SELECT 1 FROM attendance_shift_assignments WHERE org_id=$1 AND is_active=true) OR
        EXISTS(SELECT 1 FROM attendance_rotation_assignments WHERE org_id=$1 AND is_active=true) OR
        EXISTS(SELECT 1 FROM attendance_timezone_context_companions WHERE org_id=$1) OR
        EXISTS(SELECT 1 FROM attendance_business_trip_arrangements WHERE org_id=$1 AND effective_end_at>$2) AS present`,[orgId,now])
      if (existing[0]?.present !== false) fail('ATTENDANCE_TIMEZONE_DEFAULT_MISSING',503)
      return async () => {}
    }
    async function started(projection) {
      const signatures = []
      for (const userId of users) {
        const to = new Date(now.getTime()+1)
        const windows = await readPublishedTimezoneWindows(trx,{orgId,userId,from:now,to,
          ...(projection === undefined ? {} : {policyProjection:projection})})
        const frozen = await readFrozenTimezoneWindows(trx,{orgId,userId,from:now,to})
        const frozenDates = [...new Set(frozen.filter(window => window.startAt <= now && now < window.endAt)
          .map(window => window.workDate))]
        // A withdrawn published row does not erase a still-running original freeze.
        // Compare its target-date current projection as well as live started windows.
        const projections = frozenDates.length === 0 ? [] : await readPublishedTimezoneWindows(trx,{
          orgId,userId,from:now,to,targetWorkDates:frozenDates,
          ...(projection === undefined ? {} : {policyProjection:projection}),
        })
        for (const window of windows) {
          if (window.startAt <= now && now < window.endAt) {
            signatures.push({userId,workDate:window.workDate,kind:'started',contextFingerprint:window.contextFingerprint})
          }
        }
        for (const window of projections) {
          signatures.push({userId,workDate:window.workDate,kind:'frozen_target',contextFingerprint:window.contextFingerprint})
        }
      }
      return signatures.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    }
    const before = await started()
    const verifyTrips = await prepareTripSourceChange(trx,{orgId,userIds,now,...(policyProjection === undefined ? {} : {policyProjection})})
    return async () => {
      if (canonicalContextFingerprint(before) !== canonicalContextFingerprint(await started(policyProjection))) {
        fail('ATTENDANCE_TIMEZONE_STARTED_CONTEXT_CONFLICT',409)
      }
      await verifyTrips()
      await assertFutureEmployeeBoundaries(trx,{orgId,users,now,mutation,policyProjection})
    }
  }
  async function previewPolicyChangeCore(trx,{orgId,enabled,expectedVersion}) {
    if (typeof enabled !== 'boolean' || !Number.isSafeInteger(expectedVersion) || expectedVersion<0) {
      fail('ATTENDANCE_TIMEZONE_PROJECTION_INVALID')
    }
    await lockOrgPolicy(trx,orgId)
    const query = queryFor(trx)
    const store = createAttendanceTimezonePolicyStore({
      query,transaction:work=>work(query),authorizeManage:async()=>false,
    })
    const actual = await store.readPolicy({orgId})
    if (actual.version !== expectedVersion) fail('ATTENDANCE_TIMEZONE_CONFIG_CHANGED',409)
    await store.readDefault({orgId})
    const members = await trx.query(`SELECT uo.user_id FROM user_orgs uo JOIN users u ON u.id=uo.user_id
      WHERE uo.org_id=$1 AND uo.is_active=true AND u.is_active=true ORDER BY uo.user_id`,[orgId])
    const users = [...new Set(members.map(row=>String(row.user_id)))].sort()
    const now = serverNow()
    const policyProjection = {orgId,enabled,expectedVersion}
    const result = {
      currentVersion:actual.version,proposedEnabled:enabled,evaluatedUsers:users.length,
      affectedUsers:0,conflictingUsers:0,
      conflictCounts:{startedContext:0,tripContext:0,invalidTargetContext:0},
    }
    async function prospective(userId,projection) {
      const load = loaderFor(trx,projection === undefined ? {} : {policyProjection:projection})
      const natural = []
      for (const workDate of boundaryDates(now,now)) {
        const context = await load({orgId,userId,workDate,occurredAt:now})
        if (toWorkDate(now,context.timezone) === workDate) natural.push({workDate,context})
      }
      if (natural.length !== 1) fail('ATTENDANCE_TIMEZONE_WORK_DATE_AMBIGUOUS',409)
      const {workDate} = natural[0]
      const windows = await readPublishedTimezoneWindows(trx,{
        orgId,userId,from:now,to:new Date(now.getTime()+1),targetWorkDates:[workDate],includeRestDay:true,
        ...(projection === undefined ? {} : {policyProjection:projection}),
      })
      if (windows.length !== 1) fail('ATTENDANCE_TIMEZONE_WORK_DATE_CONTEXT_CONFLICT',409)
      return windows[0].contextFingerprint
    }
    for (const userId of users) {
      try {
        const before = await prospective(userId)
        const after = await prospective(userId,policyProjection)
        if (before !== after) result.affectedUsers+=1
        const verify = await prepareSourceChange(trx,{orgId,userIds:[userId],now,policyProjection})
        await verify()
      } catch (error) {
        if (error instanceof AttendanceTimezonePolicyError) error = new HttpError(error.status,error.code,error.code)
        if (!(error instanceof HttpError) || ![409,422].includes(error.status)) throw error
        result.conflictingUsers+=1
        if (error.code === 'ATTENDANCE_TIMEZONE_STARTED_CONTEXT_CONFLICT') result.conflictCounts.startedContext+=1
        else if (error.code?.startsWith('ATTENDANCE_TRIP_')) result.conflictCounts.tripContext+=1
        else result.conflictCounts.invalidTargetContext+=1
      }
    }
    return result
  }
  async function previewPolicyChange(trx,input) {
    try { return await previewPolicyChangeCore(trx,input) }
    catch (error) {
      if (error instanceof HttpError) throw error
      if (error instanceof AttendanceTimezonePolicyError) fail(error.code,error.status)
      fail('ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE',503)
    }
  }
  async function prepareTimezoneSourceChange({ query, orgId, userIds = null, now, mutation }) {
    const trx = { query: async (text, values) => {
      const result = await query(text, values)
      if (!result || !Array.isArray(result.rows)) fail('ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE',503)
      return result.rows
    } }
    async function protectedSource(work) {
      try { return await work() }
      catch (error) {
        if (error instanceof HttpError) throw new AttendanceTimezonePolicyError(error.code,error.status)
        throw error
      }
    }
    const verify = await protectedSource(() => prepareSourceChange(trx,{orgId,userIds,mutation,...(now === undefined ? {} : {now})}))
    return async () => protectedSource(verify)
  }
  const readFrozenTimezoneWindows = require('./attendance-timezone-frozen-windows.cjs').createAttendanceTimezoneFrozenWindowReader({ HttpError })
  return { readLegacyRepairRequestTarget, acceptScheduledIssued, acquireScheduledLocks, prepareScheduledContext, resolveScheduledMembers, scheduledFrameFor, prepareRelatedRecordContext, bindRelatedRecordContext, previewPolicyChange, readCalendarSourceFactsFor, requestTargetFactsFor, readRequestTimezoneContext, readTargetTimezoneContext, readTargetTimezoneContexts, prepareSourceChange, prepareTimezoneSourceChange, readPublishedTimezoneWindows, readFrozenTimezoneWindows, loaderFor, uniqueWallInstant, prepareLivePunch, frameFor, assertLiveTarget, bindLiveContext }
}

function canonicalTimezoneProvenance(context) {
  return {
    timezone: context.timezone, source: context.source, mode: context.mode,
    referenceId: context.referenceId, version: context.version,
    policyVersion: context.policyVersion,
    calculationGroupMembership: context.calculationGroupMembership,
  }
}

function canonicalRuleProfile(rule) {
  return {
    id: rule.id ?? null, timezone: rule.timezone,
    workStartTime: rule.workStartTime, workEndTime: rule.workEndTime,
    isOvernight: rule.isOvernight === true, workingDays: rule.workingDays,
    lateGraceMinutes: rule.lateGraceMinutes, earlyGraceMinutes: rule.earlyGraceMinutes ?? rule.earlyLeaveGraceMinutes,
    roundingMinutes: rule.roundingMinutes,
    severeLateThresholdMinutes: rule.severeLateThresholdMinutes,
    absenceLateThresholdMinutes: rule.absenceLateThresholdMinutes,
    flexMode: rule.flexMode, flexRequiredMinutes: rule.flexRequiredMinutes,
    flexArrivalWindowBeforeMinutes: rule.flexArrivalWindowBeforeMinutes,
    flexArrivalWindowAfterMinutes: rule.flexArrivalWindowAfterMinutes,
    flexCoreStartTime: rule.flexCoreStartTime, flexCoreEndTime: rule.flexCoreEndTime,
  }
}

function canonicalContextFingerprint(context) {
  function ordered(value) {
    if (value instanceof Date) return value.toISOString()
    if (Array.isArray(value)) return value.map(ordered)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]))
    }
    return value
  }
  return createHash('sha256').update(JSON.stringify(ordered(context))).digest('hex')
}

module.exports = { createAttendanceTimezoneRuntime, canonicalTimezoneProvenance, canonicalRuleProfile, canonicalContextFingerprint }
