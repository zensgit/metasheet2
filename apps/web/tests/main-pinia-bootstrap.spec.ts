import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('web bootstrap Pinia runtime wiring', () => {
  it('installs Pinia before the router mounts route components', () => {
    const source = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8')

    expect(source).toContain("import { createPinia } from 'pinia'")
    expect(source).toContain('app.use(createPinia())')

    const piniaIndex = source.indexOf('app.use(createPinia())')
    const routerIndex = source.indexOf('app.use(router)')
    expect(piniaIndex).toBeGreaterThan(-1)
    expect(routerIndex).toBeGreaterThan(-1)
    expect(piniaIndex).toBeLessThan(routerIndex)
  })
})
