import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  resolveWorkbenchLandingGroupId,
  WORKBENCH_RAIL_GROUP_IDS,
  WORKBENCH_SECTION_GROUP_IDS,
} from '../src/views/integrationWorkbenchLanding'

/**
 * 整合切片 (2026-09-09): /data-sources now redirects to
 * `/integrations/workbench#int-sec-connection`, so the workbench has to turn an incoming
 * hash (or `?section=`) into a rail group to scroll to.
 *
 * The decision is unit-tested HERE rather than through the view: IntegrationWorkbenchView.vue
 * is a ~5.2k-line SFC whose mount fires a dozen bootstrap requests, so a landing test driven
 * through it would be pinning the mock table, not the rule.
 */
describe('resolveWorkbenchLandingGroupId', () => {
  it('resolves a section-anchor hash to that section\u2019s rail group', () => {
    expect(resolveWorkbenchLandingGroupId({ hash: '#int-sec-connection' })).toBe('connection')
    // A section that is NOT the group\u2019s first anchor still resolves to the group.
    expect(resolveWorkbenchLandingGroupId({ hash: '#int-sec-cleaning-rules' })).toBe('cleaning-mapping')
    // A bare id (no '#') is accepted too \u2014 callers building the target by hand should not have
    // to know which form the router hands over.
    expect(resolveWorkbenchLandingGroupId({ hash: 'int-sec-monitoring' })).toBe('monitoring')
  })

  it('resolves ?section=<rail group id> when there is no hash', () => {
    expect(resolveWorkbenchLandingGroupId({ query: { section: 'connection' } })).toBe('connection')
    expect(resolveWorkbenchLandingGroupId({ hash: '', query: { section: 'bridge-agent' } })).toBe('bridge-agent')
    // Repeated key: take the first usable value rather than ignoring the link.
    expect(resolveWorkbenchLandingGroupId({ query: { section: ['run-push', 'monitoring'] } })).toBe('run-push')
  })

  it('returns null when the route names no landing at all', () => {
    expect(resolveWorkbenchLandingGroupId({})).toBeNull()
    expect(resolveWorkbenchLandingGroupId({ hash: '', query: {} })).toBeNull()
    expect(resolveWorkbenchLandingGroupId(undefined)).toBeNull()
    // `useRoute()` is undefined when the view is mounted without a router \u2014 that must be a
    // no-op, not a crash.
    expect(resolveWorkbenchLandingGroupId(null)).toBeNull()
    expect(resolveWorkbenchLandingGroupId({ hash: null, query: null })).toBeNull()
  })

  it('returns null for values that name nothing this workbench has', () => {
    // Unknown anchor: must NOT fall through to some default section.
    expect(resolveWorkbenchLandingGroupId({ hash: '#int-sec-nope' })).toBeNull()
    // A rail GROUP id in the hash is not a section id \u2014 the two namespaces stay apart.
    expect(resolveWorkbenchLandingGroupId({ hash: '#connection' })).toBeNull()
    // A SECTION id in ?section= is likewise not a group id.
    expect(resolveWorkbenchLandingGroupId({ query: { section: 'int-sec-connection' } })).toBeNull()
    expect(resolveWorkbenchLandingGroupId({ query: { section: 'nope' } })).toBeNull()
    // Non-string query values (vue-router models a bare `?section` as null).
    expect(resolveWorkbenchLandingGroupId({ query: { section: null } })).toBeNull()
    expect(resolveWorkbenchLandingGroupId({ query: { section: [] } })).toBeNull()
    // Prototype keys must not resolve: `hasOwnProperty` guard, not a bare lookup.
    expect(resolveWorkbenchLandingGroupId({ hash: '#constructor' })).toBeNull()
    expect(resolveWorkbenchLandingGroupId({ hash: '#toString' })).toBeNull()
  })

  it('prefers the hash over ?section= when both are present and both resolve', () => {
    expect(resolveWorkbenchLandingGroupId({ hash: '#int-sec-connection', query: { section: 'monitoring' } })).toBe('connection')
    // ...but an unresolvable hash falls back to a resolvable ?section= rather than giving up.
    expect(resolveWorkbenchLandingGroupId({ hash: '#int-sec-nope', query: { section: 'monitoring' } })).toBe('monitoring')
  })

  it('keeps the redirect target of /data-sources resolvable (the reason this resolver exists)', () => {
    expect(WORKBENCH_SECTION_GROUP_IDS['int-sec-connection']).toBe('connection')
    expect(resolveWorkbenchLandingGroupId({ hash: '#int-sec-connection' })).toBe('connection')
  })

  it('derives the ?section= allowlist from the section table (no second hand-maintained list)', () => {
    expect([...WORKBENCH_RAIL_GROUP_IDS].sort()).toEqual(
      [...new Set(Object.values(WORKBENCH_SECTION_GROUP_IDS))].sort(),
    )
    // Every group id reachable by ?section= is reachable by some anchor too, so the two link
    // shapes cannot drift into naming different sets of destinations.
    for (const groupId of WORKBENCH_RAIL_GROUP_IDS) {
      expect(resolveWorkbenchLandingGroupId({ query: { section: groupId } })).toBe(groupId)
    }
    for (const [sectionId, groupId] of Object.entries(WORKBENCH_SECTION_GROUP_IDS)) {
      expect(resolveWorkbenchLandingGroupId({ hash: `#${sectionId}` })).toBe(groupId)
    }
  })
})

