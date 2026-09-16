import { afterEach, describe, expect, it, vi } from 'vitest'
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

  // #5795 — the mention candidate endpoint is search-required: the composer queries the host-supplied
  // search as the user types and renders the server's `requiresQuery` marker as a prompt.
  describe('server-side mention search (#5795)', () => {
    const settle = async () => {
      await new Promise((resolve) => setTimeout(resolve, 220))
      await nextTick()
      await nextTick()
    }

    function mountWithSearch(initial: string, search: (q: string) => Promise<unknown>, suggestions: Array<{ id: string; label: string; subtitle?: string }> = []) {
      const draft = ref(initial)
      const submitSpy: Array<{ content: string; mentions: string[] }> = []
      container = document.createElement('div')
      document.body.appendChild(container)
      const app = createApp({
        setup() {
          return () => h(MetaCommentComposer, {
            modelValue: draft.value,
            suggestions,
            mentionSearch: search,
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
      return { app, draft, submitSpy }
    }

    const fakeSearch = () => vi.fn(async (q: string) => (q
      ? {
          items: [{ id: 'u_fake_1', label: 'Fake Mentionable', subtitle: 'fake.mentionable@example.invalid' }],
          requiresQuery: false,
          hasMore: false,
        }
      : { items: [], requiresQuery: true, hasMore: false }))

    it('a bare @ asks the server with an empty term and renders the type-to-search hint, not a roster', async () => {
      const search = fakeSearch()
      const { app } = mountWithSearch('@', search)
      await settle()

      expect(search).toHaveBeenCalledWith('')
      const hint = container!.querySelector('[data-test="comment-mention-search-required"]')
      expect(hint).not.toBeNull()
      expect(hint!.textContent).toMatch(/Type a name or email|输入姓名或邮箱/)
      expect(container!.querySelectorAll('.meta-comment-composer__suggestion')).toHaveLength(0)
      app.unmount()
    })

    it('a real term shows the server answer (even an email-only match) and selecting it still mentions', async () => {
      const search = fakeSearch()
      const { app, submitSpy } = mountWithSearch('ping @', search)
      await settle()

      const textarea = container!.querySelector('textarea') as HTMLTextAreaElement
      textarea.value = 'ping @example'
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await nextTick()
      await settle()

      expect(search).toHaveBeenLastCalledWith('example')
      expect(container!.querySelector('[data-test="comment-mention-search-required"]')).toBeNull()
      const option = container!.querySelector('.meta-comment-composer__suggestion') as HTMLButtonElement | null
      expect(option).not.toBeNull()
      expect(option!.textContent).toContain('Fake Mentionable')
      option!.click()
      await nextTick()
      ;(container!.querySelector('.meta-comment-composer__submit') as HTMLButtonElement).click()
      await nextTick()

      expect(submitSpy).toEqual([{ content: 'ping @[Fake Mentionable](u_fake_1)', mentions: ['u_fake_1'] }])
      app.unmount()
    })

    it('a slower answer for an older term never replaces the newer one', async () => {
      let releaseOld: (() => void) | null = null
      const search = vi.fn((q: string) => {
        if (q === 'fa') {
          return new Promise((resolve) => {
            releaseOld = () => resolve({ items: [{ id: 'u_old', label: 'Fake Old' }], requiresQuery: false, hasMore: false })
          })
        }
        return Promise.resolve({ items: [{ id: 'u_new', label: 'Fake Newer' }], requiresQuery: false, hasMore: false })
      })
      const { app } = mountWithSearch('@fa', search)
      await settle()
      const textarea = container!.querySelector('textarea') as HTMLTextAreaElement
      textarea.value = '@fake'
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await settle()
      releaseOld!()
      await settle()

      const labels = Array.from(container!.querySelectorAll('.meta-comment-composer__suggestion')).map((el) => el.textContent)
      expect(labels.join(' ')).toContain('Fake Newer')
      expect(labels.join(' ')).not.toContain('Fake Old')
      app.unmount()
    })

    it('erasing back to a bare @ never shows the answer for the previous term while the new ask is pending', async () => {
      const search = vi.fn((q: string) => (q
        ? Promise.resolve({ items: [{ id: 'u_prev', label: 'Fake Previous' }], requiresQuery: false, hasMore: false })
        : new Promise(() => {}))) // the term-less ask never settles in this test
      const { app } = mountWithSearch('@fa', search)
      await settle()
      expect(container!.querySelector('.meta-comment-composer__suggestion')!.textContent).toContain('Fake Previous')

      const textarea = container!.querySelector('textarea') as HTMLTextAreaElement
      textarea.value = '@'
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await settle()

      expect(search).toHaveBeenLastCalledWith('')
      expect(container!.querySelectorAll('.meta-comment-composer__suggestion')).toHaveLength(0)
      expect(container!.textContent).not.toContain('Fake Previous')
      app.unmount()
    })

    it('without a host search the static list is unchanged and no hint ever renders', async () => {
      const draft = ref('@')
      container = document.createElement('div')
      document.body.appendChild(container)
      const app = createApp({
        setup() {
          return () => h(MetaCommentComposer, {
            modelValue: draft.value,
            suggestions: [{ id: 'user_jamie', label: 'Jamie' }],
          })
        },
      })
      app.mount(container)
      await settle()

      expect(container.querySelector('[data-test="comment-mention-search-required"]')).toBeNull()
      expect(container.querySelector('.meta-comment-composer__suggestion')!.textContent).toContain('Jamie')
      app.unmount()
    })
  })

  // #5808 — editing a comment whose mentions are NOT in the text (created with an explicit `mentions`
  // array). The composer used to drop, on every input, each selected mention whose `@label` was absent
  // from the NEW text — so such a mention vanished on the first keystroke and the save removed it.
  describe('edit keeps mentions that are not in the text (#5808)', () => {
    type Mention = { id: string; label: string; unresolved?: boolean }

    function mountEditing(initial: string, initialMentions: Mention[]) {
      const draft = ref(initial)
      const submitSpy: Array<{ content: string; mentions: string[] }> = []
      container = document.createElement('div')
      document.body.appendChild(container)
      const app = createApp({
        setup() {
          return () => h(MetaCommentComposer, {
            modelValue: draft.value,
            initialMentions,
            submitKind: 'save',
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
      return { app, draft, submitSpy }
    }

    function chipLabels(): string[] {
      return Array.from(container!.querySelectorAll('.meta-comment-composer__mention-chip span:first-child'))
        .map((node) => node.textContent?.trim() ?? '')
    }

    async function type(value: string) {
      const textarea = container!.querySelector('textarea') as HTMLTextAreaElement
      textarea.value = value
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await nextTick()
    }

    async function submit() {
      ;(container!.querySelector('.meta-comment-composer__submit') as HTMLButtonElement).click()
      await nextTick()
    }

    it('a keystroke keeps a labelled and an unresolved mention that are absent from the text, and save sends both ids', async () => {
      const { app, submitSpy } = mountEditing('Please double-check', [
        { id: 'user_fake_robin', label: 'Robin Example' },
        { id: 'user_fake_gone', label: '', unresolved: true },
      ])
      await nextTick()
      expect(chipLabels()).toEqual(['@Robin Example', '@Unknown user'])
      expect(container!.textContent).not.toContain('user_fake_gone')

      await type('Please double-check!')
      expect(chipLabels()).toEqual(['@Robin Example', '@Unknown user'])

      await submit()
      expect(submitSpy).toEqual([{
        content: 'Please double-check!',
        mentions: ['user_fake_robin', 'user_fake_gone'],
      }])
      app.unmount()
    })

    it('deleting the text of a mention that WAS in the text still drops it', async () => {
      const { app, submitSpy } = mountEditing('@Jamie hello', [{ id: 'user_jamie', label: 'Jamie' }])
      await nextTick()
      expect(chipLabels()).toEqual(['@Jamie'])

      await type('@Jami hello')
      expect(chipLabels()).toEqual([])

      await submit()
      expect(submitSpy).toEqual([{ content: '@Jami hello', mentions: [] }])
      app.unmount()
    })

    it('an unresolved mention is never written into the body as a token, and its chip still removes it', async () => {
      // neither the placeholder text nor a bare `@ ` may turn into an `@[…](user_fake_gone)` token
      const { app, submitSpy } = mountEditing('@Unknown user cc @ later', [{ id: 'user_fake_gone', label: '', unresolved: true }])
      await nextTick()
      await type('@Unknown user cc @ later!')
      await submit()
      expect(submitSpy[0]).toEqual({ content: '@Unknown user cc @ later!', mentions: ['user_fake_gone'] })

      ;(container!.querySelector('.meta-comment-composer__mention-chip') as HTMLButtonElement).click()
      await nextTick()
      expect(chipLabels()).toEqual([])
      await submit()
      expect(submitSpy[1]).toEqual({ content: '@Unknown user cc @ later!', mentions: [] })
      app.unmount()
    })

    it('an unresolved mention is never matched against the text, so editing a bare @ does not drop it', async () => {
      const { app, submitSpy } = mountEditing('ping @ there', [{ id: 'user_fake_gone', label: '', unresolved: true }])
      await nextTick()
      await type('ping there')
      expect(chipLabels()).toEqual(['@Unknown user'])
      await submit()
      expect(submitSpy).toEqual([{ content: 'ping there', mentions: ['user_fake_gone'] }])
      app.unmount()
    })

    it('a blank label counts as unresolved even without the flag (never renders an empty chip or the id)', async () => {
      const { app } = mountEditing('x', [{ id: 'user_fake_blank', label: '   ' }])
      await nextTick()
      expect(chipLabels()).toEqual(['@Unknown user'])
      expect(container!.textContent).not.toContain('user_fake_blank')
      app.unmount()
    })
  })
})
