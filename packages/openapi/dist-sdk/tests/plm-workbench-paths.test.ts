import { describe, expectTypeOf, it } from 'vitest'

import type { paths } from '../index.js'

describe('plm-workbench OpenAPI paths', () => {
  it('exposes core team view routes in generated SDK types', () => {
    expectTypeOf<paths['/api/plm-workbench/views/team']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/views/team/{id}']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/views/team/batch']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/views/team/{id}/default']>().toBeObject()
  })

  it('exposes core team preset routes in generated SDK types', () => {
    expectTypeOf<paths['/api/plm-workbench/filter-presets/team']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/filter-presets/team/{id}']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/filter-presets/team/batch']>().toBeObject()
    expectTypeOf<paths['/api/plm-workbench/filter-presets/team/{id}/default']>().toBeObject()
  })
})
