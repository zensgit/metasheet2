import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import {
  ATTENDANCE_DYNAMIC_STEP_KINDS,
  stepsPreviewJson,
  toPayloadSteps,
  type AttendanceApprovalStep,
} from '../src/views/attendance/attendanceApprovalSteps'

// Stub the user picker (its own composable hits the users API) — emit a chosen
// user id on demand via a button so the editor's add-user path is exercised.
const capturedPickerEndpoints: Array<string | undefined> = []
const UserPickerStub = defineComponent({
  props: { modelValue: { type: String, default: '' }, endpoint: { type: String, default: undefined } },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    capturedPickerEndpoints.push(props.endpoint)
    return () => h('button', {
      class: 'user-picker-stub',
      onClick: () => emit('update:modelValue', 'u-picked'),
    }, 'pick user')
  },
})

vi.mock('../src/views/attendance/AttendanceUserPickerField.vue', () => ({ default: UserPickerStub }))

const AttendanceApprovalFlowStepsEditor = (await import('../src/views/attendance/AttendanceApprovalFlowStepsEditor.vue')).default

const tr = (en: string, zh: string) => zh || en

let app: App | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (app) app.unmount()
  if (container) container.remove()
  app = null
  container = null
})

function mountEditor(
  initial: AttendanceApprovalStep[],
  extras: {
    maxManagerChainLevels?: number | null
  } = {},
) {
  const model = ref<AttendanceApprovalStep[]>(initial)
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(defineComponent({
    setup() {
      return () => h(AttendanceApprovalFlowStepsEditor, {
        modelValue: model.value,
        tr,
        maxManagerChainLevels: extras.maxManagerChainLevels,
        'onUpdate:modelValue': (v: AttendanceApprovalStep[]) => { model.value = v },
      })
    },
  }))
  app.mount(container)
  return { model, get: () => container! }
}

