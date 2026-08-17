/**
 * F3 mounted inspector spec (delta §3.4, FB-D6/FB-D7, Gate F3) — the NEW
 * Designer 2.0 `ApprovalFormFieldInspector.vue`: committed-edit-only history
 * (text on blur/Enter, select/toggle on change, one logical option/detail row
 * action = one command), per-keystroke commands FORBIDDEN, dirty-buffer
 * settlement (commit-as-one vs block-on-invalid), named values-free refusal
 * copy with business dependency labels, option-value preservation, and the
 * no-raw-ID surface. Mount pattern: repo-standard `createApp` + real DOM
 * events (no test-utils). Commands run through a REAL adapter session via the
 * same seam shape the builder uses, with every executed command recorded.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { computed, createApp, h, nextTick, ref, shallowRef, type App as VueApp } from 'vue'

import ApprovalFormFieldInspector, {
  DEPENDENCY_KIND_BUSINESS_LABELS,
  INSPECTOR_INVALID_BUFFER_MESSAGE,
  INSPECTOR_LAST_DETAIL_COLUMN_MESSAGE,
  INSPECTOR_LAST_FIELD_MESSAGE,
  INSPECTOR_RETYPE_REFUSAL_PREFIX,
  type FormFieldInspectorCommand,
} from '../src/approvals/components/ApprovalFormFieldInspector.vue'
import {
  createFormAuthoringAdapter,
  type FormAdapterResult,
  type FormAuthoringSession,
} from '../src/approvals/approvalFormAuthoringAdapter'
import {
  createEmptyFieldDraft,
  createEmptyStepDraft,
  createEmptyTemplateDraft,
  type FieldAuthoringDraft,
  type TemplateAuthoringDraft,
} from '../src/approvals/templateAuthoring'
import type { DetailColumnDraft } from '../src/approvals/detailField'

// --- fixtures ---------------------------------------------------------------

function field(
  index: number,
  overrides: Partial<FieldAuthoringDraft> = {},
): FieldAuthoringDraft {
  return {
    ...createEmptyFieldDraft(index),
    localId: `local_${index}`,
    id: `field_${index}`,
    label: `字段 ${index}`,
    ...overrides,
  }
}

function column(
  index: number,
  overrides: Partial<DetailColumnDraft> = {},
): DetailColumnDraft {
  return {
    localId: `col_local_${index}`,
    id: `col_${index}`,
    type: 'text',
    label: `子字段 ${index}`,
    required: false,
    optionsText: '',
    ...overrides,
  }
}

function draftWith(fields: FieldAuthoringDraft[]): TemplateAuthoringDraft {
  return {
    ...createEmptyTemplateDraft(),
    key: 'form_inspector',
    name: '字段设置面板',
    fields,
    steps: [createEmptyStepDraft(1)],
  }
}

// --- mount harness ----------------------------------------------------------

interface InspectorExposed {
  settlePendingEdits(): boolean
  isDirty(): boolean
}

interface InspectorHarness {
  root: HTMLElement
  commands: FormFieldInspectorCommand[]
  session(): FormAuthoringSession
  selectField(localId: string | null): Promise<void>
  vm: InspectorExposed
  q(selector: string): HTMLElement
  input(testid: string): HTMLInputElement
  select(testid: string): HTMLSelectElement
  status(): string
  typeText(testid: string, value: string): Promise<void>
  blur(testid: string): Promise<void>
  pressEnter(testid: string): Promise<void>
  changeSelect(testid: string, value: string): Promise<void>
  toggle(testid: string): Promise<void>
  unmount(): void
}

const mounted: { app: VueApp<Element>; container: HTMLDivElement }[] = []

async function mountInspector(
  fields: FieldAuthoringDraft[],
  options: {
    selected?: string | null
    readOnly?: boolean
    optionValueFactory?: () => string
    /** Force every executed command to this failure (for canned refusals). */
    executeOverride?: (command: FormFieldInspectorCommand) => FormAdapterResult | null
  } = {},
): Promise<InspectorHarness> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const adapter = createFormAuthoringAdapter()
  const sessionRef = shallowRef(adapter.startSession(draftWith(fields)))
  const selectedLocalId = ref<string | null>(
    options.selected === undefined ? fields[0]?.localId ?? null : options.selected,
  )
  const commands: FormFieldInspectorCommand[] = []
  const exposedRef = ref<InspectorExposed | null>(null)

  function runCommand(command: FormFieldInspectorCommand): FormAdapterResult | null {
    commands.push(command)
    if (options.executeOverride) return options.executeOverride(command)
    const session = sessionRef.value
    let result: FormAdapterResult
    switch (command.kind) {
      case 'update-properties':
        result = adapter.updateFieldProperties(session, command.localId, command.patch)
        break
      case 'retype':
        result = adapter.retypeField(session, command.localId, command.nextType)
        break
      case 'remove-field':
        result = adapter.removeField(session, command.localId)
        break
      case 'add-detail-column':
        result = adapter.addDetailColumn(session, command.fieldLocalId)
        break
      case 'update-detail-column':
        result = adapter.updateDetailColumn(
          session,
          command.fieldLocalId,
          command.columnLocalId,
          command.patch,
        )
        break
      case 'retype-detail-column':
        result = adapter.retypeDetailColumn(
          session,
          command.fieldLocalId,
          command.columnLocalId,
          command.nextType,
        )
        break
      case 'remove-detail-column':
        result = adapter.removeDetailColumn(
          session,
          command.fieldLocalId,
          command.columnLocalId,
        )
        break
    }
    if (result.ok) {
      sessionRef.value = result.session
      selectedLocalId.value = result.focusLocalId
    }
    return result
  }

  const selectedField = computed(
    () =>
      sessionRef.value.draft.fields.find(
        (candidate) => candidate.localId === selectedLocalId.value,
      ) ?? null,
  )
  const references = computed(() =>
    selectedLocalId.value
      ? adapter.listFieldReferences(sessionRef.value, selectedLocalId.value)
      : [],
  )
  const visibilityOptions = computed(() => {
    const current = selectedField.value
    if (!current) return []
    return sessionRef.value.draft.fields
      .filter(
        (candidate) =>
          candidate.localId !== current.localId &&
          candidate.id.trim().length > 0 &&
          candidate.type !== 'record-link' &&
          candidate.type !== 'detail',
      )
      .map((candidate) => ({ id: candidate.id.trim(), label: candidate.label }))
  })

  const app = createApp({
    setup() {
      return () =>
        h(ApprovalFormFieldInspector, {
          field: selectedField.value,
          references: references.value,
          visibilityOptions: visibilityOptions.value,
          readOnly: options.readOnly ?? false,
          execute: runCommand,
          optionValueFactory: options.optionValueFactory,
          ref: exposedRef,
        })
    },
  })
  app.mount(container)
  mounted.push({ app, container })
  await nextTick()

  function q(selector: string): HTMLElement {
    const el = container.querySelector(selector)
    if (!el) throw new Error(`selector not rendered: ${selector}`)
    return el as HTMLElement
  }
  const byTestId = (testid: string) => q(`[data-testid="${testid}"]`)

  return {
    root: container,
    commands,
    session: () => sessionRef.value,
    async selectField(localId: string | null) {
      selectedLocalId.value = localId
      await nextTick()
    },
    get vm() {
      return exposedRef.value!
    },
    q,
    input: (testid) => byTestId(testid) as HTMLInputElement,
    select: (testid) => byTestId(testid) as HTMLSelectElement,
    status: () =>
      byTestId('approval-form-field-inspector-status').textContent ?? '',
    async typeText(testid, value) {
      const el = byTestId(testid) as HTMLInputElement
      // Simulate per-keystroke input events (FB-D7: NEVER a command each).
      for (let index = 1; index <= value.length; index += 1) {
        el.value = value.slice(0, index)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      await nextTick()
    },
    async blur(testid) {
      byTestId(testid).dispatchEvent(new Event('blur'))
      await nextTick()
    },
    async pressEnter(testid) {
      byTestId(testid).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
      await nextTick()
    },
    async changeSelect(testid, value) {
      const el = byTestId(testid) as HTMLSelectElement
      el.value = value
      el.dispatchEvent(new Event('change', { bubbles: true }))
      await nextTick()
    },
    async toggle(testid) {
      const el = byTestId(testid) as HTMLInputElement
      el.checked = !el.checked
      el.dispatchEvent(new Event('change', { bubbles: true }))
      await nextTick()
    },
    unmount() {
      app.unmount()
      container.remove()
    },
  }
}

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!
    try {
      entry.app.unmount()
    } catch {
      // already unmounted by the test
    }
    entry.container.remove()
  }
})

