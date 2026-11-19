import { describe, expect, it } from 'vitest'
import {
  AdminGrantApplicationMaterialError,
  adminGrantApplicationMaterialFingerprint,
} from '../../src/auth/admin-grant-application-material'

describe('admin grant application material fingerprint', () => {
  it.each([
    [{}, 'c55c5ae4832b6300cc9db90bbda5c9c4be4bacf0921c339c76cf6484a9778599'],
    [{ appKey: 'key', appSecret: 'secret', baseUrl: null, workNotificationAgentId: null }, 'dd3e565c7025c368375e1451ab24ae72987eb9a28abef47b5d9fafed1d3fe7cc'],
    [{ appKey: 'key', appSecret: 'secret', baseUrl: 'https://oapi.dingtalk.com', workNotificationAgentId: 'agent' }, 'f9d4efc9a6e614b52d9227204b17178242d58f5f206dcde5fb9ab9b8fe94fe4e'],
  ])('preserves the canonical four-slot material hash for %j', (config, expected) => {
    expect(adminGrantApplicationMaterialFingerprint(config)).toBe(expected)
  })

  it('ignores unrelated and inherited fields without trimming material', () => {
    const material = { appKey: 'key', appSecret: 'secret' }
    expect(adminGrantApplicationMaterialFingerprint({ ...material, name: 'unrelated' })).toBe(adminGrantApplicationMaterialFingerprint(material))
    expect(adminGrantApplicationMaterialFingerprint(Object.create(material))).toBe(adminGrantApplicationMaterialFingerprint({}))
    expect(adminGrantApplicationMaterialFingerprint({ ...material, appKey: ' key' })).not.toBe(adminGrantApplicationMaterialFingerprint(material))
    expect(adminGrantApplicationMaterialFingerprint({ ...material, baseUrl: null })).not.toBe(adminGrantApplicationMaterialFingerprint(material))
  })

  it.each([null, [], 'config', 1, { appKey: null }, { appSecret: false }, { baseUrl: 1 }, { workNotificationAgentId: undefined }])('rejects the existing invalid material shape %j', (config) => {
    expect(() => adminGrantApplicationMaterialFingerprint(config)).toThrow(AdminGrantApplicationMaterialError)
    expect(() => adminGrantApplicationMaterialFingerprint(config)).toThrow('Invalid admin grant application material')
  })
})
