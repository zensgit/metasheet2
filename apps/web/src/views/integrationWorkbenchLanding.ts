/**
 * 数据工厂 workbench deep-link landing (整合切片 2026-09-09).
 *
 * The workbench renders every section at once and navigates between them by scrolling, so a
 * deep link into one section is a SCROLL TARGET, not a route. Two link shapes are accepted:
 *
 *   1. `#<section-id>`      — a DOM anchor, e.g. `/integrations/workbench#int-sec-connection`.
 *                             This is the shape the redirected `/data-sources` route uses, and
 *                             the shape a browser would honour on its own for a plain anchor.
 *   2. `?section=<group-id>` — a rail GROUP id, e.g. `/integrations/workbench?section=connection`.
 *                             Useful when a caller wants "the 连接管理 group" without having to
 *                             know which of its section ids happens to come first.
 *
 * The resolution is a pure function on purpose: the workbench SFC is ~5.2k lines and cannot be
 * mounted cheaply in a unit test, so the decision lives here where it can be tested directly and
 * the SFC keeps only the side effect (scroll + active-highlight).
 *
 * Hash wins over query when both are present: the hash is the more specific target (a single
 * section) and it is also what the browser itself would act on.
 */

/**
 * Section DOM id -> rail group id. Moved here from IntegrationWorkbenchView.vue so the landing
 * resolver and the view's IntersectionObserver/active-highlight share ONE table — a section added
 * to the view without an entry here is invisible to both, rather than to only one of them.
 */
export const WORKBENCH_SECTION_GROUP_IDS: Readonly<Record<string, string>> = Object.freeze({
  'int-sec-hub-overview': 'hub-overview',
  'int-sec-connection': 'connection',
  'int-sec-read-source': 'read-source',
  'int-sec-combination-config': 'combination',
  'int-sec-combination-run': 'combination',
  'int-sec-object-template': 'cleaning-mapping',
  'int-sec-cleaning-dataset': 'cleaning-mapping',
  'int-sec-cleaning-rules': 'cleaning-mapping',
  'int-sec-run-push': 'run-push',
  'int-sec-monitoring': 'monitoring',
  'int-sec-preview': 'cleaning-mapping',
  'int-sec-bridge-agent': 'bridge-agent',
})

/** Every rail group id that at least one section belongs to — the `?section=` allowlist. */
export const WORKBENCH_RAIL_GROUP_IDS: readonly string[] = Object.freeze(
  Array.from(new Set(Object.values(WORKBENCH_SECTION_GROUP_IDS))),
)

/**
 * The subset of `RouteLocationNormalizedLoaded` this resolver reads. Deliberately structural (and
 * fully optional) — `useRoute()` returns `undefined` when the component is mounted without a
 * router, which several of this app's unit tests do.
 */
export interface WorkbenchLandingRouteLike {
  hash?: string | null
  query?: Record<string, unknown> | null
}

function firstQueryValue(value: unknown): string | null {
  if (typeof value === 'string') return value
  // vue-router models a repeated key as an array; take the first usable entry rather than
  // silently ignoring `?section=a&section=b`.
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') return entry
    }
  }
  return null
}

/**
 * Resolve which rail group a deep link lands on, or `null` when the link names none.
 *
 * `null` means "leave the workbench where it already is" — an unknown/misspelt anchor must not
 * scroll somewhere arbitrary, and must not clear the active highlight either.
 */
export function resolveWorkbenchLandingGroupId(
  route: WorkbenchLandingRouteLike | null | undefined,
): string | null {
  const rawHash = typeof route?.hash === 'string' ? route.hash.trim() : ''
  if (rawHash) {
    const sectionId = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash
    const groupId = Object.prototype.hasOwnProperty.call(WORKBENCH_SECTION_GROUP_IDS, sectionId)
      ? WORKBENCH_SECTION_GROUP_IDS[sectionId]
      : undefined
    if (groupId) return groupId
  }

  const rawSection = firstQueryValue(route?.query?.section)
  const section = typeof rawSection === 'string' ? rawSection.trim() : ''
  if (section && WORKBENCH_RAIL_GROUP_IDS.includes(section)) return section

  return null
}
