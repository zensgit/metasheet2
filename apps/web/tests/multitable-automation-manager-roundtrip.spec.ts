/**
 * 回归用例：多维表自动化「列表 GET → 管理器 → 规则编辑器 → 未改动保存」往返必须原样保留未建模的
 * action config 键。
 *
 * WHAT IT GUARDS (#5739 泛化 / #5756): a rule whose stored `actions[0].config` carries a key the
 * editor does not model — an out-of-band write, a newer host, a customer extension — must survive an
 * UNTOUCHED 保存 verbatim in BOTH halves of the PATCH body: the V1 `actions[]` AND the legacy
 * `actionConfig` mirror the same body still sends. parseUpdateRuleInput takes both verbatim, so a
 * mirror rebuilt without the key silently loses it on every host that reads `action_config`.
 *
 * WHY THE EDITOR-ONLY SPEC IS NOT ENOUGH: tests/multitable-automation-rule-editor.spec.ts mounts
 * MetaAutomationRuleEditor with a HAND-BUILT `rule` prop, so it starts DOWNSTREAM of every place the
 * key can actually be lost — the list GET's normalization inside MultitableApiClient
 * (`listAutomationRules`), `useMultitableAutomations`, and MetaAutomationManager's rule→editor
 * hand-off. #5756 fixed the editor and proved it with exactly such fixtures; this file proves the
 * REAL chain instead, end to end:
 *
 *   GET …/automations (captured fetchFn, REAL MultitableApiClient)
 *     → listAutomationRules → useMultitableAutomations.rules
 *     → MetaAutomationManager 卡片「编辑」 → MetaAutomationRuleEditor
 *     → 未改动「保存」 → captured PATCH body
 *
 * Every fixture below ships a STALE legacy `actionConfig` mirror that does NOT contain the key (the
 * on-prem shape an out-of-band write produces). Any step that rebuilds the rule from that mirror
 * instead of from `actions[]` therefore turns this file RED.
 *
 * COVERAGE: the 12 action types the editor can round-trip, the template-routed `approval.completed`
 * trigger shape reported from site (trigger config + notification action + a loaded approval-template
 * roster), and ONE case that pins CURRENT behaviour for a non-array `actions` — that last one is a
 * DOCUMENTED GAP, not a guarantee; when a fix lands, invert it deliberately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

const routerPushMock = vi.hoisted(() => vi.fn())

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: routerPushMock,
  }),
}))

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

import MetaAutomationManager from '../src/multitable/components/MetaAutomationManager.vue'
import { MultitableApiClient } from '../src/multitable/api/client'
import { useLocale } from '../src/composables/useLocale'

/** The unmodelled key under test: no editor branch owns it, so only verbatim pass-through keeps it. */
const EXTENSION_KEY = 'x_customerExtension'
const EXTENSION_VALUE = { n: 42, nested: true }

const fields = [
  { id: 'fld_1', name: 'Status', type: 'select' },
  { id: 'fld_2', name: 'Name', type: 'string' },
]

const views = [
  { id: 'view_grid', sheetId: 'sheet_1', name: 'Grid', type: 'grid' },
  {
    id: 'view_form',
    sheetId: 'sheet_1',
    name: 'Public Form',
    type: 'form',
    config: { publicForm: { enabled: true, publicToken: 'pub_view_form' } },
  },
]

type Action = { type: string; config: Record<string, unknown> }

type PatchBody = {
  triggerType?: string
  triggerConfig?: Record<string, unknown>
  actions?: Array<{ type: string; config: Record<string, unknown> }>
  actionConfig?: Record<string, unknown>
}

type ClientOptions = {
  /** Roster served by GET /api/approval-templates; defaults to EMPTY (the free-text-id fallback). */
  approvalTemplates?: Array<{ id: string; name?: string }>
}

type RoundTripOptions = ClientOptions & {
  /** Runs on the OPEN editor, before 保存 — for assertions about what the author actually sees. */
  onEditorOpen?: (root: Document) => void
}

/**
 * One rule exactly as a host hands it back: the V1 `actions[]` is authoritative and carries the
 * unmodelled key, while the legacy `actionConfig`/`actionType` mirror on the same row is STALE.
 */