// --- surface ----------------------------------------------------------------

describe('ApprovalFormFieldInspector — surface (§3.4)', () => {
  it('renders the empty state without a selection and the read-only note in read-only mode', async () => {
    const empty = await mountInspector([field(1)], { selected: null })
    expect(
      empty.root.querySelector('[data-testid="approval-form-field-inspector-empty"]'),
    ).not.toBeNull()
    expect(empty.root.querySelector('input')).toBeNull()

    const readOnly = await mountInspector([field(1)], { readOnly: true })
    expect(
      readOnly.root.querySelector(
        '[data-testid="approval-form-field-inspector-readonly"]',
      ),
    ).not.toBeNull()
    expect(readOnly.root.querySelector('input')).toBeNull()
    expect(readOnly.root.querySelector('select')).toBeNull()
  })

  it('renders common controls for the selected field with NO raw persistent/local IDs in any copy', async () => {
    const inspector = await mountInspector([
      field(1, { type: 'user' }),
      field(2),
    ])
    expect(inspector.input('approval-form-field-inspector-label').value).toBe('字段 1')
    expect(inspector.select('approval-form-field-inspector-type').value).toBe('user')
    expect(
      inspector.input('approval-form-field-inspector-required').checked,
    ).toBe(false)
    // §8/FB-D6: ordinary-user copy carries no internal identity tokens.
    expect(inspector.root.textContent).not.toMatch(/field_\d|local_\d|fld_|fldloc_/)
  })

  it('the type picker offers EXACTLY the authorable types — attachment is absent (mutation obligation 9)', async () => {
    const inspector = await mountInspector([field(1)])
    const values = Array.from(
      inspector.select('approval-form-field-inspector-type').options,
    ).map((option) => option.value)
    expect(new Set(values)).toEqual(
      new Set([
        'text',
        'textarea',
        'number',
        'date',
        'datetime',
        'select',
        'multi-select',
        'user',
        'detail',
        'record-link',
        // Lock-8 L8-B (approval-lock8-field-vocabulary-20260817.md §1.2).
        'date_range',
      ]),
    )
    expect(values).not.toContain('attachment')
  })

  it('shows the FB-D6 reference summary with business labels only', async () => {
    const inspector = await mountInspector([
      field(1),
      field(2, {
        visibility: { dependsOnFieldId: 'field_1', operator: 'eq', valueText: 'y' },
      }),
    ])
    const summary = inspector.q(
      '[data-testid="approval-form-field-inspector-references"]',
    ).textContent!
    expect(summary).toContain(DEPENDENCY_KIND_BUSINESS_LABELS.visibility_rule)
    expect(summary).not.toMatch(/field_\d|local_\d|fields\./)
  })
})

