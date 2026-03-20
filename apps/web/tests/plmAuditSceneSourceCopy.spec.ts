import { describe, expect, it } from 'vitest'
import { buildPlmAuditSceneSourceCopy } from '../src/views/plmAuditSceneSourceCopy'

function tr(en: string, zh: string) {
  return `${en}|${zh}`
}

describe('plmAuditSceneSourceCopy', () => {
  it('builds summary source copy', () => {
    expect(buildPlmAuditSceneSourceCopy('summary', tr)).toEqual({
      label: 'Local context|本地上下文',
      description: 'This summary reflects the current local scene or owner context.|这个汇总反映的是当前本地场景或 owner 上下文。',
    })
  })

  it('builds saved-view source copy', () => {
    expect(buildPlmAuditSceneSourceCopy('saved-view', tr)).toEqual({
      label: 'Saved view context|保存视图上下文',
      description: 'This scene or owner context is stored with the local saved view.|这个场景或 owner 上下文会随本地保存视图一起保存。',
    })
  })

  it('builds team-view source copy', () => {
    expect(buildPlmAuditSceneSourceCopy('team-view', tr)).toEqual({
      label: 'Local-only context|仅本地上下文',
      description: 'This scene or owner context is local to the current audit session and is not persisted in team views.|这个场景或 owner 上下文只属于当前审计会话，不会持久化进团队视图。',
    })
  })
})
