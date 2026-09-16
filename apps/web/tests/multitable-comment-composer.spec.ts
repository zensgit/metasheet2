import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, shallowRef } from 'vue'
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

    it('typing a word that starts with a chip\'s name never drops a mention that was not in the text', async () => {
      const { app, submitSpy } = mountEditing('Totals', [{ id: 'user_fake_robin', label: 'Robin' }])
      await nextTick()
      let typed = 'Totals'
      for (const ch of ' @Robinson') {
        typed += ch
        await type(typed)
        expect(chipLabels()).toEqual(['@Robin'])
      }
      // spelling the name exactly and erasing it again does not tie the chip to the text either
      await type('Totals @Robin')
      await type('Totals')
      expect(chipLabels()).toEqual(['@Robin'])
      await type('Totals @Robinson')
      await submit()
      expect(submitSpy).toEqual([{ content: 'Totals @Robinson', mentions: ['user_fake_robin'] }])
      app.unmount()
    })

    it('a name followed by punctuation keeps its token on save', async () => {
      // the workbench shows `@[Alice Fake](user_fake_alice), please` as `@Alice Fake, please`
      const { app, submitSpy } = mountEditing('@Alice Fake, please', [{ id: 'user_fake_alice', label: 'Alice Fake' }])
      await nextTick()
      await type('@Alice Fake, please!')
      expect(chipLabels()).toEqual(['@Alice Fake'])
      await submit()
      expect(submitSpy).toEqual([{ content: '@[Alice Fake](user_fake_alice), please!', mentions: ['user_fake_alice'] }])
      app.unmount()
    })

    it('a name followed by full-width punctuation keeps its token on save', async () => {
      const { app, submitSpy } = mountEditing('@张测试，请看', [{ id: 'user_fake_zhang', label: '张测试' }])
      await nextTick()
      await type('@张测试，请看看')
      await submit()
      expect(submitSpy).toEqual([{ content: '@[张测试](user_fake_zhang)，请看看', mentions: ['user_fake_zhang'] }])
      app.unmount()
    })

    it('deleting a name that was followed by punctuation drops its chip', async () => {
      const { app, submitSpy } = mountEditing('@Alice Fake, please', [{ id: 'user_fake_alice', label: 'Alice Fake' }])
      await nextTick()
      await type('please')
      expect(chipLabels()).toEqual([])
      await submit()
      expect(submitSpy).toEqual([{ content: 'please', mentions: [] }])
      app.unmount()
    })

    // A name that is the start of another chip's name, or of an address in the text, must not take that
    // text: a full stop inside a word does not end a name, and longer names are matched first.
    const wang = { id: 'user_fake_wang', label: 'wang' }
    const wangLi = { id: 'user_fake_wangli', label: 'wang.li@corp.invalid' }

    it('wang and wang.li@corp.invalid each keep their own token on save', async () => {
      const { app, submitSpy } = mountEditing('@wang cc @wang.li@corp.invalid', [wang, wangLi])
      await nextTick()
      await type('@wang cc @wang.li@corp.invalid please')
      expect(chipLabels()).toEqual(['@wang', '@wang.li@corp.invalid'])
      await submit()
      expect(submitSpy).toEqual([{
        content: '@[wang](user_fake_wang) cc @[wang.li@corp.invalid](user_fake_wangli) please',
        mentions: ['user_fake_wang', 'user_fake_wangli'],
      }])
      app.unmount()
    })

    it('deleting "@wang " drops wang\'s chip and keeps wang.li@corp.invalid\'s', async () => {
      const { app, submitSpy } = mountEditing('@wang cc @wang.li@corp.invalid', [wang, wangLi])
      await nextTick()
      await type('cc @wang.li@corp.invalid')
      expect(chipLabels()).toEqual(['@wang.li@corp.invalid'])
      await submit()
      expect(submitSpy).toEqual([{
        content: 'cc @[wang.li@corp.invalid](user_fake_wangli)',
        mentions: ['user_fake_wangli'],
      }])
      app.unmount()
    })

    it('an address that starts with a chip\'s name is not that chip\'s text: the save leaves it intact', async () => {
      // wang is mentioned only in `mentions`; the text names an address, not wang
      const { app, submitSpy } = mountEditing('ping @wang.li@corp.invalid', [wang])
      await nextTick()
      await type('ping @wang.li@corp.invalid!')
      expect(chipLabels()).toEqual(['@wang'])
      await submit()
      expect(submitSpy).toEqual([{ content: 'ping @wang.li@corp.invalid!', mentions: ['user_fake_wang'] }])
      app.unmount()
    })

    it('turning "@wang" into "@wang.li" removes wang\'s text, so his chip drops', async () => {
      const { app, submitSpy } = mountEditing('@wang hi', [wang])
      await nextTick()
      expect(chipLabels()).toEqual(['@wang'])
      await type('@wang.li hi')
      expect(chipLabels()).toEqual([])
      await submit()
      expect(submitSpy).toEqual([{ content: '@wang.li hi', mentions: [] }])
      app.unmount()
    })

    it('"@wang." at the end of a sentence is still wang\'s text', async () => {
      const { app, submitSpy } = mountEditing('thanks @wang. See @wang.', [wang])
      await nextTick()
      await type('Thanks @wang. See @wang.')
      expect(chipLabels()).toEqual(['@wang'])
      await submit()
      expect(submitSpy[0]).toEqual({
        content: 'Thanks @[wang](user_fake_wang). See @[wang](user_fake_wang).',
        mentions: ['user_fake_wang'],
      })
      // the chip is tied to that text: deleting it drops the chip
      await type('Thanks. See.')
      expect(chipLabels()).toEqual([])
      app.unmount()
    })

    const alice = { id: 'user_fake_alice_one', label: 'Alice' }
    const aliceFake = { id: 'user_fake_alice_two', label: 'Alice Fake' }

    it('Alice and Alice Fake each keep their own token on save', async () => {
      const { app, submitSpy } = mountEditing('@Alice Fake and @Alice, hi', [alice, aliceFake])
      await nextTick()
      await type('@Alice Fake and @Alice, hi!')
      expect(chipLabels()).toEqual(['@Alice', '@Alice Fake'])
      await submit()
      expect(submitSpy).toEqual([{
        content: '@[Alice Fake](user_fake_alice_two) and @[Alice](user_fake_alice_one), hi!',
        mentions: ['user_fake_alice_one', 'user_fake_alice_two'],
      }])
      app.unmount()
    })

    it('deleting "@Alice " drops Alice\'s chip even though "@Alice Fake" stays', async () => {
      const { app, submitSpy } = mountEditing('@Alice please ask @Alice Fake', [alice, aliceFake])
      await nextTick()
      await type('please ask @Alice Fake')
      expect(chipLabels()).toEqual(['@Alice Fake'])
      await submit()
      expect(submitSpy).toEqual([{
        content: 'please ask @[Alice Fake](user_fake_alice_two)',
        mentions: ['user_fake_alice_two'],
      }])
      app.unmount()
    })
  })

  // #5808 fix round — a chip picked from the suggestions follows its `@label` text, including when the
  // HOST changes the draft (the workbench clears it after a send and on a record switch, without
  // handing over new `initialMentions`). Keeping such a chip mentioned the person again in the next,
  // unrelated comment.
  describe('picked mentions follow the draft the host clears or replaces (#5808)', () => {
    function mountNewComment(
      initial: string,
      clearOnSubmit: boolean,
      suggestions: Array<{ id: string; label: string }> = [
        { id: 'user_jamie', label: 'Jamie' },
        { id: 'user_jordan', label: 'Jordan' },
      ],
    ) {
      const draft = ref(initial)
      const submitSpy: Array<{ content: string; mentions: string[] }> = []
      // one constant, as the workbench passes for every non-edit state
      const noInitialMentions: Array<{ id: string; label: string }> = []
      container = document.createElement('div')
      document.body.appendChild(container)
      const app = createApp({
        setup() {
          return () => h(MetaCommentComposer, {
            modelValue: draft.value,
            initialMentions: noInitialMentions,
            suggestions,
            'onUpdate:modelValue': (value: string) => {
              draft.value = value
            },
            onSubmit: (payload: { content: string; mentions: string[] }) => {
              submitSpy.push(payload)
              if (clearOnSubmit) draft.value = ''
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

    async function pickFirstSuggestion(expected: string) {
      const suggestion = container!.querySelector('.meta-comment-composer__suggestion') as HTMLButtonElement | null
      expect(suggestion?.textContent).toContain(expected)
      suggestion!.click()
      await nextTick()
    }

    async function submit() {
      ;(container!.querySelector('.meta-comment-composer__submit') as HTMLButtonElement).click()
      await nextTick()
    }

    it('the host clearing the draft after a send drops the sent comment\'s picks', async () => {
      const { app, submitSpy } = mountNewComment('', true)
      await nextTick()
      await type('@ja')
      await pickFirstSuggestion('Jamie')
      await submit()
      expect(submitSpy[0]).toEqual({ content: '@[Jamie](user_jamie)', mentions: ['user_jamie'] })
      expect(chipLabels()).toEqual([])

      await type('thanks everyone')
      await submit()
      expect(submitSpy[1]).toEqual({ content: 'thanks everyone', mentions: [] })
      app.unmount()
    })

    it('the host replacing the draft (record switch) drops picks tied to the old text, and keeps none for the next note', async () => {
      const { app, draft, submitSpy } = mountNewComment('', false)
      await nextTick()
      await type('@ja')
      await pickFirstSuggestion('Jamie')
      expect(chipLabels()).toEqual(['@Jamie'])

      draft.value = ''
      await nextTick()
      expect(chipLabels()).toEqual([])
      await type('note for record two')
      await submit()
      expect(submitSpy).toEqual([{ content: 'note for record two', mentions: [] }])
      app.unmount()
    })

    it('a pick after a line break keeps the line break, so the chip stays tied to its text', async () => {
      const { app, submitSpy } = mountNewComment('', false)
      await nextTick()
      await type('line one\n@ja')
      await pickFirstSuggestion('Jamie')
      expect((container!.querySelector('textarea') as HTMLTextAreaElement).value).toBe('line one\n@Jamie ')
      expect(chipLabels()).toEqual(['@Jamie'])
      await submit()
      expect(submitSpy).toEqual([{ content: 'line one\n@[Jamie](user_jamie)', mentions: ['user_jamie'] }])
      app.unmount()
    })

    it('a pick made before an edit starts does not tie the edit\'s own mention of the same person to the text', async () => {
      const draft = ref('')
      const initialMentions = ref<Array<{ id: string; label: string }>>([])
      const submitSpy: Array<{ content: string; mentions: string[] }> = []
      container = document.createElement('div')
      document.body.appendChild(container)
      const app = createApp({
        setup() {
          return () => h(MetaCommentComposer, {
            modelValue: draft.value,
            initialMentions: initialMentions.value,
            suggestions: [{ id: 'user_jamie', label: 'Jamie' }],
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
      await type('@ja')
      await pickFirstSuggestion('Jamie')
      // the host starts editing a comment that mentions Jamie only in its `mentions` array
      draft.value = 'Totals'
      initialMentions.value = [{ id: 'user_jamie', label: 'Jamie' }]
      await nextTick()
      expect(chipLabels()).toEqual(['@Jamie'])
      await type('Totals!')
      expect(chipLabels()).toEqual(['@Jamie'])
      await submit()
      expect(submitSpy).toEqual([{ content: 'Totals!', mentions: ['user_jamie'] }])
      app.unmount()
    })

    it('two picked people who share a name both stay while "@Sam" is in the text', async () => {
      const { app, submitSpy } = mountNewComment('', false, [
        { id: 'user_fake_sam_one', label: 'Sam' },
        { id: 'user_fake_sam_two', label: 'Sam' },
      ])
      await nextTick()
      await type('@sa')
      await pickFirstSuggestion('Sam')
      await type('@Sam and @sa')
      await pickFirstSuggestion('Sam')
      expect(chipLabels()).toEqual(['@Sam', '@Sam'])
      await type('@Sam and @Sam hi')
      expect(chipLabels()).toEqual(['@Sam', '@Sam'])
      await submit()
      expect(submitSpy[0]?.mentions).toEqual(['user_fake_sam_one', 'user_fake_sam_two'])
      app.unmount()
    })

    it('a picked chip still drops when the user deletes its text, and stays while the text stays', async () => {
      const { app, submitSpy } = mountNewComment('', false)
      await nextTick()
      await type('@jo')
      await pickFirstSuggestion('Jordan')
      await type('@Jordan please look')
      expect(chipLabels()).toEqual(['@Jordan'])
      await type('please look')
      expect(chipLabels()).toEqual([])
      await submit()
      expect(submitSpy).toEqual([{ content: 'please look', mentions: [] }])
      app.unmount()
    })
  })

  // #5813: a host that unmounts the composer (the record inspector's comments tab) keeps its selection.
  describe('a host-kept selection survives a remount (#5813)', () => {
    type Mention = { id: string; label: string; unresolved?: boolean }
    type Selection = { initialMentions: readonly Mention[]; mentions: Mention[]; textBoundIds: string[] }

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

    async function pickFirstSuggestion(expected: string) {
      const suggestion = container!.querySelector('.meta-comment-composer__suggestion') as HTMLButtonElement | null
      expect(suggestion?.textContent).toContain(expected)
      suggestion!.click()
      await nextTick()
    }

    async function submit() {
      ;(container!.querySelector('.meta-comment-composer__submit') as HTMLButtonElement).click()
      await nextTick()
    }

    const NO_INITIAL: Mention[] = []

    function mountTabbedHost(options: { keepSelection: boolean; initial?: Mention[]; draft?: string }) {
      const shown = ref(true)
      const draft = ref(options.draft ?? '')
      const initialMentions = shallowRef<Mention[]>(options.initial ?? NO_INITIAL)
      const kept = shallowRef<Selection | null>(null)
      const events: Selection[] = []
      const submitSpy: Array<{ content: string; mentions: string[] }> = []
      container = document.createElement('div')
      document.body.appendChild(container)
      const app = createApp({
        setup() {
          return () => (shown.value
            ? h(MetaCommentComposer, {
              modelValue: draft.value,
              initialMentions: initialMentions.value,
              suggestions: [{ id: 'user_jamie', label: 'Jamie' }],
              // the prop is what opts in; the listener is there either way, to prove nothing is sent without it
              ...(options.keepSelection ? { mentionSelection: kept.value } : {}),
              'onUpdate:mentionSelection': (value: Selection) => {
                events.push(value)
                if (options.keepSelection) kept.value = value
              },
              'onUpdate:modelValue': (value: string) => {
                draft.value = value
              },
              onSubmit: (payload: { content: string; mentions: string[] }) => {
                submitSpy.push(payload)
              },
            })
            : null)
        },
      })
      app.mount(container)
      const remount = async (between?: () => void) => {
        shown.value = false
        await nextTick()
        expect(container!.querySelector('textarea')).toBeNull()
        between?.()
        shown.value = true
        await nextTick()
      }
      return { app, draft, initialMentions, kept, events, submitSpy, remount }
    }

    it('reports nothing unless the host opts in, and reports every change when it does', async () => {
      const plain = mountTabbedHost({ keepSelection: false })
      await nextTick()
      await type('@ja')
      await pickFirstSuggestion('Jamie')
      expect(plain.events).toEqual([])
      // a host that does not keep the selection still loses it on a remount, as before
      await plain.remount()
      expect(chipLabels()).toEqual([])
      plain.app.unmount()
      container!.remove()

      const keeping = mountTabbedHost({ keepSelection: true })
      await nextTick()
      expect(keeping.events.at(-1)).toEqual({ initialMentions: NO_INITIAL, mentions: [], textBoundIds: [] })
      expect(keeping.events.at(-1)!.initialMentions).toBe(NO_INITIAL)
      await type('@ja')
      await pickFirstSuggestion('Jamie')
      expect(keeping.events.at(-1)).toEqual({
        initialMentions: NO_INITIAL,
        mentions: [{ id: 'user_jamie', label: 'Jamie' }],
        textBoundIds: ['user_jamie'],
      })
      keeping.app.unmount()
    })

    it('a pick comes back after a remount, and still follows its text afterwards', async () => {
      const host = mountTabbedHost({ keepSelection: true })
      await nextTick()
      await type('@ja')
      await pickFirstSuggestion('Jamie')
      await host.remount()
      expect(chipLabels()).toEqual(['@Jamie'])
      await submit()
      expect(host.submitSpy).toEqual([{ content: '@[Jamie](user_jamie)', mentions: ['user_jamie'] }])
      // restored as text-bound: deleting its text drops it
      await type('never mind')
      expect(chipLabels()).toEqual([])
      host.app.unmount()
    })

    it('a draft cleared while unmounted drops the picks tied to it', async () => {
      const host = mountTabbedHost({ keepSelection: true })
      await nextTick()
      await type('@ja')
      await pickFirstSuggestion('Jamie')
      await host.remount(() => {
        host.draft.value = ''
      })
      expect(chipLabels()).toEqual([])
      await type('note')
      await submit()
      expect(host.submitSpy).toEqual([{ content: 'note', mentions: [] }])
      host.app.unmount()
    })

    it('a removed edit mention stays removed after a remount, and a new initialMentions array resets the selection', async () => {
      const robin = { id: 'user_fake_robin', label: 'Robin Example' }
      const gone = { id: 'user_fake_gone', label: '', unresolved: true }
      const host = mountTabbedHost({ keepSelection: true, initial: [robin, gone], draft: 'Totals' })
      await nextTick()
      expect(chipLabels()).toEqual(['@Robin Example', '@Unknown user'])
      ;(container!.querySelector('.meta-comment-composer__mention-chip') as HTMLButtonElement).click()
      await nextTick()
      expect(chipLabels()).toEqual(['@Unknown user'])

      await host.remount()
      expect(chipLabels()).toEqual(['@Unknown user'])
      await submit()
      expect(host.submitSpy).toEqual([{ content: 'Totals', mentions: ['user_fake_gone'] }])

      // another edit (a new snapshot array) started while unmounted: its own mentions, not the kept ones
      await host.remount(() => {
        host.initialMentions.value = [robin]
        host.draft.value = 'Other'
      })
      expect(chipLabels()).toEqual(['@Robin Example'])
      // the edit ended while unmounted (the shared empty array again): nothing is kept
      await host.remount(() => {
        host.initialMentions.value = NO_INITIAL
        host.draft.value = ''
      })
      expect(chipLabels()).toEqual([])
      host.app.unmount()
    })
  })
})
