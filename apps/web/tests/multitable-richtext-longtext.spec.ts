import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaRichLongTextRender from '../src/multitable/components/cells/MetaRichLongTextRender.vue'
import {
  sanitizeRichLongTextHtml,
  richLongTextToPlainTextFE,
  isRichLongTextField,
  RICH_LONGTEXT_SANITIZE_CONFIG,
} from '../src/multitable/utils/rich-longtext'

// §8 fail-first matrix for the rich-`longText` FE render lane.
//
// These tests exercise the REAL shared sanitizer (`sanitizeRichLongTextHtml`) and
// the REAL render component (`MetaRichLongTextRender`), NOT a hand-rolled DOMPurify
// call — so the test asserts the exact allow-list the component ships (no
// wire-vs-fixture drift). The component is the sole `v-html` owner; if its policy
// ever loosens, these canaries fail.

/** Has the sanitized output any executable / unsafe residue? */
function hasExecutableResidue(html: string): boolean {
  const low = html.toLowerCase()
  return (
    low.includes('<script') ||
    low.includes('<iframe') ||
    low.includes('<object') ||
    low.includes('<embed') ||
    low.includes('<form') ||
    low.includes('<svg') ||
    low.includes('<img') ||
    low.includes('javascript:') ||
    low.includes('vbscript:') ||
    low.includes('data:text/html') ||
    low.includes('<math') ||
    low.includes('<template') ||
    low.includes('<base') ||
    low.includes('<meta') ||
    low.includes('srcdoc') ||
    low.includes('formaction') ||
    low.includes('onerror') ||
    low.includes('onmouseover') ||
    /\son\w+\s*=/.test(low) ||
    low.includes('style=')
  )
}