// --- committed edits (FB-D7) ------------------------------------------------

describe('ApprovalFormFieldInspector — committed edits only (FB-D7)', () => {
  it('typing NEVER issues a command per keystroke; blur commits exactly ONE update with the final text', async () => {
    const inspector = await mountInspector([field(1), field(2)])
    await inspector.typeText('approval-form-field-inspector-label', '采购标题')
    // FB-D7 / mutation obligation 7: zero commands (=> zero history entries)
    // while typing.
    expect(inspector.commands).toHaveLength(0)
    expect(inspector.session().history.undoStack).toHaveLength(0)
    expect(inspector.vm.isDirty()).toBe(true)
    await inspector.blur('approval-form-field-inspector-label')
    expect(inspector.commands).toEqual([
      {
        kind: 'update-properties',
        localId: 'local_1',
        patch: { label: '采购标题' },
      },
    ])
    expect(inspector.session().draft.fields[0].label).toBe('采购标题')
    expect(inspector.session().history.undoStack).toHaveLength(1)
    expect(inspector.vm.isDirty()).toBe(false)
  })

  it('Enter commits the text buffer the same way (one command, one entry)', async () => {
    const inspector = await mountInspector([field(1), field(2)])
    await inspector.typeText('approval-form-field-inspector-placeholder', '请填写')
    expect(inspector.commands).toHaveLength(0)
    await inspector.pressEnter('approval-form-field-inspector-placeholder')
    expect(inspector.commands).toEqual([
      {
        kind: 'update-properties',
        localId: 'local_1',
        patch: { placeholder: '请填写' },
      },
    ])
    expect(inspector.session().history.undoStack).toHaveLength(1)
  })

  it('a value-identical text buffer commits NOTHING on blur', async () => {
    const inspector = await mountInspector([field(1), field(2)])
    await inspector.typeText('approval-form-field-inspector-label', '字段 1')
    await inspector.blur('approval-form-field-inspector-label')
    expect(inspector.commands).toHaveLength(0)
    expect(inspector.session().history.undoStack).toHaveLength(0)
    expect(inspector.vm.isDirty()).toBe(false)
  })

  it('required toggles commit ON CHANGE as one command each', async () => {
    const inspector = await mountInspector([field(1), field(2)])
    await inspector.toggle('approval-form-field-inspector-required')
    expect(inspector.commands).toEqual([
      { kind: 'update-properties', localId: 'local_1', patch: { required: true } },
    ])
    expect(inspector.session().draft.fields[0].required).toBe(true)
    expect(inspector.session().history.undoStack).toHaveLength(1)
  })

  it('visibility rule edits: depends-on and operator commit on change; the value text commits on blur', async () => {
    const inspector = await mountInspector([field(1), field(2)])
    await inspector.changeSelect(
      'approval-form-field-inspector-visibility-depends',
      'field_2',
    )
    expect(inspector.session().draft.fields[0].visibility.dependsOnFieldId).toBe(
      'field_2',
    )
    await inspector.changeSelect(
      'approval-form-field-inspector-visibility-operator',
      'neq',
    )
    expect(inspector.session().draft.fields[0].visibility.operator).toBe('neq')
    await inspector.typeText('approval-form-field-inspector-visibility-value', '是')
    expect(inspector.session().draft.fields[0].visibility.valueText).toBe('')
    await inspector.blur('approval-form-field-inspector-visibility-value')
    expect(inspector.session().draft.fields[0].visibility).toEqual({
      dependsOnFieldId: 'field_2',
      operator: 'neq',
      valueText: '是',
    })
    // Three committed edits → three entries; typing added none.
    expect(inspector.session().history.undoStack).toHaveLength(3)
    // Clearing the dependency resets the rule (commit on change).
    await inspector.changeSelect(
      'approval-form-field-inspector-visibility-depends',
      '',
    )
    expect(inspector.session().draft.fields[0].visibility).toEqual({
      dependsOnFieldId: '',
      operator: 'eq',
      valueText: '',
    })
  })
})

