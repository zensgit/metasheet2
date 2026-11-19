import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import PermissionBusinessChecker from '../src/views/PermissionBusinessChecker.vue'
import { businessCheckMultitableLocation } from '../src/views/permissionBusinessChecker'
import { buildMultitableRoute, resolveMultitableRouteProps } from '../src/router/multitableRoute'
import { AppRouteNames } from '../src/router/types'

const checkedMemberId = 'subject-checked'

const linkTarget = { template: '<div />' }

function locationRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: linkTarget },
      buildMultitableRoute(linkTarget),
    ],
  })
}

async function flushUi(): Promise<void> {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

async function choosePolicy(root: ParentNode, policyId: string): Promise<void> {
  const select = root.querySelector('[data-testid="permission-business-policy"]') as HTMLSelectElement
  select.value = policyId
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await flushUi()
}

async function fillField(root: ParentNode, field: string, value: string): Promise<void> {
  const input = root.querySelector(`[data-testid="permission-business-${field}"]`) as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushUi()
}

function contextLink(root: ParentNode): HTMLAnchorElement | null {
  return root.querySelector('[data-testid="permission-business-multitable-link"]')
}

describe('business check multitable location', () => {
  it('opens the named multitable route only for a valid sheet and view', async () => {
    expect(businessCheckMultitableLocation({ sheetId: 'sheet.1' })).toBeNull()
    expect(businessCheckMultitableLocation({ sheetId: 'sheet.1', viewId: '   ' })).toBeNull()
    expect(businessCheckMultitableLocation({ sheetId: 'sheet.1', viewId: 'view/1' })).toBeNull()

    const location = businessCheckMultitableLocation({
      baseId: ' base_1 ',
      sheetId: ' sheet.1 ',
      viewId: ' view:1 ',
      recordId: 'rec.1',
      fieldId: 'fld:1',
    })
    expect(location).toEqual({
      name: AppRouteNames.MULTITABLE,
      params: { sheetId: 'sheet.1', viewId: 'view:1' },
      query: { baseId: 'base_1', recordId: 'rec.1', fieldId: 'fld:1' },
    })
    expect(JSON.stringify(location)).not.toContain(checkedMemberId)
    expect(JSON.stringify(location)).not.toContain('role')

    const omitted = businessCheckMultitableLocation({
      sheetId: 'sheet.1',
      viewId: 'view:1',
      recordId: 'rec/1',
    })
    expect(omitted).toEqual({
      name: AppRouteNames.MULTITABLE,
      params: { sheetId: 'sheet.1', viewId: 'view:1' },
      query: {},
    })

    const router = locationRouter()
    const href = router.resolve(location || '/').href
    expect(href).toBe('/multitable/sheet.1/view:1?baseId=base_1&recordId=rec.1&fieldId=fld:1')
    expect(href).not.toContain(checkedMemberId)
    expect(href).not.toContain('role=')
    await router.push(href)
    expect(router.currentRoute.value.name).toBe(AppRouteNames.MULTITABLE)
    expect(resolveMultitableRouteProps(router.currentRoute.value)).toMatchObject({
      baseId: 'base_1',
      sheetId: 'sheet.1',
      viewId: 'view:1',
      recordId: 'rec.1',
      fieldId: 'fld:1',
      role: undefined,
    })
    expect(router.currentRoute.value.query.userId).toBeUndefined()
    expect(router.currentRoute.value.fullPath).not.toContain(checkedMemberId)
  })
})

describe('PermissionBusinessChecker multitable link', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  function mountChecker(router: Router | null): HTMLDivElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(PermissionBusinessChecker, { userId: checkedMemberId })
    if (router) app.use(router)
    app.mount(container)
    return container
  }

  it('links the current sheet and view, then drops that route when the input changes', async () => {
    const router = locationRouter()
    const root = mountChecker(router)
    await choosePolicy(root, 'multitable.context.view-access')
    expect(contextLink(root)).toBeNull()
    await fillField(root, 'baseId', ' base_1 ')
    await fillField(root, 'sheetId', 'sheet.1')
    expect(contextLink(root)).toBeNull()
    await fillField(root, 'viewId', ' view:1 ')

    const link = contextLink(root)
    const href = link?.getAttribute('href') || ''
    const location = businessCheckMultitableLocation({
      baseId: ' base_1 ',
      sheetId: 'sheet.1',
      viewId: ' view:1 ',
    })
    expect(href).toBe('/multitable/sheet.1/view:1?baseId=base_1')
    expect(href).toBe(router.resolve(location || '/').href)
    expect(href).not.toContain(checkedMemberId)
    expect(href).not.toContain('role=')
    expect(link?.textContent).toContain('在多维表打开')
    await router.push(href)
    expect(router.currentRoute.value.name).toBe(AppRouteNames.MULTITABLE)
    expect(resolveMultitableRouteProps(router.currentRoute.value)).toMatchObject({
      baseId: 'base_1',
      sheetId: 'sheet.1',
      viewId: 'view:1',
      recordId: undefined,
      fieldId: undefined,
      role: undefined,
    })

    await fillField(root, 'viewId', 'view-2')
    const nextHref = contextLink(root)?.getAttribute('href') || ''
    expect(nextHref).toBe('/multitable/sheet.1/view-2?baseId=base_1')
    expect(nextHref).not.toContain('view:1')
    await router.push(nextHref)
    expect(resolveMultitableRouteProps(router.currentRoute.value).viewId).toBe('view-2')
    expect(resolveMultitableRouteProps(router.currentRoute.value).sheetId).toBe('sheet.1')

    await fillField(root, 'viewId', '')
    expect(contextLink(root)).toBeNull()
    expect(root.textContent).not.toContain(href)
  })

  it('does not invent a view link when the check has no view id', async () => {
    const router = locationRouter()
    const root = mountChecker(router)
    await choosePolicy(root, 'multitable.context.sheet')
    await fillField(root, 'baseId', 'base_1')
    await fillField(root, 'sheetId', 'sheet.1')
    expect(contextLink(root)).toBeNull()
    expect(root.querySelector('a')).toBeNull()

    await choosePolicy(root, 'multitable.context.view-access')
    await fillField(root, 'sheetId', 'sheet.1')
    await fillField(root, 'viewId', 'view:1')
    expect(contextLink(root)?.getAttribute('href')).toBe('/multitable/sheet.1/view:1')
    await choosePolicy(root, 'multitable.record.read')
    expect(contextLink(root)).toBeNull()
    expect(root.innerHTML).not.toContain('view:1')
    expect(root.innerHTML).not.toContain('/multitable/sheet.1')
  })

  it('safely omits the context link when there is no installed router', async () => {
    const root = mountChecker(null)
    await choosePolicy(root, 'multitable.context.view-access')
    await fillField(root, 'sheetId', 'sheet.1')
    await fillField(root, 'viewId', 'view:1')
    expect(contextLink(root)).toBeNull()
  })
})
