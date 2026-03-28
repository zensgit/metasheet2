import { describe, expect, it } from 'vitest'
import { defineComponent } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { buildMultitableRoute, resolveMultitableRouteProps } from '../src/router/multitableRoute'
import { AppRouteNames, ROUTE_PATHS } from '../src/router/types'

function resolveMultitableProps(path: string) {
  const MultitableRouteStub = defineComponent({
    name: 'MultitableRouteStub',
    template: '<div />',
  })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [buildMultitableRoute(MultitableRouteStub)],
  })

  return router.push(path).then(async () => {
    await router.isReady()
    expect(router.currentRoute.value.name).toBe(AppRouteNames.MULTITABLE)
    const matched = router.currentRoute.value.matched.find((record) => record.name === AppRouteNames.MULTITABLE)
    expect(matched?.path).toBe(ROUTE_PATHS.MULTITABLE)
    return resolveMultitableRouteProps(router.currentRoute.value as any)
  })
}

describe('multitable app shell route wiring', () => {
  it('maps the pilot grid URL contract into embed host props', async () => {
    const props = await resolveMultitableProps('/multitable/sheet_orders/view_grid?baseId=base_ops')

    expect(props).toEqual({
      baseId: 'base_ops',
      sheetId: 'sheet_orders',
      viewId: 'view_grid',
      recordId: undefined,
      mode: undefined,
      embedded: undefined,
      role: undefined,
    })
  })

  it('maps the pilot form URL contract and ignores invalid optional query values', async () => {
    const props = await resolveMultitableProps('/multitable/sheet_orders/view_form?baseId=base_ops&mode=form&recordId=rec_123&embedded=1&role=viewer&unknown=skipme')

    expect(props).toEqual({
      baseId: 'base_ops',
      sheetId: 'sheet_orders',
      viewId: 'view_form',
      recordId: 'rec_123',
      mode: 'form',
      embedded: true,
      role: 'viewer',
    })
  })
})