// --- retype through the inspector -------------------------------------------

describe('ApprovalFormFieldInspector — type change is the typed retype command', () => {
  it('an unreferenced field retypes on change: identity preserved, one command', async () => {
    const inspector = await mountInspector([field(1), field(2)])
    await inspector.changeSelect('approval-form-field-inspector-type', 'date')
    expect(inspector.commands).toEqual([
      { kind: 'retype', localId: 'local_1', nextType: 'date' },
    ])
    expect(inspector.session().draft.fields[0]).toMatchObject({
      id: 'field_1',
      localId: 'local_1',
      type: 'date',
    })
    expect(inspector.session().history.undoStack).toHaveLength(1)
  })

  it('a NAMED refusal renders values-free business copy listing the dependency kinds and reverts the control', async () => {
    const inspector = await mountInspector([
      field(1),
      field(2, {
        visibility: { dependsOnFieldId: 'field_1', operator: 'eq', valueText: 'y' },
      }),
    ])
    await inspector.changeSelect('approval-form-field-inspector-type', 'date')
    // Zero mutation, control snapped back to the committed type.
    expect(inspector.session().draft.fields[0].type).toBe('text')
    expect(inspector.session().history.undoStack).toHaveLength(0)
    expect(inspector.select('approval-form-field-inspector-type').value).toBe('text')
    const copy = inspector.status()
    expect(copy).toBe(
      `${INSPECTOR_RETYPE_REFUSAL_PREFIX}${DEPENDENCY_KIND_BUSINESS_LABELS.visibility_rule}`,
    )
    // Values-free: business labels only — no ids, values, or locations.
    expect(copy).not.toMatch(/field_\d|local_\d|fields\.|字段 \d/)
  })
})

