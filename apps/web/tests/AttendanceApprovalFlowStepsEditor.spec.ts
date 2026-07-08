import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'

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
type AttendanceApprovalStep = import('../src/views/attendance/attendanceApprovalSteps').AttendanceApprovalStep

const tr = (en: string, zh: string) => zh || en

let app: App | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (app) app.unmount()
  if (container) container.remove()
  app = null
  container = null
})

function mountEditor(initial: AttendanceApprovalStep[]) {
  const model = ref<AttendanceApprovalStep[]>(initial)
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(defineComponent({
    setup() {
      return () => h(AttendanceApprovalFlowStepsEditor, {
        modelValue: model.value,
        tr,
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
    // the freshly added step has no approver → warning surfaces
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
    // The delegated attendance admin can call /api/attendance-admin/users/search
    // (rbacGuard attendance:admin), which /api/admin/users (ensurePlatformAdmin)
    // would 403 for.
    expect(capturedPickerEndpoints).toContain('/api/attendance-admin/users/search')
    expect(capturedPickerEndpoints).not.toContain('/api/admin/users')
  })

  it('clears a pending role draft when a step is removed, so Enter cannot add it to the wrong step — review P3', async () => {
    const { model, get } = mountEditor([
      { name: 'L1', approverRoleIds: ['manager'] },
      { name: 'L2', approverRoleIds: ['hr'] },
    ])
    // type a draft into step 2's role input without pressing Enter
    const roleInputs = get().querySelectorAll('.approval-steps__col:last-child input')
    const step2Input = roleInputs[1] as HTMLInputElement
    step2Input.value = 'oops'
    step2Input.dispatchEvent(new Event('input'))
    await nextTick()
    // remove step 1 → step 2 shifts to index 0; the draft must not survive to be
    // committed against the shifted step
    const removeButtons = get().querySelectorAll('.approval-steps__reorder .attendance__btn--danger')
    ;(removeButtons[0] as HTMLButtonElement).click()
    await nextTick()
    expect(model.value).toHaveLength(1)
    const remainingRoleInput = get().querySelector('.approval-steps__col:last-child input') as HTMLInputElement
    expect(remainingRoleInput.value).toBe('')
    remainingRoleInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await nextTick()
    // the surviving step keeps only its own role — no 'oops' leaked in
    expect(model.value[0].approverRoleIds).toEqual(['hr'])
  })

  it('preserves unknown keys on an existing step through edits', async () => {
    const { model, get } = mountEditor([{ name: 'L1', approverRoleIds: ['manager'], mode: 'all' } as AttendanceApprovalStep])
    // rename via the step-name input
    const nameInput = get().querySelector('.approval-steps__item input[type="text"]') as HTMLInputElement
    nameInput.value = 'Renamed'
    nameInput.dispatchEvent(new Event('input'))
    await nextTick()
    expect(model.value[0].name).toBe('Renamed')
    expect((model.value[0] as Record<string, unknown>).mode).toBe('all')
  })
})
