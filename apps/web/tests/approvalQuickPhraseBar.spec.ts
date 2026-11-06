/**
 * Shared quick-phrase bar (ApprovalQuickPhraseBar.vue): chip fills the bound opinion (editable),
 * 「存为常用语」 saves the current text as a personal phrase, personal phrases come first and can
 * be removed, presets stay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'

const messageSpies = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}))
vi.mock('element-plus', () => ({ ElMessage: messageSpies }))

import ApprovalQuickPhraseBar from '../src/approvals/components/ApprovalQuickPhraseBar.vue'
import { QUICK_PHRASE_BAR_EN, QUICK_PHRASE_BAR_ZH } from '../src/approvals/components/quickPhraseLabels'
import { MAX_PERSONAL_PHRASES, MAX_PHRASE_LENGTH, personalPhrases, savePersonalPhrase } from '../src/approvals/quickPhrases'
import { useLocale } from '../src/composables/useLocale'

const ElTag = defineComponent({
  name: 'ElTag',
  props: { type: String, effect: String },
  emits: ['click'],
  setup(props, { slots, emit }) {
    return () => h('span', { 'data-el-tag': props.type ?? 'default', onClick: (e: Event) => emit('click', e) }, slots.default?.())
  },
})

const ElButton = defineComponent({
  name: 'ElButton',
  props: { type: String, link: Boolean, size: String, disabled: Boolean, title: String },
  emits: ['click'],
  setup(props, { slots, emit }) {
    return () => h('button', {
      type: 'button',
      disabled: props.disabled,
      title: props.title,
      onClick: (e: Event) => emit('click', e),
    }, slots.default?.())
  },
})

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('ApprovalQuickPhraseBar', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  const text = ref('')
  const action = ref('approve')
  const userId = ref<string | null>('u1')

  function mount(extra: Record<string, unknown> = {}) {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(defineComponent({
      setup() {
        return () => h(ApprovalQuickPhraseBar as any, {
          modelValue: text.value,
          'onUpdate:modelValue': (value: string) => { text.value = value },
          action: action.value,
          userId: userId.value,
          ...extra,
        })
      },
    }))
    app.component('ElTag', ElTag)
    app.component('ElButton', ElButton)
    app.mount(container)
  }

  const q = (testid: string) => container!.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null
  const chips = (prefix = 'approval-quick-phrase') =>
    Array.from(container!.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}-"]`)).map((el) => el.textContent?.trim())

  beforeEach(() => {
    localStorage.clear()
    text.value = ''
    action.value = 'approve'
    userId.value = 'u1'
    for (const spy of Object.values(messageSpies)) spy.mockReset()
    useLocale().setLocale('zh-CN')
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
    useLocale().setLocale('zh-CN')
  })

  it('shows the presets; a chip fills the empty opinion, a second chip appends after a full-width comma', async () => {
    mount()
    await flushUi()
    expect(chips()).toEqual(['同意', '情况属实', '已核实无误'])
    q('approval-quick-phrase-0')!.click()
    await flushUi()
    expect(text.value).toBe('同意')
    q('approval-quick-phrase-1')!.click()
    await flushUi()
    expect(text.value).toBe('同意，情况属实')
  })

  it('chip-only testid prefix: controls never match `[data-testid^="approval-quick-phrase-"]`', async () => {
    savePersonalPhrase('u1', 'approve', '个人短语')
    text.value = '可保存的文字'
    mount()
    await flushUi()
    expect(chips()).toEqual(['个人短语', '同意', '情况属实', '已核实无误'])
    expect(q('approval-phrase-save')).toBeTruthy()
    expect(q('approval-phrase-remove-0')).toBeTruthy()
  })

  it('「存为常用语」 is disabled for a blank opinion, saves the current text and puts it first', async () => {
    mount()
    await flushUi()
    const save = () => q('approval-phrase-save') as HTMLButtonElement
    expect(save().textContent?.trim()).toBe(QUICK_PHRASE_BAR_ZH.save)
    expect(save().disabled).toBe(true)

    text.value = '  同意，请按合同付款  '
    await flushUi()
    expect(save().disabled).toBe(false)
    save().click()
    await flushUi()
    expect(messageSpies.success).toHaveBeenCalledWith(QUICK_PHRASE_BAR_ZH.saved)
    expect(personalPhrases('u1', 'approve')).toEqual(['同意，请按合同付款'])
    expect(chips()).toEqual(['同意，请按合同付款', '同意', '情况属实', '已核实无误'])
    // Saving does not touch the opinion text: the user can still edit and submit it.
    expect(text.value).toBe('  同意，请按合同付款  ')

    save().click()
    await flushUi()
    expect(messageSpies.info).toHaveBeenCalledWith(QUICK_PHRASE_BAR_ZH.duplicate)
    expect(personalPhrases('u1', 'approve')).toHaveLength(1)
  })

  it('warns on an over-long text and on a full list, saving nothing', async () => {
    text.value = '长'.repeat(101)
    mount()
    await flushUi()
    q('approval-phrase-save')!.click()
    await flushUi()
    expect(messageSpies.warning).toHaveBeenCalledWith(QUICK_PHRASE_BAR_ZH.tooLong)
    expect(personalPhrases('u1', 'approve')).toEqual([])

    for (let i = 0; i < MAX_PERSONAL_PHRASES; i += 1) savePersonalPhrase('u1', 'approve', `p${i}`)
    text.value = '第二十一条'
    await flushUi()
    q('approval-phrase-save')!.click()
    await flushUi()
    expect(messageSpies.warning).toHaveBeenLastCalledWith(QUICK_PHRASE_BAR_ZH.full)
    expect(personalPhrases('u1', 'approve')).not.toContain('第二十一条')
  })

  it('removes a personal phrase; presets have no remove control', async () => {
    savePersonalPhrase('u1', 'reject', '缺发票')
    action.value = 'reject'
    mount()
    await flushUi()
    expect(chips()).toEqual(['缺发票', '不符合要求', '请补充材料后重新提交'])
    expect(container!.querySelectorAll('[data-testid^="approval-phrase-remove-"]')).toHaveLength(1)
    q('approval-phrase-remove-0')!.click()
    await flushUi()
    expect(personalPhrases('u1', 'reject')).toEqual([])
    expect(chips()).toEqual(['不符合要求', '请补充材料后重新提交'])
    expect(container!.querySelectorAll('[data-testid^="approval-phrase-remove-"]')).toHaveLength(0)
  })

  it('a saved phrase chip carries its full text as the hover title (long phrases are cut with an ellipsis); presets carry none', async () => {
    const longPhrase = '长'.repeat(MAX_PHRASE_LENGTH)
    expect(savePersonalPhrase('u1', 'approve', longPhrase)).toBe('saved')
    mount()
    await flushUi()
    const personal = q('approval-quick-phrase-0')!
    expect(personal.textContent?.trim()).toBe(longPhrase)
    expect(personal.getAttribute('title')).toBe(longPhrase)
    expect(q('approval-quick-phrase-1')!.textContent?.trim()).toBe('同意')
    expect(q('approval-quick-phrase-1')!.hasAttribute('title')).toBe(false)
  })

  it('without a signed-in user: presets only, no save control', async () => {
    userId.value = null
    mount()
    await flushUi()
    expect(chips()).toEqual(['同意', '情况属实', '已核实无误'])
    expect(q('approval-phrase-save')).toBeNull()
  })

  it('an action without presets renders nothing', async () => {
    action.value = 'transfer'
    mount()
    await flushUi()
    expect(q('approval-phrase-bar')).toBeNull()
  })

  it('a save in one bar shows up in another mounted bar for the same action', async () => {
    mount({ chipTestidPrefix: 'a-quick-phrase', controlTestidPrefix: 'a-phrase' })
    const first = container!
    const otherHost = document.createElement('div')
    document.body.appendChild(otherHost)
    const other = createApp(defineComponent({
      setup() {
        return () => h(ApprovalQuickPhraseBar as any, {
          modelValue: '',
          action: 'approve',
          userId: 'u1',
          chipTestidPrefix: 'b-quick-phrase',
          controlTestidPrefix: 'b-phrase',
        })
      },
    }))
    other.component('ElTag', ElTag)
    other.component('ElButton', ElButton)
    other.mount(otherHost)
    await flushUi()

    text.value = '跨组件共享'
    await flushUi()
    ;(first.querySelector('[data-testid="a-phrase-save"]') as HTMLButtonElement).click()
    await flushUi()
    expect(otherHost.querySelector('[data-testid="b-quick-phrase-0"]')?.textContent?.trim()).toBe('跨组件共享')

    other.unmount()
    otherHost.remove()
  })

  it('English chrome: labels and messages follow the locale; only the phrases stay as written', async () => {
    useLocale().setLocale('en')
    savePersonalPhrase('u1', 'approve', 'Looks good')
    text.value = 'Approved per budget'
    mount()
    await flushUi()
    const save = q('approval-phrase-save') as HTMLButtonElement
    expect(save.textContent?.trim()).toBe(QUICK_PHRASE_BAR_EN.save)
    expect(save.getAttribute('title')).toBe(QUICK_PHRASE_BAR_EN.saveHint)
    expect(q('approval-phrase-remove-0')!.getAttribute('aria-label')).toBe(QUICK_PHRASE_BAR_EN.remove)
    expect(q('approval-phrase-bar')!.getAttribute('aria-label')).toBe(QUICK_PHRASE_BAR_EN.groupLabel)
    save.click()
    await flushUi()
    expect(messageSpies.success).toHaveBeenCalledWith(QUICK_PHRASE_BAR_EN.saved)

    for (const value of Object.values(QUICK_PHRASE_BAR_EN)) expect(value).not.toMatch(CJK)
    expect(Object.keys(QUICK_PHRASE_BAR_EN).sort()).toEqual(Object.keys(QUICK_PHRASE_BAR_ZH).sort())
  })
})
