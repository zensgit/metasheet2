'use strict'

const { randomUUID } = require('node:crypto')
const requesterDisplay = require('./attendance-requester-display.cjs')

function createBusinessTripRequestAdapter(deps) {
  const { service, routeSchema, loadFlow, freezeRelations, buildApproval, buildAssignments,
    upsertApproval, replaceAssignments, appendSnapshot, snapshotFields, snapshotMaterial, snapshotToken,
    mapRequest, assertDynamic, isAdmin } = deps
  function identity(raw) {
    const route = routeSchema.parse(raw)
    const crossUser = route.actorId !== route.input.userId
    return { orgId: route.orgId, actorId: route.actorId, tokenSubjectUserId: route.tokenSubjectUserId,
      actorPosture: crossUser ? 'attendance_admin' : 'self', subjectUserId: route.input.userId,
      subjectScope: crossUser ? { kind: 'explicit_users', userIds: [route.input.userId] } : { kind: 'self', userId: route.input.userId },
      commandPayload: { requestType: 'business_trip', requestWrite: route.input }, state: null }
  }
  async function prepare(trx, raw) {
    const route = routeSchema.parse(raw)
    if (route.actorId !== route.input.userId && !await isAdmin(route.actorId)) service.fail('FORBIDDEN', 403)
    const flow = await loadFlow(trx, route.orgId, 'business_trip', route.input.approvalFlowId)
    if (!flow) service.fail('APPROVAL_FLOW_REQUIRED')
    assertDynamic(flow.steps)
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: route.input.destinationTimezone,
      year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(route.input.startAt)).map(p => [p.type,p.value]))
    const workDate = parts.year + '-' + parts.month + '-' + parts.day
    const draft = { requestType: 'business_trip', workDate, requestedInAt: new Date(route.input.startAt),
      requestedOutAt: new Date(route.input.endAt), reason: route.input.reason,
      metadata: { approvalFlow: { id: flow.id, name: flow.name, steps: flow.steps, currentStep: 0 } } }
    const requestId = randomUUID(), approvalId = 'apv_' + randomUUID()
    const orgRelations = await freezeRelations({ orgId: route.orgId, userId: route.input.userId, flowSteps: flow.steps })
    const approvalPayload = buildApproval({ requestId, approvalId, orgId: route.orgId, userId: route.input.userId,
      requesterName: await requesterDisplay.forCreate(trx, { userId: route.input.userId, orgId: route.orgId,
        actorId: route.actorId, actorName: route.requesterName }), draft, orgRelations, requestNamedOrgId: route.orgId })
    approvalPayload.metadata = { ...approvalPayload.metadata, suite: 'attendance' }
    approvalPayload.formSnapshot = { ...approvalPayload.formSnapshot, destinationTimezone: route.input.destinationTimezone }
    const approvalAssignments = buildAssignments(flow.steps, 0, approvalPayload.requesterSnapshot)
    return { ...identity(route), state: { routeVariant: 'business_trip', route, draft, flow, requestId, approvalId, approvalPayload, approvalAssignments } }
  }
  async function execute(trx, prepared) {
    const { route, draft, flow, requestId, approvalId, approvalPayload, approvalAssignments } = prepared.state
    await service.member(trx, route.orgId, route.actorId)
    await service.member(trx, route.orgId, route.input.userId)
    if (route.actorId !== route.input.userId && !await isAdmin(route.actorId)) service.fail('FORBIDDEN', 403)
    const current = await loadFlow(trx, route.orgId, 'business_trip', flow.id)
    if (!current || JSON.stringify(current.steps) !== JSON.stringify(flow.steps)) service.fail('APPROVAL_FLOW_CHANGED', 409)
    const { orgId } = await upsertApproval(trx, approvalPayload)
    if (orgId !== route.orgId) service.fail('REQUEST_BINDING', 409)
    await replaceAssignments(trx, approvalId, approvalAssignments)
    const rows = await trx.query(`INSERT INTO attendance_requests
      (id,user_id,org_id,work_date,request_type,requested_in_at,requested_out_at,reason,status,approval_instance_id,approval_workflow_key,metadata)
      VALUES ($1,$2,$3,$4,'business_trip',$5,$6,$7,'pending',$8,$9,$10::jsonb) RETURNING *`,
    [requestId,route.input.userId,orgId,draft.workDate,draft.requestedInAt,draft.requestedOutAt,draft.reason,
      approvalId,approvalPayload.workflowKey,JSON.stringify(draft.metadata)])
    await trx.query(`INSERT INTO attendance_business_trip_requests
      (request_id,org_id,user_id,approval_instance_id,destination_timezone,start_at,end_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [requestId,orgId,route.input.userId,approvalId,route.input.destinationTimezone,route.input.startAt,route.input.endAt])
    const snapshot = await appendSnapshot(trx, { orgId, requestId, requestType: 'business_trip', subjectUserId: route.input.userId,
      actorUserId: route.actorId, payloadFields: snapshotFields(draft,draft.metadata),
      resolveSnapshots: () => snapshotMaterial(trx, { orgId, userId: route.input.userId, workDate: draft.workDate }) })
    const token = snapshotToken(snapshot)
    return { response: { ok: true, data: { request: mapRequest(rows[0]), businessTrip: service.map(await service.detail(trx,orgId,requestId)),
      ...(token ? { requestSnapshot: token } : {}) } }, resolvedRequestId: requestId,
    lifecycleEvents: [{ eventKind: 'attendance.requested', payload: { orgId,userId:route.input.userId,workDate:draft.workDate,requestType:'business_trip',requestId } }] }
  }
  return { prepareIdentity: async (_trx, raw) => identity(raw), prepare, execute }
}

module.exports = { createBusinessTripRequestAdapter }
