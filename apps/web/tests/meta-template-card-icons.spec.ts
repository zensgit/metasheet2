import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, type App } from 'vue'
import {
  Box,
  CircleCheck,
  DataLine,
  Document,
  Grid,
  Notebook,
  User,
  Warning,
} from '@element-plus/icons-vue'
import MetaTemplateCard from '../src/multitable/components/MetaTemplateCard.vue'
import type { MetaTemplate } from '../src/multitable/types'
import {
  resolveTemplateIcon,
  templateIconFallback,
} from '../src/multitable/utils/template-icons'
import { useLocale } from '../src/composables/useLocale'

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []

afterEach(() => {
  while (mounts.length) {
    const mounted = mounts.pop()!
    mounted.app.unmount()
    mounted.container.remove()
  }
  useLocale().setLocale('en')
})

function makeTemplate(icon: string, name = 'Project Tracker'): MetaTemplate {
  return {
    id: 'template-1',
    name,
    description: 'Template description',
    category: 'Project management',
    icon,
    color: '#2563eb',
    sheets: [],
  }
}

function mountCard(template: MetaTemplate): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    setup: () => () => h(MetaTemplateCard, { template }),
  })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

describe('template icon mapping', () => {
  it.each([
    ['kanban', Grid],
    ['pipeline', DataLine],
    ['bug', Warning],
    ['contract', Document],
    ['inspection', CircleCheck],
    ['recruit', User],
    ['notes', Notebook],
    ['asset', Box],
  ])('maps %s to its Element Plus icon', (token, icon) => {
    expect(resolveTemplateIcon(token)).toBe(icon)
  })

  it('normalizes known tokens and rejects unknown tokens', () => {
    expect(resolveTemplateIcon(' KANBAN ')).toBe(Grid)
    expect(resolveTemplateIcon('unknown-token')).toBeNull()
    expect(resolveTemplateIcon('')).toBeNull()
  })

  it('builds a stable first-character fallback', () => {
    expect(templateIconFallback('  custom template')).toBe('C')
    expect(templateIconFallback('istanbul tracker')).toBe('I')
    expect(templateIconFallback('')).toBe('?')
    expect(templateIconFallback(null)).toBe('?')
    expect(templateIconFallback(undefined)).toBe('?')
  })
})

describe('MetaTemplateCard template icon', () => {
  it.each(['kanban', 'pipeline', 'bug', 'contract', 'inspection', 'recruit', 'notes', 'asset'])(
    'renders the known %s token as an SVG instead of raw text',
    (token) => {
      const root = mountCard(makeTemplate(token))
      const icon = root.querySelector('.meta-template-card__icon')

      expect(icon?.getAttribute('aria-hidden')).toBe('true')
      expect(icon?.querySelector('svg')).not.toBeNull()
      expect(icon?.querySelector('.meta-template-card__icon-fallback')).toBeNull()
      expect(icon?.textContent).not.toContain(token)
    },
  )

  it('renders only the template initial for an unknown token', () => {
    const root = mountCard(makeTemplate('very-long-internal-token', 'custom workflow'))
    const icon = root.querySelector('.meta-template-card__icon')

    expect(icon?.querySelector('svg')).toBeNull()
    expect(icon?.querySelector('.meta-template-card__icon-fallback')?.textContent).toBe('C')
    expect(icon?.textContent).not.toContain('very-long-internal-token')
  })
})
