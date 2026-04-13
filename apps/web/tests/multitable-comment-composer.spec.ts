import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import MetaCommentComposer from '../src/multitable/components/MetaCommentComposer.vue'

describe('MetaCommentComposer', () => {
  let container: HTMLDivElement | null = null

  afterEach(() => {
    container?.remove()
    container = null
  })

  it('collects selected mentions and emits them on submit', async () => {
    const draft = ref('@ja')
    const submitSpy: Array<{ content: string; mentions: string[] }> = []

    container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      setup() {
        return () => h(MetaCommentComposer, {
          modelValue: draft.value,
          suggestions: [
            { id: 'user_jamie', label: 'Jamie' },
            { id: 'user_jordan', label: 'Jordan' },
          ],
          'onUpdate:modelValue': (value: string) => {
            draft.value = value
          },
          onSubmit: (payload: { content: string; mentions: string[] }) => {
            submitSpy.push(payload)
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null
    textarea!.value = '@ja'
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    const suggestion = container.querySelector('.meta-comment-composer__suggestion') as HTMLButtonElement | null
    expect(suggestion).not.toBeNull()
    expect(suggestion!.textContent).toContain('Jamie')
    suggestion?.click()
    await nextTick()

    expect(textarea?.value).toContain('@Jamie')

    const submit = container.querySelector('.meta-comment-composer__submit') as HTMLButtonElement | null
    submit?.click()
    await nextTick()

    expect(submitSpy).toEqual([{
      content: '@[Jamie](user_jamie)',
      mentions: ['user_jamie'],
    }])

    app.unmount()
  })

  it('supports keyboard navigation and tab selection for mention suggestions', async () => {
    const draft = ref('@j')
    const submitSpy: Array<{ content: string; mentions: string[] }> = []

    container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      setup() {
        return () => h(MetaCommentComposer, {
          modelValue: draft.value,
          suggestions: [
            { id: 'user_jamie', label: 'Jamie' },
            { id: 'user_jordan', label: 'Jordan' },
          ],
          'onUpdate:modelValue': (value: string) => {
            draft.value = value
          },
          onSubmit: (payload: { content: string; mentions: string[] }) => {
            submitSpy.push(payload)
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null
    expect(container.querySelector('.meta-comment-composer__suggestion--active')?.textContent).toContain('Jamie')

    textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await nextTick()
    expect(container.querySelector('.meta-comment-composer__suggestion--active')?.textContent).toContain('Jordan')

    textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    await nextTick()

    expect(textarea?.value).toContain('@Jordan')
    expect(container.querySelector('.meta-comment-composer__hint')?.textContent).toContain('Ctrl/Cmd + Enter')

    const submit = container.querySelector('.meta-comment-composer__submit') as HTMLButtonElement | null
    submit?.click()
    await nextTick()

    expect(submitSpy).toEqual([{
      content: '@[Jordan](user_jordan)',
      mentions: ['user_jordan'],
    }])

    app.unmount()
  })

  it('dismisses suggestions with escape until the next input change', async () => {
    const draft = ref('@ja')

    container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      setup() {
        return () => h(MetaCommentComposer, {
          modelValue: draft.value,
          suggestions: [
            { id: 'user_jamie', label: 'Jamie' },
            { id: 'user_jordan', label: 'Jordan' },
          ],
          'onUpdate:modelValue': (value: string) => {
            draft.value = value
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null
    expect(container.querySelector('.meta-comment-composer__suggestions')).not.toBeNull()

    textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await nextTick()
    expect(container.querySelector('.meta-comment-composer__suggestions')).toBeNull()

    textarea!.value = '@jam'
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(container.querySelector('.meta-comment-composer__suggestions')).not.toBeNull()

    app.unmount()
  })
})