function liveRulePayload(action: Action, legacyMirror: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id: 'rule_1',
    sheetId: 'sheet_1',
    name: 'Live rule',
    triggerType: 'record.created',
    triggerConfig: {},
    actions: [action],
    actionType: action.type,
    actionConfig: legacyMirror,
    enabled: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...extra,
  }
}

function mockClient(rulePayload: Record<string, unknown>, options: ClientOptions = {}) {
  const patchBodies: Array<PatchBody> = []
  const ok = (body: unknown) => new Response(
    JSON.stringify({ data: body }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
  const noContent = () => new Response(null, { status: 204 })

  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = url.split('?')[0]
    if (method === 'GET' && url.includes('/dingtalk-groups')) {
      return ok({
        destinations: [
          {
            id: 'dt_1',
            name: 'Ops Group',
            webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=test',
            enabled: true,
            sheetId: 'sheet_1',
            createdBy: 'user_1',
            createdAt: '2026-04-01T00:00:00Z',
          },
        ],
      })
    }
    // The editor's approval-template picker (client.listApprovalTemplates). Matched on the EXACT
    // path so the per-template detail route (…/:id, used by the FWB template source loader) still
    // falls through to the generic empty answer below.
    if (method === 'GET' && path === '/api/approval-templates') {
      return ok(options.approvalTemplates ?? [])
    }
    if (method === 'GET' && url.includes('/automations')) {
      if (url.includes('/dingtalk-group-deliveries')) return ok({ deliveries: [] })
      if (url.includes('/dingtalk-person-deliveries')) return ok({ deliveries: [] })
      if (url.endsWith('/stats')) return ok({ total: 0, success: 0, failed: 0, skipped: 0, avgDuration: 0 })
      return ok({ rules: [rulePayload] })
    }
    if (method === 'PATCH' && url.includes('/automations/')) {
      patchBodies.push(JSON.parse(init?.body as string))
      return noContent()
    }
    return ok({})
  })

  const client = new MultitableApiClient({ fetchFn })
  client.listFormShareCandidates = vi.fn(async () => ({
    items: [
      {
        subjectType: 'user' as const,
        subjectId: 'user_1',
        label: 'Lin Lan',
        subtitle: 'lin@example.com',
        isActive: true,
        dingtalkBound: true,
        dingtalkGrantEnabled: true,
        dingtalkPersonDeliveryAvailable: true,
      },
    ],
    total: 1,
    limit: 8,
    query: '',
  }))
  return { client, patchBodies }
}

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaAutomationManager, props) })
  app.mount(container)
  return { container, app }
}

/** 列表加载 → 卡片「编辑」(full editor) → 未改动「保存」, returning every captured PATCH body. */
async function editAndSaveUntouched(rulePayload: Record<string, unknown>, options: RoundTripOptions = {}) {
  const { client, patchBodies } = mockClient(rulePayload, options)
  const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
  await flushPromises()
  const editBtn = container.querySelector('[data-automation-edit="true"]') as HTMLButtonElement
  expect(editBtn).toBeTruthy()
  editBtn.click()
  await flushPromises()
  await flushPromises()
  options.onEditorOpen?.(document)
  const saveBtn = document.querySelector('[data-action="save"]') as HTMLButtonElement
  expect(saveBtn).toBeTruthy()
  expect(saveBtn.disabled).toBe(false)
  saveBtn.click()
  await flushPromises()
  await flushPromises()
  return patchBodies
}

/** Both halves of the PATCH body must carry the unmodelled key (see the file header for why). */
function expectExtensionKeyPreserved(patchBodies: Array<PatchBody>) {
  expect(patchBodies).toHaveLength(1)
  const body = patchBodies[0]
  // 1) the V1 action config still carries the unmodelled key …
  expect(body.actions?.[0]?.config).toMatchObject({ [EXTENSION_KEY]: EXTENSION_VALUE })
  // 2) … and so does the legacy mirror the same body sends (parseUpdateRuleInput takes BOTH
  //    verbatim, so a mirror without the key loses it on hosts that read action_config).
  expect(body.actionConfig).toMatchObject({ [EXTENSION_KEY]: EXTENSION_VALUE })
}

