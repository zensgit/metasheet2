import { describe, expectTypeOf, it } from 'vitest'

import type { paths } from '../index.js'

describe('plm-workbench OpenAPI paths', () => {
  it('exposes core team view routes in generated SDK types', () => {
    expectTypeOf<paths['/api/plm-workbench/audit-logs']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/audit-logs/export.csv']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/audit-logs/summary']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/views/team']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/views/team/{id}']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/views/team/batch']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/views/team/{id}/default']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/views/team/{id}/duplicate']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/views/team/{id}/transfer']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/views/team/{id}/archive']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/views/team/{id}/restore']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/views/team/{id}/default']['delete']>().not.toBeNever()
    expectTypeOf<paths['/api/plm-workbench/views/team/{id}/restore']['delete']>().toBeNever()
  })

  it('exposes core team preset routes in generated SDK types', () => {
    expectTypeOf<paths['/api/plm-workbench/filter-presets/team']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/filter-presets/team/{id}']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/filter-presets/team/batch']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/filter-presets/team/{id}/default']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/filter-presets/team/{id}/duplicate']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/filter-presets/team/{id}/transfer']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/filter-presets/team/{id}/archive']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/filter-presets/team/{id}/restore']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/filter-presets/team/{id}/default']['delete']>().not.toBeNever()
    expectTypeOf<paths['/api/plm-workbench/filter-presets/team/{id}/restore']['delete']>().toBeNever()
  })
})
