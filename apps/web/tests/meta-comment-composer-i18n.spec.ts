import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import MetaCommentComposer from '../src/multitable/components/MetaCommentComposer.vue'

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  useLocale().setLocale('en')
})

async function flushUi(cycles = 3): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function mountComposer(props: Record<string, unknown> = {}) {
  const draft = ref(typeof props.modelValue === 'string' ? props.modelValue : 'hello')
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup() {
      return () => h(MetaCommentComposer, {
        modelValue: draft.value,
        'onUpdate:modelValue': (value: string) => {
          draft.value = value
        },
        ...props,
      })
    },
  })
  app.mount(container)
  return container
}

describe('MetaCommentComposer i18n', () => {
  it('renders zh-CN resting labels and hint copy when the drawer passes localized props', async () => {
    useLocale().setLocale('zh-CN')
    const root = mountComposer({
      submitLabel: '发送',
      submitKind: 'send',
      placeholder: '添加评论...',
    })
    await flushUi()

    expect(root.querySelector<HTMLTextAreaElement>('textarea')?.getAttribute('placeholder')).toBe('添加评论...')
    expect(root.querySelector('.meta-comment-composer__submit')?.textContent?.trim()).toBe('发送')
    expect(root.querySelector('.meta-comment-composer__hint')?.textContent?.trim()).toBe('Ctrl/Cmd + Enter 发送')
  })

  it('uses submitKind instead of the resting submitLabel for zh-CN submitting states', async () => {
    useLocale().setLocale('zh-CN')
    const savingRoot = mountComposer({
      modelValue: 'draft',
      submitLabel: '保存',
      submitKind: 'save',
      submitting: true,
    })
    await flushUi()
    expect(savingRoot.querySelector('.meta-comment-composer__submit')?.textContent?.trim()).toBe('正在保存...')
    app?.unmount()
    container?.remove()
    app = null
    container = null

    const sendingRoot = mountComposer({
      modelValue: 'draft',
      submitLabel: '发送',
      submitKind: 'send',
      submitting: true,
    })
    await flushUi()
    expect(sendingRoot.querySelector('.meta-comment-composer__submit')?.textContent?.trim()).toBe('正在发送...')
  })

  it('preserves English submitting labels through submitKind', async () => {
    useLocale().setLocale('en')
    const savingRoot = mountComposer({
      modelValue: 'draft',
      submitLabel: 'Save',
      submitKind: 'save',
      submitting: true,
    })
    await flushUi()
    expect(savingRoot.querySelector('.meta-comment-composer__submit')?.textContent?.trim()).toBe('Saving...')
    app?.unmount()
    container?.remove()
    app = null
    container = null

    const sendingRoot = mountComposer({
      modelValue: 'draft',
      submitLabel: 'Send',
      submitKind: 'send',
      submitting: true,
    })
    await flushUi()
    expect(sendingRoot.querySelector('.meta-comment-composer__submit')?.textContent?.trim()).toBe('Sending...')
  })

  it('localizes mention listbox aria and suggestion hint while preserving physical shortcut keys', async () => {
    useLocale().setLocale('zh-CN')
    const root = mountComposer({
      modelValue: '@a',
      suggestions: [
        { id: 'user_amy', label: 'Amy Wong' },
      ],
      submitLabel: '发送',
    })
    await flushUi()

    expect(root.querySelector('.meta-comment-composer__suggestions')?.getAttribute('aria-label')).toBe('评论提及建议')
    expect(root.querySelector('.meta-comment-composer__hint')?.textContent?.trim()).toBe('Tab 提及，Ctrl/Cmd + Enter 发送')
    expect(root.textContent).toContain('Amy Wong')
  })
})
