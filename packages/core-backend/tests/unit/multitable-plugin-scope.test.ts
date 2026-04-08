import { describe, expect, it, vi } from 'vitest'

import {
  MultitableProjectNamespaceError,
  assertProjectIdAllowedForPlugin,
  createPluginScopedMultitableApi,
  getPluginProjectNamespaces,
} from '../../src/multitable/plugin-scope'

describe('multitable plugin scope helper', () => {
  it('derives plugin namespaces from both raw and plugin-stripped names', () => {
    expect(getPluginProjectNamespaces('plugin-after-sales')).toEqual([
      'plugin-after-sales',
      'after-sales',
    ])
    expect(getPluginProjectNamespaces('attendance')).toEqual(['attendance'])
  })

  it('allows project ids within the plugin namespace convention', () => {
    expect(() =>
      assertProjectIdAllowedForPlugin('plugin-after-sales', 'tenant_42:after-sales'),
    ).not.toThrow()
    expect(() =>
      assertProjectIdAllowedForPlugin('plugin-after-sales', 'tenant_42:plugin-after-sales'),
    ).not.toThrow()
  })

  it('rejects project ids owned by another plugin namespace', () => {
    expect(() =>
      assertProjectIdAllowedForPlugin('plugin-attendance', 'tenant_42:after-sales'),
    ).toThrow(MultitableProjectNamespaceError)
  })

  it('wraps provisioning methods with namespace checks', async () => {
    const multitable = {
      provisioning: {
        getObjectSheetId: vi.fn(() => 'sheet_1'),
        getFieldId: vi.fn(() => 'fld_1'),
        ensureObject: vi.fn(async () => ({
          baseId: 'base_legacy',
          sheet: { id: 'sheet_1', baseId: 'base_legacy', name: 'Ticket', description: null },
          fields: [],
        })),
        ensureView: vi.fn(async () => ({
          id: 'view_1',
          sheetId: 'sheet_1',
          name: 'Grid',
          type: 'grid',
          filterInfo: {},
          sortInfo: {},
          groupInfo: {},
          hiddenFieldIds: [],
          config: {},
        })),
      },
      records: {
        listRecords: vi.fn(),
        queryRecords: vi.fn(),
        createRecord: vi.fn(),
        getRecord: vi.fn(),
        patchRecord: vi.fn(),
        deleteRecord: vi.fn(),
      },
    }

    const scoped = createPluginScopedMultitableApi(multitable as any, 'plugin-after-sales')

    expect(scoped.provisioning.getObjectSheetId('tenant_42:after-sales', 'serviceTicket')).toBe('sheet_1')
    expect(scoped.provisioning.getFieldId('tenant_42:after-sales', 'serviceTicket', 'status')).toBe('fld_1')
    await expect(
      scoped.provisioning.ensureObject({
        projectId: 'tenant_42:after-sales',
        descriptor: { id: 'serviceTicket', name: 'Ticket', fields: [] },
      } as any),
    ).resolves.toMatchObject({
      sheet: { id: 'sheet_1' },
    })

    expect(() =>
      scoped.provisioning.getObjectSheetId('tenant_42:attendance', 'serviceTicket'),
    ).toThrow(MultitableProjectNamespaceError)
    expect(() =>
      scoped.provisioning.getFieldId('tenant_42:attendance', 'serviceTicket', 'status'),
    ).toThrow(MultitableProjectNamespaceError)
    await expect(
      scoped.provisioning.ensureView({
        projectId: 'tenant_42:attendance',
        sheetId: 'sheet_1',
        descriptor: { id: 'view_1', name: 'Grid', type: 'grid' },
      } as any),
    ).rejects.toThrow(MultitableProjectNamespaceError)
  })
})