// --- option rows (§3.4 value preservation) ----------------------------------

describe('ApprovalFormFieldInspector — option rows preserve values; one action = one commit', () => {
  const selectField = () =>
    field(1, { type: 'select', optionsText: '甲:a\n乙:b' })

  it('editing an option LABEL preserves its hand-authored VALUE (one command)', async () => {
    const inspector = await mountInspector([selectField(), field(2)])
    await inspector.typeText('approval-form-field-inspector-option-label-0', '甲方')
    expect(inspector.commands).toHaveLength(0)
    await inspector.blur('approval-form-field-inspector-option-label-0')
    expect(inspector.commands).toEqual([
      {
        kind: 'update-properties',
        localId: 'local_1',
        patch: { optionsText: '甲方:a\n乙:b' },
      },
    ])
    expect(inspector.session().history.undoStack).toHaveLength(1)
  })

  it('a NEW option receives a GENERATED OPAQUE value from the seam, never a label-derived one', async () => {
    const inspector = await mountInspector([selectField(), field(2)], {
      optionValueFactory: () => 'opt_fixed_1',
    })
    inspector.q('[data-testid="approval-form-field-inspector-option-add"]').click()
    await nextTick()
    expect(inspector.session().draft.fields[0].optionsText).toBe(
      '甲:a\n乙:b\n选项 3:opt_fixed_1',
    )
    expect(inspector.session().history.undoStack).toHaveLength(1)
  })

  it('removing an option row is one command; existing values stay byte-identical', async () => {
    const inspector = await mountInspector([selectField(), field(2)])
    inspector
      .q('[data-testid="approval-form-field-inspector-option-remove-0"]')
      .click()
    await nextTick()
    expect(inspector.session().draft.fields[0].optionsText).toBe('乙:b')
    expect(inspector.session().history.undoStack).toHaveLength(1)
  })

  it('the SETTLE path preserves option values too: a dirty option label settles as ONE command with the value intact (P2-3)', async () => {
    const inspector = await mountInspector([selectField(), field(2)])
    await inspector.typeText('approval-form-field-inspector-option-label-0', '甲改')
    expect(inspector.commands).toHaveLength(0)
    // Settle WITHOUT blurring — the selection-switch path, not commitOptionLabel.
    expect(inspector.vm.settlePendingEdits()).toBe(true)
    expect(inspector.commands).toEqual([
      {
        kind: 'update-properties',
        localId: 'local_1',
        patch: { optionsText: '甲改:a\n乙:b' },
      },
    ])
    // Hand-authored value 'a' preserved byte-identical; exactly one entry.
    expect(inspector.session().draft.fields[0].optionsText).toBe('甲改:a\n乙:b')
    expect(inspector.session().history.undoStack).toHaveLength(1)
  })

  it('a BLANK option label is an invalid buffer: blur commits nothing and shows values-free copy', async () => {
    const inspector = await mountInspector([selectField(), field(2)])
    await inspector.typeText('approval-form-field-inspector-option-label-0', ' ')
    await inspector.blur('approval-form-field-inspector-option-label-0')
    expect(inspector.commands).toHaveLength(0)
    expect(inspector.status()).toBe(INSPECTOR_INVALID_BUFFER_MESSAGE)
    expect(INSPECTOR_INVALID_BUFFER_MESSAGE).not.toMatch(/field_|local_|字段 \d/)
  })
})

// --- detail columns ----------------------------------------------------------