describe('rich-longText FE sanitizer — §8 XSS canaries (every one neutralized)', () => {
  const canaries: Array<{ name: string; payload: string }> = [
    { name: 'script tag', payload: '<script>alert(1)</script>' },
    { name: 'img onerror', payload: '<img src=x onerror=alert(1)>' },
    { name: 'javascript: link', payload: '<a href="javascript:alert(1)">x</a>' },
    { name: 'encoded javascript: link', payload: '<a href="&#106;avascript:alert(1)">x</a>' },
    { name: 'inline event handler', payload: '<p onmouseover="alert(1)">x</p>' },
    { name: 'style url() injection', payload: '<div style="background:url(javascript:alert(1))">x</div>' },
    {
      name: 'embedded/foreign content',
      payload: '<iframe src=//evil></iframe><object></object><embed><form></form>',
    },
    {
      name: 'mXSS noscript breakout',
      payload: '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    },
    // Extra adversarial probes (review N1/N2) — namespace confusion, DOM clobbering,
    // alternative protocols, and document-level vectors. The allow-list excludes all of
    // these tags/attrs; these canaries pin the regression net against a future config edit.
    { name: 'MathML namespace confusion', payload: '<math><mtext><script>alert(1)</script></mtext></math>' },
    { name: 'svg script', payload: '<svg><script>alert(1)</script></svg>' },
    { name: 'svg foreignObject', payload: '<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>' },
    { name: 'template smuggling', payload: '<template><img src=x onerror=alert(1)></template>' },
    { name: 'iframe srcdoc', payload: '<iframe srcdoc="<img src=x onerror=alert(1)>"></iframe>' },
    { name: 'DOM clobbering id=form', payload: '<form id="form"><input name="attributes"></form>' },
    { name: 'formaction button', payload: '<button formaction="javascript:alert(1)">x</button>' },
    { name: 'base href hijack', payload: '<base href="//evil/">' },
    { name: 'meta refresh', payload: '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">' },
    { name: 'vbscript link', payload: '<a href="vbscript:msgbox(1)">x</a>' },
    { name: 'data:text/html link', payload: '<a href="data:text/html,<script>alert(1)</script>">x</a>' },
    { name: 'whitespace-split javascript: link', payload: '<a href="java\tscript:alert(1)">x</a>' },
  ]

  for (const { name, payload } of canaries) {
    it(`neutralizes: ${name}`, () => {
      const out = sanitizeRichLongTextHtml(payload)
      expect(hasExecutableResidue(out), `unsafe residue in: ${out}`).toBe(false)
    })
  }

  it('drops the href on a javascript: link but keeps the text', () => {
    const out = sanitizeRichLongTextHtml('<a href="javascript:alert(1)">click</a>')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('href')
    expect(out).toContain('click')
  })

  it('drops the href on an entity-encoded javascript: link', () => {
    const out = sanitizeRichLongTextHtml('<a href="&#106;avascript:alert(1)">click</a>')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('href')
    expect(out).toContain('click')
  })

  it('strips a protocol-relative link href (//evil.com)', () => {
    const out = sanitizeRichLongTextHtml('<a href="//evil.com">x</a>')
    expect(out).not.toContain('href')
    expect(out).toContain('x')
  })
})

describe('rich-longText FE sanitizer — benign formatting preserved (§8.9)', () => {
  it('keeps bold / italic / link / list / heading and forces rel+target', () => {
    const out = sanitizeRichLongTextHtml(
      '<strong>hi</strong> <em>there</em> <a href="https://x.com">link</a><ul><li>a</li></ul><h1>H</h1>',
    )
    expect(out).toContain('<strong>hi</strong>')
    expect(out).toContain('<em>there</em>')
    expect(out).toContain('<a href="https://x.com"')
    expect(out).toContain('rel="noopener noreferrer"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('<ul><li>a</li></ul>')
    expect(out).toContain('<h1>H</h1>')
  })

  it('keeps underline / strike / blockquote / code / pre', () => {
    const out = sanitizeRichLongTextHtml(
      '<u>u</u><s>s</s><blockquote>q</blockquote><code>c</code><pre>p</pre>',
    )
    expect(out).toContain('<u>u</u>')
    expect(out).toContain('<s>s</s>')
    expect(out).toContain('<blockquote>q</blockquote>')
    expect(out).toContain('<code>c</code>')
    expect(out).toContain('<pre>p</pre>')
  })

  it('keeps an https link with its safe href', () => {
    const out = sanitizeRichLongTextHtml('<a href="https://example.com/path?q=1">e</a>')
    expect(out).toContain('href="https://example.com/path?q=1"')
  })

  it('keeps a mailto link', () => {
    const out = sanitizeRichLongTextHtml('<a href="mailto:a@b.com">mail</a>')
    expect(out).toContain('href="mailto:a@b.com"')
  })

  // B5: the people-mention chip is the ONLY reason <span>/data-mention-id are
  // allow-listed. A real chip must survive; a forged one must be defanged. These
  // canaries pin the §5 allow-list extension on the FE side, lock-step with the
  // server spec (richtext-longtext-sanitizer.test.ts).
  it('B5: keeps a real mention chip <span data-mention-id> unchanged', () => {
    const out = sanitizeRichLongTextHtml('<span data-mention-id="user_42">@Jamie</span>')
    expect(out).toContain('data-mention-id="user_42"')
    expect(out).toContain('@Jamie')
    expect(hasExecutableResidue(out)).toBe(false)
  })

  it('B5: strips a forged chip handler/style but keeps the inert id', () => {
    const out = sanitizeRichLongTextHtml(
      '<span data-mention-id="user_42" onclick="alert(1)" style="position:fixed">x</span>',
    )
    expect(hasExecutableResidue(out)).toBe(false)
    expect(out.toLowerCase()).not.toContain('onclick')
    expect(out).toContain('data-mention-id="user_42"')
  })

  it('B5: scopes data-mention-id to <span> only (stripped from a <b>)', () => {
    const out = sanitizeRichLongTextHtml('<b data-mention-id="user_42">bold</b>')
    expect(out).not.toContain('data-mention-id')
    expect(out).toContain('<b>bold</b>')
  })
})

describe('rich-longText FE plain-text projection (§7, grid-cell consumer)', () => {
  it('strips all tags down to text content', () => {
    const out = richLongTextToPlainTextFE('<p>Hello <strong>World</strong></p>')
    expect(out).not.toMatch(/[<>]/)
    expect(out).toContain('Hello')
    expect(out).toContain('World')
  })

  it('flattens lists to text', () => {
    const out = richLongTextToPlainTextFE('<ul><li>a</li><li>b</li></ul>')
    expect(out).not.toMatch(/[<>]/)
    expect(out).toContain('a')
    expect(out).toContain('b')
  })

  it('returns plain (non-rich) text unchanged', () => {
    expect(richLongTextToPlainTextFE('just text')).toBe('just text')
  })

  it('never leaks executable markup into the projection', () => {
    const out = richLongTextToPlainTextFE('<script>alert(1)</script>visible')
    expect(out).not.toContain('script')
    expect(out).not.toContain('alert')
    expect(out).toContain('visible')
  })

  it('handles empty / nullish input', () => {
    expect(richLongTextToPlainTextFE('')).toBe('')
    expect(richLongTextToPlainTextFE(null)).toBe('')
    expect(richLongTextToPlainTextFE(undefined)).toBe('')
  })
})

describe('isRichLongTextField — strict opt-in predicate', () => {
  it('true only for longText with property.rich === true', () => {
    expect(isRichLongTextField({ type: 'longText', property: { rich: true } } as never)).toBe(true)
  })
  it('false for truthy-but-non-boolean rich', () => {
    expect(isRichLongTextField({ type: 'longText', property: { rich: 'true' } } as never)).toBe(false)
    expect(isRichLongTextField({ type: 'longText', property: { rich: 1 } } as never)).toBe(false)
  })
  it('false for plain longText (no rich)', () => {
    expect(isRichLongTextField({ type: 'longText', property: {} } as never)).toBe(false)
    expect(isRichLongTextField({ type: 'longText' } as never)).toBe(false)
  })
  it('false for non-longText even with rich:true', () => {
    expect(isRichLongTextField({ type: 'string', property: { rich: true } } as never)).toBe(false)
  })
})

describe('MetaRichLongTextRender component — sole v-html owner, re-sanitizes on bind', () => {
  function mount(html: unknown) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render() {
        return h(MetaRichLongTextRender, { html })
      },
    })
    app.mount(container)
    return { container, app }
  }

  it('renders benign formatting as real DOM (bold + link)', async () => {
    const { container, app } = mount('<strong>hi</strong> <a href="https://x.com">l</a>')
    await nextTick()
    const root = container.querySelector('.meta-rich-longtext') as HTMLElement
    expect(root.querySelector('strong')?.textContent).toBe('hi')
    const a = root.querySelector('a') as HTMLAnchorElement
    expect(a.getAttribute('href')).toBe('https://x.com')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    expect(a.getAttribute('target')).toBe('_blank')
    app.unmount()
    container.remove()
  })

  it('injects NO script element for a script payload', async () => {
    const { container, app } = mount('<script>window.__pwned = 1</script>safe')
    await nextTick()
    const root = container.querySelector('.meta-rich-longtext') as HTMLElement
    expect(root.querySelector('script')).toBeNull()
    expect(root.innerHTML).not.toContain('script')
    expect(root.textContent).toContain('safe')
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
    app.unmount()
    container.remove()
  })

  it('injects NO img with onerror', async () => {
    const { container, app } = mount('<img src=x onerror="window.__pwned2 = 1">')
    await nextTick()
    const root = container.querySelector('.meta-rich-longtext') as HTMLElement
    expect(root.querySelector('img')).toBeNull()
    expect(root.innerHTML.toLowerCase()).not.toContain('onerror')
    app.unmount()
    container.remove()
  })

  it('re-sanitizes when the bound value changes (every bind, not once)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    let current: unknown = '<strong>first</strong>'
    const app = createApp({
      data: () => ({ html: current }),
      render(this: { html: unknown }) {
        return h(MetaRichLongTextRender, { html: this.html })
      },
      mounted(this: { html: unknown }) {
        // expose a setter so the test can mutate the bound value
        ;(this as unknown as { setHtml: (v: unknown) => void }).setHtml = (v: unknown) => {
          this.html = v
        }
      },
    })
    const vm = app.mount(container) as unknown as { setHtml: (v: unknown) => void }
    await nextTick()
    let root = container.querySelector('.meta-rich-longtext') as HTMLElement
    expect(root.querySelector('strong')?.textContent).toBe('first')
    // Re-bind a malicious value: it must ALSO be sanitized.
    vm.setHtml('<img src=x onerror="window.__pwned3 = 1"><em>second</em>')
    await nextTick()
    root = container.querySelector('.meta-rich-longtext') as HTMLElement
    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('em')?.textContent).toBe('second')
    expect((window as unknown as { __pwned3?: number }).__pwned3).toBeUndefined()
    app.unmount()
    container.remove()
    void current
  })
})

describe('shared config invariants', () => {
  it('exports a frozen sanitize config (no runtime policy mutation)', () => {
    expect(Object.isFrozen(RICH_LONGTEXT_SANITIZE_CONFIG)).toBe(true)
  })
})
