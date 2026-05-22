import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLocale } from '../src/composables/useLocale'
import { useMultitableRecordPermissions } from '../src/multitable/composables/useMultitableRecordPermissions'

describe('useMultitableRecordPermissions i18n fallbacks', () => {
  beforeEach(() => {
    useLocale().setLocale('en')
  })

  it('localizes frontend load fallback when backend message is absent', async () => {
    useLocale().setLocale('zh-CN')
    const state = useMultitableRecordPermissions({
      listRecordPermissions: vi.fn().mockRejectedValue({}),
    } as any)

    await state.loadPermissions('sheet_1', 'record_1')

    expect(state.error.value).toBe('加载记录权限失败')
  })

  it('keeps backend grant errors raw ahead of localized fallbacks', async () => {
    useLocale().setLocale('zh-CN')
    const state = useMultitableRecordPermissions({
      updateRecordPermission: vi.fn().mockRejectedValue(new Error('backend grant raw')),
    } as any)

    await expect(state.grantPermission('sheet_1', 'record_1', 'user', 'user_1', 'read')).rejects.toThrow('backend grant raw')

    expect(state.error.value).toBe('backend grant raw')
  })
})