describe('ApprovalFormFieldInspector — detail column rows (one logical action = one commit)', () => {
  const detailField = () =>
    field(1, {
      id: 'items',
      type: 'detail',
      detailColumns: [column(1), column(2)],
    })

  it('column label commits on blur; column type change is the typed column retype; required commits on change', async () => {
    const inspector = await mountInspector([detailField(), field(2)])
    await inspector.typeText(
      'approval-form-field-inspector-column-label-col_local_1',
      '品名',
    )
    expect(inspector.commands).toHaveLength(0)
    await inspector.blur('approval-form-field-inspector-column-label-col_local_1')
    expect(inspector.commands).toEqual([
      {
        kind: 'update-detail-column',
        fieldLocalId: 'local_1',
        columnLocalId: 'col_local_1',
        patch: { label: '品名' },
      },
    ])
    await inspector.changeSelect(
      'approval-form-field-inspector-column-type-col_local_2',
      'number',
    )
    expect(inspector.commands.at(-1)).toEqual({
      kind: 'retype-detail-column',
      fieldLocalId: 'local_1',
      columnLocalId: 'col_local_2',
      nextType: 'number',
    })
    const columns = inspector.session().draft.fields[0].detailColumns
    // Column identity preserved across retype.
    expect(columns[1]).toMatchObject({
      id: 'col_2',
      localId: 'col_local_2',
      type: 'number',
    })
    await inspector.toggle(
      'approval-form-field-inspector-column-required-col_local_1',
    )
    expect(
      inspector.session().draft.fields[0].detailColumns[0].required,
    ).toBe(true)
    expect(inspector.session().history.undoStack).toHaveLength(3)
  })

  it('add/remove column are one command each; removing the LAST column shows the named refusal copy', async () => {
    const inspector = await mountInspector([detailField(), field(2)])
    inspector
      .q('[data-testid="approval-form-field-inspector-column-add"]')
      .click()
    await nextTick()
    expect(inspector.session().draft.fields[0].detailColumns).toHaveLength(3)
    inspector
      .q('[data-testid="approval-form-field-inspector-column-remove-col_local_1"]')
      .click()
    await nextTick()
    inspector
      .q('[data-testid="approval-form-field-inspector-column-remove-col_local_2"]')
      .click()
    await nextTick()
    expect(inspector.session().draft.fields[0].detailColumns).toHaveLength(1)
    expect(inspector.session().history.undoStack).toHaveLength(3)
    // The last remaining column refuses with the values-free named copy.
    const lastLocalId =
      inspector.session().draft.fields[0].detailColumns[0].localId
    inspector
      .q(
        `[data-testid="approval-form-field-inspector-column-remove-${lastLocalId}"]`,
      )
      .click()
    await nextTick()
    expect(inspector.session().draft.fields[0].detailColumns).toHaveLength(1)
    expect(inspector.session().history.undoStack).toHaveLength(3)
    expect(inspector.status()).toBe(INSPECTOR_LAST_DETAIL_COLUMN_MESSAGE)
  })

  it('row bounds commit on blur and an inverted min/max buffer blocks with values-free copy', async () => {
    const inspector = await mountInspector([detailField(), field(2)])
    await inspector.typeText('approval-form-field-inspector-min-rows', '2')
    await inspector.blur('approval-form-field-inspector-min-rows')
    expect(inspector.session().draft.fields[0].minRowsText).toBe('2')
    await inspector.typeText('approval-form-field-inspector-max-rows', '1')
    await inspector.blur('approval-form-field-inspector-max-rows')
    // min(2) > max(1): invalid buffer — no commit, values-free copy.
    expect(inspector.session().draft.fields[0].maxRowsText).toBe('')
    expect(inspector.status()).toBe(INSPECTOR_INVALID_BUFFER_MESSAGE)
    expect(inspector.vm.settlePendingEdits()).toBe(false)
  })
})

// --- delete field ------------------------------------------------------------

