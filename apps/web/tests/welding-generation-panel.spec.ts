import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, reactive, type App } from 'vue'
import WeldingGenerationPanel from '../src/views/welding/WeldingGenerationPanel.vue'
let app: App | null = null, root: HTMLElement | null = null
afterEach(() => { app?.unmount(); root?.remove() })
describe('finite generation controls', () => {
  it('renders the real generation controls without future workflow buttons', () => {
    root = document.createElement('div'); document.body.append(root)
    const generation = { state: reactive({ templates: [], templateIndex: -1, options: { organization_name: '', header_text: '', footer_text: '', optional_columns: [], logo: null }, working: false, pending: null, current: null, items: [], total: 0, offset: 0, message: '', previewUrl: '' }), canCreate: { value: false }, canRetry: { value: false }, canConfirm: { value: false }, refresh() {}, create() {}, selectTemplate() {}, setLogo() {}, select() {}, retryFailed() {}, confirmOriginal() {}, download() {}, cancelDownload() {}, freshness: () => '旧保存内容' }
    app = createApp({ render: () => h(WeldingGenerationPanel, { generation }) }); app.mount(root)
    expect(root.textContent).toContain('指导书')
    expect(root.textContent).toContain('生成评审文件')
    expect(root.textContent).not.toMatch(/提交评审|生成批准文件|建立下一修订/)
  })
})
