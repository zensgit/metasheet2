import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter, type RouteRecordRaw } from 'vue-router'
import { defineComponent, h } from 'vue'
import { appRoutes } from '../src/router/appRoutes'
import {
  PLM_WORKBENCH_ALLOWED_PREFIXES,
  resolveRouteGuardDecision,
} from '../src/router/guardPolicy'
import { WORKBENCH_SECTION_GROUP_IDS } from '../src/views/integrationWorkbenchLanding'

/**
 * 整合切片 (2026-09-09): the standalone 外接数据源 page was folded into 数据工厂's 连接管理
 * section, so '/data-sources' is now a redirect. Bookmarks, printed runbooks and in-app hints
 * that still name the old path have to keep landing somewhere that shows that surface.
 *
 * Everything below is driven off the REAL route records (`appRoutes`) and the REAL guard policy —
 * a hand-copied literal would keep passing after someone edits either one.
 */
const Dummy = defineComponent({ render: () => h('div') })

function routeByPath(path: string): RouteRecordRaw {
  const record = appRoutes.find((candidate) => candidate.path === path)
  expect(record, `route ${path} must exist in appRoutes`).toBeTruthy()
  return record as RouteRecordRaw
}

const dataSourcesRoute = routeByPath('/data-sources')
const workbenchRoute = routeByPath('/integrations/workbench')

describe("/data-sources route declaration", () => {
  it('is a redirect record, not a page component', () => {
    expect(dataSourcesRoute.name).toBe('data-sources')
    expect(dataSourcesRoute.redirect).toEqual({ path: '/integrations/workbench', hash: '#int-sec-connection' })
    // A leftover `component` would keep the folded-away page mountable from the router and let the
    // two surfaces drift apart again.
    expect((dataSourcesRoute as { component?: unknown }).component).toBeUndefined()
  })

  // WHAT THIS PINS, AND WHAT IT DOES NOT. vue-router consumes a `redirect` record while it
  // RESOLVES a location — before `beforeEach` runs — so the navigation the shell's guard and
  // title logic actually see is the TARGET's, meta and all. Nothing reads the meta below at
  // runtime. It is asserted as a property of the RECORD only: the route table stays
  // self-describing, and a future un-fold would find the title still there. Read the companion
  // case in the behaviour block ('does not carry ... meta onto the landed route') for the other
  // half of this claim.
  it('keeps titleZh on the RECORD (record-level only — no guard ever reads a redirect record’s meta)', () => {
    expect(dataSourcesRoute.meta).toMatchObject({ requiresAuth: true, titleZh: '外接数据源' })
  })

  it('names a hash the workbench can actually land on', () => {
    // The anchor is only useful if the workbench's own landing table knows it — otherwise the
    // redirect arrives at the top of a 5k-line page with no scroll.
    const hash = (dataSourcesRoute.redirect as { hash: string }).hash
    expect(hash.startsWith('#')).toBe(true)
    expect(WORKBENCH_SECTION_GROUP_IDS[hash.slice(1)]).toBe('connection')
  })

  it('is declared before the not-found catch-all, so the catch-all cannot shadow it', () => {
    const redirectIndex = appRoutes.findIndex((route) => route.path === '/data-sources')
    const catchAllIndex = appRoutes.findIndex((route) => String(route.path).startsWith('/:pathMatch'))
    expect(redirectIndex).toBeGreaterThanOrEqual(0)
    expect(catchAllIndex).toBeGreaterThanOrEqual(0)
    expect(redirectIndex).toBeLessThan(catchAllIndex)
  })
})

describe('/data-sources redirect behavior (isolated vue-router over the REAL route record)', () => {
  // Dummy components for the TARGET only — the real workbench view pulls Element Plus CSS that
  // this suite has no reason to transform. The record under test is the real one, redirect and
  // all, so a change to it reds this block.
  function buildRouter() {
    const routes: RouteRecordRaw[] = [
      { path: '/integrations/workbench', name: 'integration-workbench', component: Dummy },
      dataSourcesRoute,
      { path: '/:pathMatch(.*)*', name: 'not-found', redirect: '/' },
      { path: '/', name: 'home', component: Dummy },
    ]
    return createRouter({ history: createMemoryHistory(), routes })
  }

  it('lands on /integrations/workbench#int-sec-connection', async () => {
    const router = buildRouter()
    await router.push('/data-sources')
    expect(router.currentRoute.value.path).toBe('/integrations/workbench')
    expect(router.currentRoute.value.hash).toBe('#int-sec-connection')
    expect(router.currentRoute.value.fullPath).toBe('/integrations/workbench#int-sec-connection')
  })

  it('does not fall through to the not-found catch-all', async () => {
    const router = buildRouter()
    await router.push('/data-sources')
    expect(router.currentRoute.value.name).not.toBe('not-found')
    expect(router.currentRoute.value.path).not.toBe('/')
  })

  it('does not carry the redirect record’s meta onto the landed route', async () => {
    // The falsifying half of the record-level meta assertion above: the landed route is the
    // TARGET's, so `titleZh: '外接数据源'` is NOT what a beforeEach guard (or the shell title)
    // would read after this navigation. Anyone tempted to gate on that meta gets a red here.
    const router = buildRouter()
    await router.push('/data-sources')
    expect(router.currentRoute.value.name).toBe('integration-workbench')
    expect(router.currentRoute.value.meta.titleZh).toBeUndefined()
  })
})

describe('the redirect target is reachable where the old path was not (guardPolicy)', () => {
  // PLM 聚焦模式 allowlist. The old bare path is under NO allowed prefix, so a PLM-focused org
  // was bounced to /plm before ever seeing 外接数据源; the workbench is under '/integrations',
  // which is allowed. This is asserted through the REAL decision function — not a re-implemented
  // prefix match — so a change to the ordering or the allowlist reds it.
  const plmFocusedCtx = {
    hasFeature: () => true,
    hasPermission: () => true,
    attendanceFocused: false,
    plmWorkbenchFocused: true,
    resolveHomePath: () => '/',
  }

  it('allows the redirect target under PLM focus mode', () => {
    expect(
      resolveRouteGuardDecision({ path: '/integrations/workbench', meta: workbenchRoute.meta }, plmFocusedCtx),
    ).toEqual({ action: 'allow' })
  })

  it('would have redirected the OLD bare path under PLM focus mode', () => {
    expect(
      resolveRouteGuardDecision({ path: '/data-sources', meta: dataSourcesRoute.meta }, plmFocusedCtx),
    ).toEqual({ action: 'redirect', target: '/plm' })
  })

  it('pins the prefix that makes the target reachable, without widening the allowlist', () => {
    expect(PLM_WORKBENCH_ALLOWED_PREFIXES).toContain('/integrations')
    expect(PLM_WORKBENCH_ALLOWED_PREFIXES).not.toContain('/data-sources')
    const target = (dataSourcesRoute.redirect as { path: string }).path
    expect(
      PLM_WORKBENCH_ALLOWED_PREFIXES.some((prefix) => target === prefix || target.startsWith(`${prefix}/`)),
    ).toBe(true)
  })

  it('keeps the target behind the workbench own integration:write gate (the fold tightens, never loosens)', () => {
    const withoutIntegrationWrite = { ...plmFocusedCtx, plmWorkbenchFocused: false, hasPermission: () => false }
    expect(
      resolveRouteGuardDecision({ path: '/integrations/workbench', meta: workbenchRoute.meta }, withoutIntegrationWrite),
    ).toEqual({ action: 'redirect', target: '/' })
  })
})