describe('ApprovalFormFieldInspector — delete field', () => {
  it('deletes through the one command path; the last field shows the named refusal copy', async () => {
    const inspector = await mountInspector([field(1), field(2)])
    inspector
      .q('[data-testid="approval-form-field-inspector-remove-field"]')
      .click()
    await nextTick()
    expect(inspector.commands).toEqual([
      { kind: 'remove-field', localId: 'local_1' },
    ])
    expect(
      inspector.session().draft.fields.map((entry) => entry.localId),
    ).toEqual(['local_2'])
    // Focus/selection moved to the surviving field; deleting the LAST field
    // refuses with values-free copy and zero mutation.
    inspector
      .q('[data-testid="approval-form-field-inspector-remove-field"]')
      .click()
    await nextTick()
    expect(inspector.session().draft.fields).toHaveLength(1)
    expect(inspector.status()).toBe(INSPECTOR_LAST_FIELD_MESSAGE)
  })

  it('a delete refused by references lists the business dependency labels', async () => {
    const inspector = await mountInspector([
      field(1),
      field(2, {
        visibility: { dependsOnFieldId: 'field_1', operator: 'eq', valueText: 'y' },
      }),
    ])
    inspector
      .q('[data-testid="approval-form-field-inspector-remove-field"]')
      .click()
    await nextTick()
    expect(inspector.session().draft.fields).toHaveLength(2)
    expect(inspector.status()).toContain(
      DEPENDENCY_KIND_BUSINESS_LABELS.visibility_rule,
    )
    expect(inspector.status()).not.toMatch(/field_\d|local_\d/)
  })
})

// --- dirty-buffer settlement (FB-D7) ----------------------------------------

describe('ApprovalFormFieldInspector — settlePendingEdits (FB-D7 selection-switch arms)', () => {
  it('COMMIT ARM: a valid dirty buffer settles as EXACTLY ONE command/history entry', async () => {
    const inspector = await mountInspector([field(1), field(2)])
    await inspector.typeText('approval-form-field-inspector-label', '新标题')
    expect(inspector.vm.isDirty()).toBe(true)
    expect(inspector.vm.settlePendingEdits()).toBe(true)
    expect(inspector.commands).toEqual([
      {
        kind: 'update-properties',
        localId: 'local_1',
        patch: { label: '新标题' },
      },
    ])
    expect(inspector.session().history.undoStack).toHaveLength(1)
    expect(inspector.vm.isDirty()).toBe(false)
    // A clean buffer settles as a no-op.
    expect(inspector.vm.settlePendingEdits()).toBe(true)
    expect(inspector.commands).toHaveLength(1)
  })

  it('BLOCK ARM: an invalid dirty buffer refuses to settle, commits NOTHING, and shows values-free copy — never a silent discard', async () => {
    const inspector = await mountInspector([field(1), field(2)])
    await inspector.typeText('approval-form-field-inspector-label', '   ')
    expect(inspector.vm.settlePendingEdits()).toBe(false)
    await nextTick()
    expect(inspector.commands).toHaveLength(0)
    expect(inspector.session().history.undoStack).toHaveLength(0)
    expect(inspector.status()).toBe(INSPECTOR_INVALID_BUFFER_MESSAGE)
    // The buffer is STILL dirty (nothing was discarded).
    expect(inspector.vm.isDirty()).toBe(true)
    expect(inspector.input('approval-form-field-inspector-label').value).toBe('   ')
  })

  it('a settled multi-field buffer (label + placeholder dirty together) is still ONE command', async () => {
    const inspector = await mountInspector([field(1), field(2)])
    await inspector.typeText('approval-form-field-inspector-label', '标题甲')
    // Dirty a second text control WITHOUT blurring the first.
    await inspector.typeText('approval-form-field-inspector-placeholder', '请输入')
    expect(inspector.commands).toHaveLength(0)
    expect(inspector.vm.settlePendingEdits()).toBe(true)
    expect(inspector.commands).toEqual([
      {
        kind: 'update-properties',
        localId: 'local_1',
        patch: { label: '标题甲', placeholder: '请输入' },
      },
    ])
    expect(inspector.session().history.undoStack).toHaveLength(1)
  })

  it('switching to a NEW selection resets the buffer state for the new field', async () => {
    const inspector = await mountInspector([field(1), field(2)])
    await inspector.typeText('approval-form-field-inspector-label', '新标题')
    expect(inspector.vm.settlePendingEdits()).toBe(true)
    await inspector.selectField('local_2')
    expect(inspector.vm.isDirty()).toBe(false)
    expect(inspector.input('approval-form-field-inspector-label').value).toBe('字段 2')
  })
})
