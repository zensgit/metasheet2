import { describe, it, expect } from 'vitest'
import { ref, nextTick } from 'vue'
import { useMultitableCapabilities, type MultitableRole } from '../src/multitable/composables/useMultitableCapabilities'

describe('useMultitableCapabilities', () => {
  it('owner has all capabilities', () => {
    const role = ref<MultitableRole>('owner')
    const caps = useMultitableCapabilities(role)
    expect(caps.canRead.value).toBe(true)
    expect(caps.canCreateRecord.value).toBe(true)
    expect(caps.canEditRecord.value).toBe(true)
    expect(caps.canDeleteRecord.value).toBe(true)
    expect(caps.canManageFields.value).toBe(true)
    expect(caps.canManageSheetAccess.value).toBe(true)
    expect(caps.canManageViews.value).toBe(true)
    expect(caps.canComment.value).toBe(true)
    expect(caps.canManageAutomation.value).toBe(true)
  })

  it('editor cannot manage fields/views/automation', () => {
    const caps = useMultitableCapabilities(ref<MultitableRole>('editor'))
    expect(caps.canEditRecord.value).toBe(true)
    expect(caps.canManageFields.value).toBe(false)
    expect(caps.canManageSheetAccess.value).toBe(false)
    expect(caps.canManageViews.value).toBe(false)
    expect(caps.canManageAutomation.value).toBe(false)
  })

  it('commenter can only read and comment', () => {
    const caps = useMultitableCapabilities(ref<MultitableRole>('commenter'))
    expect(caps.canRead.value).toBe(true)
    expect(caps.canComment.value).toBe(true)
    expect(caps.canCreateRecord.value).toBe(false)
    expect(caps.canEditRecord.value).toBe(false)
  })

  it('viewer can only read', () => {
    const caps = useMultitableCapabilities(ref<MultitableRole>('viewer'))
    expect(caps.canRead.value).toBe(true)
    expect(caps.canComment.value).toBe(false)
    expect(caps.canCreateRecord.value).toBe(false)
  })

  it('reacts to role changes', async () => {
    const role = ref<MultitableRole>('viewer')
    const caps = useMultitableCapabilities(role)
    expect(caps.canEditRecord.value).toBe(false)

    role.value = 'editor'
    await nextTick()
    expect(caps.canEditRecord.value).toBe(true)
  })

  it('prefers backend capability objects when provided', async () => {
    const caps = useMultitableCapabilities(ref({
      canRead: true,
      canCreateRecord: false,
      canEditRecord: true,
      canDeleteRecord: false,
      canManageFields: true,
      canManageSheetAccess: false,
      canManageViews: false,
      canComment: true,
      canManageAutomation: false, canExport: true,
    }))

    await nextTick()
    expect(caps.canRead.value).toBe(true)
    expect(caps.canCreateRecord.value).toBe(false)
    expect(caps.canEditRecord.value).toBe(true)
    expect(caps.canManageFields.value).toBe(true)
    expect(caps.canManageSheetAccess.value).toBe(false)
    expect(caps.canManageViews.value).toBe(false)
  })
})