/**
 * Wiring pin, asserted on SOURCE. IntegrationWorkbenchView.vue is a ~5.2k-line SFC whose mount
 * fires the whole bootstrap fan-out, and jsdom has no scrollIntoView at all — mounting it to
 * observe a scroll would pin the mock table, not the wiring. The same source-pin pattern this
 * repo already uses for route declarations (tests/attendance-records-route-redirect.spec.ts).
 *
 * Without this block the resolver above could be perfectly correct and never called.
 */
describe('IntegrationWorkbenchView wiring (source pin)', () => {
  const viewSrc = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/views/IntegrationWorkbenchView.vue'),
    'utf8',
  )

  it('imports the resolver and the shared section table from the shared module', () => {
    expect(viewSrc).toContain(
      "import { resolveWorkbenchLandingGroupId, WORKBENCH_SECTION_GROUP_IDS } from './integrationWorkbenchLanding'",
    )
    // No second, hand-maintained copy of the section->group table in the view.
    expect(viewSrc).toContain('const sectionGroupIds: Readonly<Record<string, string>> = WORKBENCH_SECTION_GROUP_IDS')
    expect(viewSrc).not.toContain("'int-sec-hub-overview': 'hub-overview'")
  })

  it('feeds the resolved group into scrollToRailGroup, and does nothing when it resolves to null', () => {
    const start = viewSrc.indexOf('function applyWorkbenchLanding()')
    expect(start, 'applyWorkbenchLanding() must exist').toBeGreaterThanOrEqual(0)
    const body = viewSrc.slice(start, viewSrc.indexOf('\n}', start))
    expect(body).toContain('resolveWorkbenchLandingGroupId(route)')
    expect(body).toContain('if (!groupId) return')
    expect(body).toContain('scrollToRailGroup(group)')
  })

  it('runs the landing on mount AND on later hash / ?section= changes', () => {
    // onMounted: after nextTick, so the target section element exists to scroll to.
    const mountedIndex = viewSrc.indexOf('onMounted(() => {')
    expect(mountedIndex).toBeGreaterThanOrEqual(0)
    const mountedBody = viewSrc.slice(mountedIndex, viewSrc.indexOf('\n})', mountedIndex))
    expect(mountedBody).toContain('void nextTick(applyWorkbenchLanding)')

    // watch: navigating to another anchor while already on the page must re-run it.
    expect(viewSrc).toContain('() => [route?.hash, route?.query?.section] as const')
    const watchIndex = viewSrc.indexOf('() => [route?.hash, route?.query?.section] as const')
    expect(viewSrc.slice(watchIndex, watchIndex + 220)).toContain('void nextTick(applyWorkbenchLanding)')
  })

  it('re-applies the landing once the bootstrap read settles (F01)', () => {
    // The mount-tick pass runs while the sections are still empty: their content arrives with the
    // bootstrap fan-out, so a section measured on that tick can move under the scroll and the
    // reader lands short. The bootstrap's own onMounted therefore chains ONE more pass.
    const index = viewSrc.indexOf('refreshBootstrap().finally(')
    expect(index, 'the bootstrap mount hook must chain a landing re-apply').toBeGreaterThanOrEqual(0)
    expect(viewSrc.slice(index, index + 200)).toContain('nextTick(applyWorkbenchLanding)')
    // Exactly one compensation, not a scroll state machine: `applyWorkbenchLanding` is a no-op
    // unless the route names a landing (pinned above), so an ordinary visit still never scrolls.
    expect(viewSrc.split('refreshBootstrap().finally(').length - 1).toBe(1)
  })

  it('reads the route defensively (no router => no landing, not a crash)', () => {
    expect(viewSrc).toContain("import { useRoute } from 'vue-router'")
    expect(viewSrc).toContain('const route = useRoute()')
    // Every read of the possibly-undefined route is optional-chained.
    expect(viewSrc).not.toMatch(/\broute\.hash\b/)
    expect(viewSrc).not.toMatch(/\broute\.query\b/)
  })
})