describe('MetaAutomationManager → rule editor → save round-trip (real list GET → PATCH chain)', () => {
  beforeEach(() => {
    useLocale().setLocale('en')
    routerPushMock.mockClear()
  })

  afterEach(() => {
    useLocale().setLocale('en')
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  // The exact on-prem shape: send_notification, single action, extension key in actions[0].config only.
  it('send_notification: keeps an unmodelled action config key on 编辑 → 未改动保存 when the legacy actionConfig mirror is stale', async () => {
    const patchBodies = await editAndSaveUntouched(liveRulePayload(
      { type: 'send_notification', config: { message: 'New record!', userIds: ['user_1'], [EXTENSION_KEY]: { ...EXTENSION_VALUE } } },
      { message: 'New record!', userIds: ['user_1'] },
    ))
    expectExtensionKeyPreserved(patchBodies)
  })

  // Same question for every action type the editor can round-trip: does the manager-level chain ever
  // rebuild the rule from the stale mirror instead of actions[]?
  const matrix: Array<{ name: string; action: Action; mirror: Record<string, unknown>; extra?: Record<string, unknown> }> = [
    {
      name: 'notify (alias inside actions[])',
      action: { type: 'notify', config: { message: 'New record!', userIds: ['user_1'], [EXTENSION_KEY]: { ...EXTENSION_VALUE } } },
      mirror: { message: 'New record!' },
    },
    {
      name: 'update_record',
      action: { type: 'update_record', config: { fields: { fld_1: 'done' }, [EXTENSION_KEY]: { ...EXTENSION_VALUE } } },
      mirror: { fields: { fld_1: 'done' } },
    },
    {
      name: 'create_record',
      action: { type: 'create_record', config: { sheetId: 'sheet_2', data: { fld_2: 'x' }, [EXTENSION_KEY]: { ...EXTENSION_VALUE } } },
      mirror: { sheetId: 'sheet_2', data: { fld_2: 'x' } },
    },
    {
      name: 'send_webhook (passthrough)',
      action: { type: 'send_webhook', config: { url: 'https://example.com/hook', method: 'POST', [EXTENSION_KEY]: { ...EXTENSION_VALUE } } },
      mirror: { url: 'https://example.com/hook', method: 'POST' },
    },
    {
      name: 'lock_record (passthrough)',
      action: { type: 'lock_record', config: { locked: true, [EXTENSION_KEY]: { ...EXTENSION_VALUE } } },
      mirror: { locked: true },
    },
    {
      name: 'delete_record',
      action: { type: 'delete_record', config: { [EXTENSION_KEY]: { ...EXTENSION_VALUE } } },
      mirror: {},
    },
    {
      name: 'send_email',
      action: { type: 'send_email', config: { recipients: ['a@b.c'], subjectTemplate: 's', bodyTemplate: 'b', [EXTENSION_KEY]: { ...EXTENSION_VALUE } } },
      mirror: { recipients: ['a@b.c'], subjectTemplate: 's', bodyTemplate: 'b' },
    },
    {
      name: 'send_dingtalk_group_message',
      action: {
        type: 'send_dingtalk_group_message',
        config: { destinationIds: ['dt_1'], titleTemplate: 't', bodyTemplate: 'b', [EXTENSION_KEY]: { ...EXTENSION_VALUE } },
      },
      mirror: { destinationIds: ['dt_1'], titleTemplate: 't', bodyTemplate: 'b' },
    },
    {
      name: 'send_dingtalk_person_message',
      action: {
        type: 'send_dingtalk_person_message',
        config: { userIds: ['user_1'], titleTemplate: 't', bodyTemplate: 'b', [EXTENSION_KEY]: { ...EXTENSION_VALUE } },
      },
      mirror: { userIds: ['user_1'], titleTemplate: 't', bodyTemplate: 'b' },
    },
    {
      name: 'start_approval',
      action: {
        type: 'start_approval',
        config: { templateId: 'tpl_1', formDataMapping: { a: 'record.fld_2' }, [EXTENSION_KEY]: { ...EXTENSION_VALUE } },
      },
      mirror: { templateId: 'tpl_1', formDataMapping: { a: 'record.fld_2' } },
      extra: { executionMode: 'workflow_job_v1' },
    },
    {
      name: 'wait_for_callback (passthrough)',
      action: { type: 'wait_for_callback', config: { reason: 'r', [EXTENSION_KEY]: { ...EXTENSION_VALUE } } },
      mirror: { reason: 'r' },
      extra: { executionMode: 'workflow_job_v1' },
    },
  ]

  for (const entry of matrix) {
    it(`${entry.name}: keeps the unmodelled config key through 列表 GET → 编辑 → 未改动保存`, async () => {
      const patchBodies = await editAndSaveUntouched(liveRulePayload(entry.action, entry.mirror, entry.extra ?? {}))
      expectExtensionKeyPreserved(patchBodies)
    })
  }

  // The on-prem shape reported from site: the T1-3 template-routed approval-completion trigger with a
  // multi-outcome triggerConfig and a notification action (the only action family that trigger admits).
  // The approval-template roster is served here (GET /api/approval-templates) so the editor opens with
  // the real picker rather than its free-text-id fallback — the picker's own v-model writes to
  // draft.triggerConfig.templateId, which is the nearest place a hydrate/save round-trip could mutate
  // the rule out from under an untouched save.
  it('approval.completed: keeps the unmodelled config key on a notification action with a loaded template roster', async () => {
    const patchBodies = await editAndSaveUntouched(
      liveRulePayload(
        { type: 'send_notification', config: { message: '审批已完成', userIds: ['user_1'], [EXTENSION_KEY]: { ...EXTENSION_VALUE } } },
        { message: '审批已完成', userIds: ['user_1'] },
        {
          triggerType: 'approval.completed',
          triggerConfig: { outcomes: ['approved', 'rejected'], templateId: 'tpl_1' },
        },
      ),
      {
        approvalTemplates: [{ id: 'tpl_1', name: '备料送审示例' }],
        onEditorOpen: (root) => {
          // Proof the roster above is load-bearing, not decoration: with templates loaded the editor
          // renders the el-select PICKER bound to draft.triggerConfig.templateId; with an empty roster
          // the same data-field renders the free-text <input> fallback instead.
          const templateField = root.querySelector('[data-field="approvalCompletedTemplateId"]')
          expect(templateField).toBeTruthy()
          expect(templateField?.classList.contains('el-select')).toBe(true)
        },
      },
    )
    expectExtensionKeyPreserved(patchBodies)
    // The trigger itself must survive the same untouched save: a dropped templateId or a collapsed
    // outcome list would leave a rule that never fires, which no action-config assertion would catch.
    expect(patchBodies[0].triggerType).toBe('approval.completed')
    expect(patchBodies[0].triggerConfig).toMatchObject({ templateId: 'tpl_1', outcomes: ['approved', 'rejected'] })
  })

  // THE ONE frontend shape that does produce the reported symptom, pinned as CURRENT behaviour so the
  // blast radius is documented: when `actions` is not a JS array (e.g. a host/driver that hands the
  // jsonb column back as a JSON STRING), client.ts:504 drops it to `undefined` with no signal, the
  // editor's draftFromRule (MetaAutomationRuleEditor.vue:3180) silently falls back to the STALE legacy
  // mirror, and the untouched save re-emits `actions` rebuilt from that mirror — which the server takes
  // verbatim (automation-service.ts:4413), overwriting the good stored actions.
  it('DOCUMENTED GAP (pinned current behaviour): a non-array `actions` (JSON string) makes the untouched save rebuild from the stale mirror', async () => {
    const payload = liveRulePayload(
      { type: 'send_notification', config: { message: 'New record!', userIds: ['user_1'], [EXTENSION_KEY]: { ...EXTENSION_VALUE } } },
      { message: 'New record!', userIds: ['user_1'] },
    ) as Record<string, unknown>
    payload.actions = JSON.stringify(payload.actions)
    const patchBodies = await editAndSaveUntouched(payload)
    expect(patchBodies).toHaveLength(1)
    expect(patchBodies[0].actions?.[0]?.config).not.toHaveProperty(EXTENSION_KEY)
    expect(patchBodies[0].actionConfig).not.toHaveProperty(EXTENSION_KEY)
  })
})
