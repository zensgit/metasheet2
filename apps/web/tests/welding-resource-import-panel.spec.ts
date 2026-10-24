import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Panel from '../src/views/welding/WeldingResourceImportPanel.vue'
import { importCrypto, importPreview } from './utils/weldingResourceImportFixtures'
import { importHarness } from './utils/weldingResourceImportHarness'
let app: App<Element> | undefined, root: HTMLDivElement, f: ReturnType<typeof importHarness>, previousLocks: PropertyDescriptor | undefined
beforeEach(async () => {
  localStorage.clear(); localStorage.setItem('auth_token', 'synthetic-token'); vi.stubGlobal('crypto', importCrypto); vi.spyOn(window, 'confirm').mockReturnValue(true)
  previousLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, action: () => unknown) => action() } })
  f = importHarness(undefined, 100); root = document.createElement('div'); document.body.appendChild(root)
  app = createApp({ render: () => h(Panel, { imports: f.session }) }); app.mount(root); await f.ready(); await nextTick()
})
afterEach(() => { app?.unmount(); f.session.dispose(); root.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); if (previousLocks) Object.defineProperty(navigator, 'locks', previousLocks); else Reflect.deleteProperty(navigator, 'locks') })
describe('whole batch import panel', () => {
  it('renders every payload/source and all 100 confirmed identities with fixed-read actions', async () => {
    expect(root.querySelectorAll('[data-import-preview-row]')).toHaveLength(100)
    expect(root.querySelectorAll('[data-import-preview-row]')[99].textContent).toContain('row-99')
    expect(root.querySelectorAll('[data-import-preview-row]')[99].textContent).toContain('material_b')
    const confirm = [...root.querySelectorAll('button')].find(button => button.textContent === '确认整批新建 100 条 Draft')!
    expect(confirm.disabled).toBe(false); confirm.click()
    await vi.waitFor(() => expect(root.querySelectorAll('[data-import-receipt-row]')).toHaveLength(100))
    expect(root.querySelectorAll('[data-import-receipt-row]')[99].textContent).toContain('version-101')
    expect(root.querySelectorAll('[data-import-receipt-row]')[99].textContent).toContain('d'.repeat(64))
    expect(f.api.readResource).not.toHaveBeenCalled()
    ;(root.querySelector('[data-import-receipt-row] button') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(root.querySelector('[aria-label="导入固定详情"]')?.textContent).toContain('resource-2'))
  })
  it('shows the trailing hundredth issue, file-level issue and safe text without exposing commit', async () => {
    const preview = importPreview(100); preview.ready = false; preview.preview_digest = null; preview.rows.pop()
    preview.errors = [{ row: 101, column: 'name', code: 'invalid', message: '<script>last row</script>' }, { row: null, column: '', code: 'empty', message: 'file issue' }]
    f.api.previewResourceImport.mockResolvedValue(preview); await f.session.preview(); await nextTick()
    expect(root.querySelectorAll('[data-import-issue]')).toHaveLength(2); expect(root.textContent).toContain('文件行 101'); expect(root.textContent).toContain('文件级问题')
    expect(root.textContent).toContain('<script>last row</script>'); expect(root.querySelector('script')).toBeNull()
    expect([...root.querySelectorAll('button')].find(button => button.textContent === '确认整批新建 100 条 Draft')?.disabled).toBe(true)
    expect(f.api.commitResourceImport).not.toHaveBeenCalled()
  })
  it('shows durable request identities and an explicit replay action after unknown ACK', async () => {
    f.api.commitResourceImport.mockRejectedValueOnce(new Error('lost ACK')); await f.session.commit(); await nextTick()
    expect(root.textContent).toContain('服务器可能已经提交'); expect(root.textContent).toContain('batch-original')
    expect(root.querySelector('[aria-label="整批原请求待核对"]')?.textContent).toContain('row-99')
    expect((root.querySelector('input[type=file]') as HTMLInputElement).disabled).toBe(true)
    expect([...root.querySelectorAll('button')].some(button => button.textContent === '明确重放同一整批原请求')).toBe(true)
    expect(f.api.commitResourceImport).toHaveBeenCalledTimes(1)
  })
})