describe('AttendanceApprovalFlowStepsEditor', () => {
  it('adds a step and shows the empty-approver warning', async () => {
    const { model, get } = mountEditor([])
    expect(get().querySelector('[data-testid="attendance-approval-step"]')).toBeNull()
    ;(get().querySelector('[data-testid="attendance-approval-add-step"]') as HTMLButtonElement).click()
    await nextTick()
    expect(model.value).toHaveLength(1)
    await nextTick()
    expect(get().querySelector('[data-testid="attendance-approval-step-warning"]')).toBeTruthy()
  })

  it('adds an approver role via the chip input and clears the empty warning', async () => {
    const { model, get } = mountEditor([{ name: 'L1', approverUserIds: [], approverRoleIds: [] }])
    const roleInput = get().querySelector('.approval-steps__col:last-child input') as HTMLInputElement
    roleInput.value = 'manager, hr'
    roleInput.dispatchEvent(new Event('input'))
    roleInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await nextTick()
    expect(model.value[0].approverRoleIds).toEqual(['manager', 'hr'])
    await nextTick()
    expect(get().querySelector('[data-testid="attendance-approval-step-warning"]')).toBeNull()
  })

  it('removes a step', async () => {
    const { model, get } = mountEditor([{ name: 'L1', approverRoleIds: ['manager'] }, { name: 'L2', approverRoleIds: ['hr'] }])
    const removeButtons = get().querySelectorAll('.approval-steps__reorder .attendance__btn--danger')
    ;(removeButtons[0] as HTMLButtonElement).click()
    await nextTick()
    expect(model.value).toHaveLength(1)
    expect(model.value[0].name).toBe('L2')
  })

  it('points the approver user picker at the attendance-scoped search (not platform /api/admin/users) — review P2', () => {
    capturedPickerEndpoints.length = 0
    mountEditor([{ name: 'L1', approverRoleIds: ['manager'] }])
    expect(capturedPickerEndpoints).toContain('/api/attendance-admin/users/search')
    expect(capturedPickerEndpoints).not.toContain('/api/admin/users')
  })

  it('clears a pending role draft when steps reorder, so Enter cannot add it to the wrong step — review P3', async () => {
    const { model, get } = mountEditor([
      { name: 'L1', approverRoleIds: ['manager'] },
      { name: 'L2', approverRoleIds: ['hr'] },
    ])
    const roleInputs = get().querySelectorAll('.approval-steps__col:last-child input')
    const step2Input = roleInputs[1] as HTMLInputElement
    step2Input.value = 'oops'
    step2Input.dispatchEvent(new Event('input'))
    await nextTick()
    const upButtons = Array.from(get().querySelectorAll('.approval-steps__reorder .attendance__btn'))
      .filter(b => b.textContent?.includes('↑'))
    ;(upButtons[1] as HTMLButtonElement).click()
    await nextTick()
    expect(model.value.map(s => s.name)).toEqual(['L2', 'L1'])
    const afterInputs = get().querySelectorAll('.approval-steps__col:last-child input')
    ;(afterInputs[1] as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await nextTick()
    expect(model.value[1].approverRoleIds).toEqual(['manager'])
    expect(model.value[0].approverRoleIds).toEqual(['hr'])
  })

  it('preserves unknown keys on an existing step through edits', async () => {
    const { model, get } = mountEditor([{ name: 'L1', approverRoleIds: ['manager'], mode: 'all' } as AttendanceApprovalStep])
    const nameInput = get().querySelector('.approval-steps__item input[type="text"]') as HTMLInputElement
    nameInput.value = 'Renamed'
    nameInput.dispatchEvent(new Event('input'))
    await nextTick()
    expect(model.value[0].name).toBe('Renamed')
    expect((model.value[0] as Record<string, unknown>).mode).toBe('all')
  })

  // ── S7-5 load-bearing mutation evidence ──────────────────────────────────

  it('S7-5: kind selector offers exactly static + three dynamic kinds and never continuous_managers', () => {
    const { get } = mountEditor([{ name: 'L1', approverRoleIds: ['manager'] }], { maxManagerChainLevels: 10 })
    const select = get().querySelector('[data-testid="attendance-approval-step-kind"]') as HTMLSelectElement
    expect(select).toBeTruthy()
    const values = Array.from(select.options).map(o => o.value)
    expect(values).toContain('static')
    for (const kind of ATTENDANCE_DYNAMIC_STEP_KINDS) {
      expect(values).toContain(kind)
    }
    expect(values).not.toContain('continuous_managers')
  })

  it('S7-5: switching static→direct_manager clears static approver arrays in the model', async () => {
    const { model, get } = mountEditor(
      [{ name: 'L1', approverUserIds: ['u1'], approverRoleIds: ['manager'] }],
      { maxManagerChainLevels: 10 },
    )
    const select = get().querySelector('[data-testid="attendance-approval-step-kind"]') as HTMLSelectElement
    select.value = 'direct_manager'
    select.dispatchEvent(new Event('change'))
    await nextTick()
    expect(model.value[0].kind).toBe('direct_manager')
    expect(model.value[0].approverUserIds).toBeUndefined()
    expect(model.value[0].approverRoleIds).toBeUndefined()
    expect(get().querySelector('[data-testid="attendance-approval-step-users"]')).toBeNull()
    expect(toPayloadSteps(model.value)[0]).toEqual({ name: 'L1', kind: 'direct_manager' })
  })

  it('S7-5: manager_at_level option is disabled while host max is unknown; persisted content stays visible', async () => {
    const { model, get } = mountEditor(
      [{ name: 'L', kind: 'manager_at_level', level: 3 }],
      { maxManagerChainLevels: null },
    )
    const select = get().querySelector('[data-testid="attendance-approval-step-kind"]') as HTMLSelectElement
    const malOption = Array.from(select.options).find(o => o.value === 'manager_at_level')
    expect(malOption?.disabled).toBe(true)

    const levelInput = get().querySelector('[data-testid="attendance-approval-step-level"]') as HTMLInputElement
    expect(levelInput).toBeTruthy()
    expect(levelInput.disabled).toBe(true)
    // Persisted level is shown as-is (not rewritten to 1)
    expect(levelInput.value).toBe('3')
    expect(model.value[0].level).toBe(3)
    expect(get().querySelector('[data-testid="attendance-approval-step-level-waiting"]')).toBeTruthy()

    // Mutation: selecting manager_at_level on a static step while max unknown is a no-op
    const staticMount = mountEditor(
      [{ name: 'S', approverRoleIds: ['manager'] }],
      { maxManagerChainLevels: null },
    )
    const staticSelect = staticMount.get().querySelector('[data-testid="attendance-approval-step-kind"]') as HTMLSelectElement
    staticSelect.value = 'manager_at_level'
    staticSelect.dispatchEvent(new Event('change'))
    await nextTick()
    expect(staticMount.model.value[0].kind).toBeUndefined()
    expect(staticMount.model.value[0].approverRoleIds).toEqual(['manager'])
  })

  it('S7-5: with host max known, level input stores raw out-of-range/fractional values (no clamp/trunc)', async () => {
    const { model, get } = mountEditor(
      [{ name: 'L1', approverRoleIds: ['manager'] }],
      { maxManagerChainLevels: 5 },
    )
    const select = get().querySelector('[data-testid="attendance-approval-step-kind"]') as HTMLSelectElement
    select.value = 'manager_at_level'
    select.dispatchEvent(new Event('change'))
    await nextTick()
    expect(model.value[0].level).toBe(1) // intentional init on user switch only

    const levelInput = get().querySelector('[data-testid="attendance-approval-step-level"]') as HTMLInputElement
    expect(levelInput.max).toBe('5')
    expect(levelInput.disabled).toBe(false)

    levelInput.value = '99'
    levelInput.dispatchEvent(new Event('input'))
    await nextTick()
    // NOT clamped to 5 — backend authoring gate must see MAX+1
    expect(model.value[0].level).toBe(99)
    expect(toPayloadSteps(model.value)[0].level).toBe(99)

    levelInput.value = '2.5'
    levelInput.dispatchEvent(new Event('input'))
    await nextTick()
    // NOT Math.trunc'd
    expect(model.value[0].level).toBe(2.5)
    expect(toPayloadSteps(model.value)[0].level).toBe(2.5)
  })

  it('S7-5 P3: editor does NOT render the directory warning (parent owns the single surface)', async () => {
    const { get } = mountEditor(
      [{ name: 'DM', kind: 'direct_manager' }],
      { maxManagerChainLevels: 10 },
    )
    // Mutation evidence: re-adding the in-editor warning would make this fail.
    expect(get().querySelector('[data-testid="attendance-approval-directory-warning"]')).toBeNull()
  })

  it('S7-5: unsupported persisted kind is preserved and not silently rewritten', async () => {
    const { model, get } = mountEditor([
      { name: 'chain', kind: 'continuous_managers', levels: 3 } as AttendanceApprovalStep,
    ], { maxManagerChainLevels: 10 })
    expect(get().querySelector('[data-testid="attendance-approval-step-unsupported"]')).toBeTruthy()
    const nameInput = get().querySelector('.approval-steps__item input[type="text"]') as HTMLInputElement
    nameInput.value = 'Still chain'
    nameInput.dispatchEvent(new Event('input'))
    await nextTick()
    expect(model.value[0].kind).toBe('continuous_managers')
    expect((model.value[0] as Record<string, unknown>).levels).toBe(3)
    expect(toPayloadSteps(model.value)[0].kind).toBe('continuous_managers')
    expect(JSON.parse(stepsPreviewJson(model.value))[0].kind).toBe('continuous_managers')
  })

  it('S7-5: mixed kind+arrays is not silently cleaned by the editor on load', async () => {
    const { model, get } = mountEditor([
      { name: 'mixed', kind: 'dept_head', approverUserIds: ['u1'] } as AttendanceApprovalStep,
    ], { maxManagerChainLevels: 10 })
    // Kind selector shows dept_head; static pickers hidden (not editable static)
    const select = get().querySelector('[data-testid="attendance-approval-step-kind"]') as HTMLSelectElement
    expect(select.value).toBe('dept_head')
    expect(get().querySelector('[data-testid="attendance-approval-step-users"]')).toBeNull()
    // Payload still carries the mixed arrays — backend will 422 STATIC_DYNAMIC_MIXED
    expect(toPayloadSteps(model.value)[0].approverUserIds).toEqual(['u1'])
    expect(toPayloadSteps(model.value)[0].kind).toBe('dept_head')
  })
})
