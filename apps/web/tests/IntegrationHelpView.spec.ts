import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'

// IU-6c (design-lock docs/development/integration-ux-workbench-redesign-design-lock-20260706.md,
// #3739): the /help/integration center page. Three sections (when-to-use, error-code table, FAQ);
// the error-code table is the single-source tripwire — it must be driven by the IU-1 label module's
// own registered entries, not a hand-copied list, so a future label add/remove needs zero edits here.
//
// G12/G41 REVIEW ROUND 2 (2026-09-10). The two walkthroughs added in round 1 described an operation
// chain that does not exist (placeholders typed into the real data-source form + a promise that the
// connection works; "the K3 dry-run only reads K3"; "open the multi-dimensional table saves the
// preview"). Every one of those passed a test that only asserted the copy was RENDERED. So this file
// now also reads the real producer files off disk (same readFileSync shape as
// ui-foundation-style-guard.spec.ts / StockPreparationInstallRun.spec.ts) and asserts:
//   (a) every step's declared `anchors` token really occurs in the file it names — a described action
//       whose button/route/function no longer exists turns red here;
//   (b) the K3 preview path contains no write call, so the page's "the preview is not persisted" and
//       "open the multi-dimensional table is navigation only" sentences are checked against code
//       rather than against themselves.

const REPO_ROOT = resolve(__dirname, '..', '..', '..')

function readRepoFile(relativePath: string): string {
  // Normalise CRLF -> LF: a `core.autocrlf=true` Windows checkout hands back \r\n, so a marker
  // written with \n would match on CI (LF) and silently fail on a dev host (or vice versa).
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

/**
 * Same as readRepoFile, but a missing file resolves to `null` instead of throwing. Used only for
 * anchor `altFiles` candidates: on THIS branch (which does not include #5587) the migration target
 * apps/web/src/components/data-sources/DataSourcesPanel.vue does not exist on disk yet, so eagerly
 * readFileSync-ing every candidate would throw ENOENT even though the anchor's primary `file` already
 * resolves the token. A candidate that does not exist simply contributes no match.
 */
function tryReadRepoFile(relativePath: string): string | null {
  try {
    return readRepoFile(relativePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw err
  }
}

/**
 * Return the source slice from `startMarker` up to and including the first following `endMarker`.
 * Used to scope a "this code contains no write call" assertion to ONE function body instead of a
 * whole 2000-line file, where an unrelated `upsert(` elsewhere would make the assertion meaningless.
 */
/**
 * Drop whole-line comments. These files carry long design-rationale comments that MENTION the very
 * call names being asserted about (pipeline-runner.cjs names `targetAdapter.upsert(...)` three times
 * in prose), so a raw text match would count documentation as code.
 */
function codeLinesOf(source: string): string[] {
  return source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
}

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  expect(start, `start marker not found: ${startMarker}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endMarker, start + startMarker.length)
  expect(end, `end marker not found after start marker: ${endMarker}`).toBeGreaterThan(start)
  return source.slice(start, end + endMarker.length)
}

/**
 * G12/G41 review round 3 (PR #5613 vs in-flight #5587, 2026-09-11): #5587
 * (feat/data-sources-fold-into-workbench) moves the /data-sources form out of DataSourcesView.vue
 * into apps/web/src/components/data-sources/DataSourcesPanel.vue. Once that branch merges, every
 * anchor naming DataSourcesView.vue would go red purely from the file move, even though the token
 * (button/testid) still exists — in the panel. So an anchor's candidate set is `file` plus its
 * optional `altFiles`, and it resolves if the token occurs in ANY of them; only the primary `file`
 * is rendered to the reader. This helper is the single place that rule lives, so both the real
 * disk-backed resolution test below and the synthetic candidate-file test exercise the same logic.
 */
function anchorResolves(anchor: HelpCaseStepAnchor, contentByFile: Map<string, string>): boolean {
  const candidateFiles = [anchor.file, ...(anchor.altFiles ?? [])]
  return candidateFiles.some((file) => (contentByFile.get(file) ?? '').includes(anchor.token))
}

const pushSpy = vi.fn()

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy }),
  }
})

import IntegrationHelpView, {
  INTEGRATION_HELP_GLOSSARY,
  INTEGRATION_HELP_K3_WISE_CASE_STEPS,
  INTEGRATION_HELP_SQL_SOURCE_CASE_STEPS,
  type HelpCaseStep,
} from '../src/views/IntegrationHelpView.vue'
import { integrationErrorCodeEntries } from '../src/services/integration/errorCodeLabels'
import { useLocale } from '../src/composables/useLocale'

async function flushUi(cycles = 3): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('IntegrationHelpView (IU-6c)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    // G12/G41 locale-switch test below flips the shared `useLocale()` singleton state — reset it so
    // a locale change in one test never bleeds into a later test in this same file (module state is
    // NOT reset between `it` blocks by vitest by default).
    useLocale().setLocale('en')
  })

  async function mountView(): Promise<HTMLDivElement> {
    app = createApp(IntegrationHelpView)
    app.mount(container!)
    await flushUi()
    return container!
  }

  it('renders all six sections', async () => {
    const root = await mountView()
    expect(root.querySelector('[data-testid="help-section-glossary"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="help-section-case-sql-source"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="help-section-case-k3-wise"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="help-section-when-to-use"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="help-section-error-codes"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="help-section-faq"]')).not.toBeNull()
  })

  // G12/G41 gap-close: the terminology table must be driven by the view's own exported
  // INTEGRATION_HELP_GLOSSARY constant (single-source, same pattern as errorCodeEntries below) — not
  // a hand-typed <tr> list. The literal `.toBe(7)` is the mutation probe: if a future edit deletes a
  // row straight from INTEGRATION_HELP_GLOSSARY, this line goes red even though the row count and the
  // rendered DOM count would still trivially agree with EACH OTHER (both are driven by the same
  // array). Bump this literal deliberately whenever a row is intentionally added/removed.
  it('glossary table renders one row per INTEGRATION_HELP_GLOSSARY entry (single-source, row-count tripwire)', async () => {
    expect(INTEGRATION_HELP_GLOSSARY.length).toBe(7)
    const root = await mountView()
    const rows = root.querySelectorAll('[data-testid="help-glossary-table"] tbody tr')
    expect(rows.length).toBe(INTEGRATION_HELP_GLOSSARY.length)
    for (const entry of INTEGRATION_HELP_GLOSSARY) {
      expect(root.querySelector(`[data-testid="help-glossary-row-${entry.id}"]`)).not.toBeNull()
    }
    // Spot-check the terms the gap analysis explicitly called out as multi-named.
    const ids = INTEGRATION_HELP_GLOSSARY.map((entry) => entry.id)
    expect(ids).toEqual(
      expect.arrayContaining(['connection', 'dataset-object', 'staging-table', 'read-source', 'composition', 'pipeline', 'dead-letter']),
    )
  })

  it('glossary rows carry non-empty alias text grounded in real UI copy', async () => {
    const root = await mountView()
    const connectionRow = root.querySelector('[data-testid="help-glossary-row-connection"]') as HTMLElement
    expect(connectionRow.textContent).toMatch(/adapter/i)
    expect(connectionRow.textContent).toMatch(/connection draft/i)
    const staging = root.querySelector('[data-testid="help-glossary-row-staging-table"]') as HTMLElement
    expect(staging.textContent).toMatch(/staging/i)
  })

  it('case one (SQL read-only source -> multi-dimensional table) anchor and all seven step anchors exist', async () => {
    const root = await mountView()
    const section = root.querySelector('[data-testid="help-section-case-sql-source"]') as HTMLElement
    expect(section).not.toBeNull()
    expect(INTEGRATION_HELP_SQL_SOURCE_CASE_STEPS.length).toBe(7)
    for (let i = 1; i <= INTEGRATION_HELP_SQL_SOURCE_CASE_STEPS.length; i += 1) {
      expect(root.querySelector(`[data-testid="help-case-sql-source-step-${i}"]`)).not.toBeNull()
    }
    expect(section.textContent).toMatch(/connectionId/)
    expect(section.textContent).toMatch(/dry-run/i)
    // values-free: no digit-run > 4 anywhere in this section's copy.
    expect(section.textContent).not.toMatch(/\d{5,}/)
  })

  // REVIEW FINDING 1 (P2 #5613): the first draft's step one said "fill in Host / Port / Database plus
  // a read-only account (use placeholders, never real values)" and then promised the source would be
  // usable. Placeholders belong in examples and evidence; an authorised real configuration needs real
  // values. This locks the corrected direction in BOTH locales so a future edit cannot quietly bring
  // the instruction back in the language nobody happens to read.
  it('case one tells the reader to use REAL values in the real form, and never instructs typing placeholders into it', async () => {
    const root = await mountView()
    const section = () => root.querySelector('[data-testid="help-section-case-sql-source"]') as HTMLElement
    const callout = () => root.querySelector('[data-testid="help-case-sql-source-real-values"]') as HTMLElement

    useLocale().setLocale('en')
    await flushUi()
    expect(callout()).not.toBeNull()
    expect(callout().textContent).toMatch(/real values/i)
    // A placeholder may only be mentioned as (i) the HTML placeholder attribute's grey hint, or
    // (ii) something that belongs in docs/screenshots/evidence — never as an instruction.
    expect(section().textContent).toMatch(/placeholder hint|placeholder attribute/i)
    expect(section().textContent).toMatch(/docs, screenshots and acceptance evidence/i)
    expect(section().textContent).not.toMatch(/use placeholders|fill in placeholders|never real values/i)

    useLocale().setLocale('zh-CN')
    await flushUi()
    expect(callout().textContent).toContain('填真实值')
    expect(section().textContent).toMatch(/只用于文档、截图和验收证据/)
    expect(section().textContent).not.toMatch(/用占位符，不要填真实值|请填占位符/)
  })

  // Same finding, the half that makes the placeholder rule matter: "Create" persists without dialing
  // (routes/data-sources.ts -> manager.addDataSource -> addDataSourceInternal(config, false)), while
  // the ephemeral POST /api/data-sources/test is the only step that actually connects. The copy must
  // say so, and the producer must still behave that way.
  it('case one separates "saved" from "reachable", and the producer chain still backs that claim', async () => {
    const root = await mountView()
    useLocale().setLocale('en')
    await flushUi()
    const section = root.querySelector('[data-testid="help-section-case-sql-source"]') as HTMLElement
    expect(section.textContent).toMatch(/saved is not the same as reachable/i)
    expect(section.textContent).toMatch(/never dials|never dial/i)

    // Producer side: the create route persists through addDataSource, which does NOT auto-connect.
    const manager = readRepoFile('packages/core-backend/src/data-adapters/DataSourceManager.ts')
    const addDataSourceBody = sliceBetween(manager, '  async addDataSource(', '\n  }\n')
    expect(addDataSourceBody).toContain('addDataSourceInternal(config, false)')
    // ...and the ephemeral test endpoint exists and is the dialing one.
    expect(manager).toContain('async testEphemeralConnection')
    const dataSourcesApi = readRepoFile('apps/web/src/data-sources/api.ts')
    expect(dataSourcesApi).toContain("apiFetch('/api/data-sources/test', { method: 'POST'")
    expect(dataSourcesApi).toContain("apiFetch('/api/data-sources', { method: 'POST'")
  })

  it('case two (K3 WISE preset) anchor and all five step anchors exist, and states the K3 target is permanently read-only', async () => {
    const root = await mountView()
    const section = root.querySelector('[data-testid="help-section-case-k3-wise"]') as HTMLElement
    expect(section).not.toBeNull()
    expect(INTEGRATION_HELP_K3_WISE_CASE_STEPS.length).toBe(5)
    for (let i = 1; i <= INTEGRATION_HELP_K3_WISE_CASE_STEPS.length; i += 1) {
      expect(root.querySelector(`[data-testid="help-case-k3-wise-step-${i}"]`)).not.toBeNull()
    }
    expect(section.textContent).toMatch(/k3-wise/i)
    // #5597 alignment: K3 is read-only as a target — never phrase this as writable.
    expect(section.textContent).toMatch(/permanently read-only/i)
    // Bounded proximity (not `.*`) so this only catches a regression IN THE SAME SENTENCE — an
    // unbounded pattern would also match unrelated "write"/"back"/"k3" tokens that happen to occur
    // in that relative order elsewhere in the section (false positive), which defeats the point of a
    // guardrail test.
    expect(section.textContent).not.toMatch(/write.{0,40}back.{0,40}k3|save.{0,40}only.{0,40}(push|write).{0,40}k3/i)
  })

  // REVIEW FINDING 2 (P2 #5613), part one: the first draft said the K3 dry-run "only reads K3". The
  // real direction is the opposite — the preset builds pipelines whose SOURCE is the PLM system and
  // whose TARGET is K3, so a dry-run reads PLM and previews what would be sent to K3.
  it('case two describes the real PLM -> K3 direction, and the pipeline builder still produces it', async () => {
    const root = await mountView()
    useLocale().setLocale('en')
    await flushUi()
    const section = root.querySelector('[data-testid="help-section-case-k3-wise"]') as HTMLElement
    expect(section.textContent).toMatch(/PLM\s*→\s*K3|source is PLM/i)
    expect(section.textContent).toMatch(/reads the PLM source/i)
    // The copy must NOT claim the dry-run reads K3.
    expect(section.textContent).not.toMatch(/only reads k3|reads k3 only|reading k3 only/i)

    // Producer: buildK3WisePipelinePayloads binds sourceSystemId to the PLM source system id and
    // targetSystemId to the K3 WebAPI system id, and labels both drafts as PLM cleansing pipelines.
    const k3Setup = readRepoFile('apps/web/src/services/integration/k3WiseSetup.ts')
    const builder = sliceBetween(k3Setup, 'export function buildK3WisePipelinePayloads', '\n}\n')
    expect(builder).toContain('const sourceSystemId = trim(form.sourceSystemId)')
    expect(builder).toContain('const targetSystemId = trim(form.webApiSystemId)')
    expect(builder).toMatch(/Draft PLM material cleansing pipeline/)
    expect(builder).toMatch(/Draft PLM BOM cleansing pipeline/)
    // And the preset page asks for exactly those two ids under those two names.
    const k3View = readRepoFile('apps/web/src/views/IntegrationK3WiseSetupView.vue')
    expect(k3View).toContain('PLM Source System ID')
    expect(k3View).toContain('K3 Target System ID')
  })

  // REVIEW FINDING 2, part two — the "no save" claim, asserted against code rather than against the
  // sentence itself. Three independent producer facts must hold:
  //   (1) the dry-run branch of the pipeline runner reaches previewUpsert and NOT upsert;
  //   (2) the K3 WebAPI adapter's previewUpsert composes a body without logging in or issuing a
  //       request (it is the thing that makes "no request reaches the ERP" true);
  //   (3) the K3 target's real write entry is refused by the permanent fence.
  it('case two: the K3 dry-run preview path contains no write call (source-level)', async () => {
    const runner = readRepoFile('plugins/plugin-integration-core/lib/pipeline-runner.cjs')

    // (1a) the preview helper uses previewUpsert and never the write method.
    const previewHelper = sliceBetween(runner, '  async function attachDryRunTargetPreview(', '\n  }\n')
    expect(previewHelper).toContain('targetAdapter.previewUpsert(')
    expect(previewHelper).not.toMatch(/targetAdapter\.upsert\s*\(/)

    // (1b) the ONLY target write in the runner is behind `!dryRun`. Counting occurrences is the point:
    // a second, unguarded `targetAdapter.upsert(` added later would make the page's claim false, and
    // this assertion is what turns red. Comment lines are stripped first — this module discusses that
    // call by name three times in prose.
    const writeCallLines = codeLinesOf(runner).filter((line) => /targetAdapter\.upsert\s*\(/.test(line))
    expect(writeCallLines.length, 'expected exactly one real targetAdapter.upsert call site').toBe(1)
    const writeIndex = runner.indexOf(writeCallLines[0])
    const guardPrefix = runner.slice(Math.max(0, writeIndex - 200), writeIndex)
    expect(guardPrefix).toContain('if (!dryRun && cleanRecords.length > 0)')

    // (2) the K3 adapter's previewUpsert is pure composition: no login, no request, no egress.
    const k3Adapter = readRepoFile('plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs')
    const previewUpsert = codeLinesOf(sliceBetween(k3Adapter, '  async function previewUpsert(', '\n  }\n')).join('\n')
    expect(previewUpsert).toMatch(/operation: 'save'/)
    expect(previewUpsert).not.toMatch(/login\(/)
    expect(previewUpsert).not.toMatch(/requestJson\(/)
    expect(previewUpsert).not.toMatch(/fetch\(/)

    // (3) the real write entry is fenced permanently (the page's "permanently read-only" line).
    const fence = readRepoFile('plugins/plugin-integration-core/lib/k3-external-write-permanent-fence.cjs')
    expect(fence).toContain('function refuseK3ExternalWritePermanently')
    expect(k3Adapter).toContain('refuseK3ExternalWritePermanently(')
  })

  // The dry-run step makes a two-sided persistence claim ("the run IS recorded, the failed rows are
  // NOT dead letters"). Caught while writing this: the first draft of that sentence said dry-run
  // failures still become dead letters, which `writeDeadLetter`'s own early return falsifies. Both
  // halves are pinned so the corrected sentence cannot drift back.
  it('case one states the dry-run persistence facts the runner actually implements', async () => {
    const root = await mountView()
    useLocale().setLocale('en')
    await flushUi()
    const section = root.querySelector('[data-testid="help-section-case-sql-source"]') as HTMLElement
    expect(section.textContent).toMatch(/still records the run itself/i)
    expect(section.textContent).toMatch(/never become dead letters/i)

    const runner = readRepoFile('plugins/plugin-integration-core/lib/pipeline-runner.cjs')
    // Dead letters: skipped on a dry run.
    const deadLetterFn = sliceBetween(runner, '  async function writeDeadLetter(input) {', '\n  }\n')
    expect(deadLetterFn).toContain('if (input.dryRun) return')
    // The run record: started unconditionally, carrying the dryRun flag in its details.
    const startRun = sliceBetween(runner, '    let run = await runLogger.startRun({', '\n    })\n')
    expect(startRun).toContain('dryRun,')
    const beforeStartRun = runner.slice(
      Math.max(0, runner.indexOf('    let run = await runLogger.startRun({') - 120),
      runner.indexOf('    let run = await runLogger.startRun({'),
    )
    expect(beforeStartRun).not.toMatch(/if \(!?dryRun/)
  })

  // REVIEW FINDING 2, part three: "open the multi-dimensional table" is a <router-link>, built from
  // the STAGING INSTALL result, that navigates to /multitable/:sheetId/:viewId. It saves nothing —
  // the first draft said clicking it lands the dry-run result in the staging table.
  it('case two: the "open the multi-dimensional table" control is navigation only (source-level)', async () => {
    const root = await mountView()
    useLocale().setLocale('en')
    await flushUi()
    const callout = root.querySelector('[data-testid="help-case-k3-wise-preview-not-saved"]') as HTMLElement
    expect(callout).not.toBeNull()
    expect(callout.textContent).toMatch(/not persisted/i)
    expect(callout.textContent).toMatch(/navigation link/i)
    expect(callout.textContent).toMatch(/triggers no persistence call/i)
    const section = root.querySelector('[data-testid="help-section-case-k3-wise"]') as HTMLElement
    // The falsified claim must not come back in either language.
    expect(section.textContent).not.toMatch(/land the result in the staging table|to land the result/i)

    const k3View = readRepoFile('apps/web/src/views/IntegrationK3WiseSetupView.vue')

    // The rendered control: a router-link bound to the precomputed openLink, with no click handler.
    const openTargetsMarkup = sliceBetween(k3View, 'data-testid="staging-open-targets"', '</div>\n          </div>')
    expect(openTargetsMarkup).toContain('<router-link')
    expect(openTargetsMarkup).toContain(':to="target.openLink"')
    expect(openTargetsMarkup).not.toMatch(/@click/)

    // The link builders: pure string construction, no awaits and no API calls on that path.
    const buildTargets = sliceBetween(k3View, 'function buildStagingOpenTargets(', '\n}\n')
    const buildLink = sliceBetween(k3View, 'function buildMultitableOpenLink(', '\n}\n')
    for (const body of [buildTargets, buildLink]) {
      expect(body).not.toMatch(/await\s/)
      expect(body).not.toMatch(/apiFetch\(/)
      expect(body).not.toMatch(/fetch\(/)
      expect(body).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/)
    }
    expect(buildLink).toContain('/multitable/')
    // It is driven by the install result, not by any run/dry-run result.
    expect(k3View).toContain('buildStagingOpenTargets(stagingInstallResult.value, form.baseId)')
  })

  // THE assertion the review asked for: "every step the walkthrough describes corresponds to a real
  // action". Each step declares anchors (file + literal token — a route path, a data-testid, a button
  // label or a function name); the token must occur in the file it names. A renamed testid, a removed
  // button or a moved route turns that step red here instead of leaving the help center confidently
  // describing a control that no longer exists.
  it('every walkthrough step maps to real source: all declared anchors resolve', () => {
    const allSteps: Array<{ caseId: string; step: HelpCaseStep }> = [
      ...INTEGRATION_HELP_SQL_SOURCE_CASE_STEPS.map((step) => ({ caseId: 'sql-source', step })),
      ...INTEGRATION_HELP_K3_WISE_CASE_STEPS.map((step) => ({ caseId: 'k3-wise', step })),
    ]
    // Literal count = mutation probe (same shape as the glossary row-count tripwire): deleting a step
    // fails here even though every other assertion in this file is derived from the same arrays.
    expect(allSteps.length).toBe(12)

    const fileCache = new Map<string, string>()
    for (const { caseId, step } of allSteps) {
      expect(step.anchors.length, `${caseId}/${step.id} declares no code anchor`).toBeGreaterThanOrEqual(2)
      for (const anchor of step.anchors) {
        const candidateFiles = [anchor.file, ...(anchor.altFiles ?? [])]
        for (const file of candidateFiles) {
          expect(file, `${caseId}/${step.id} anchor path`).toMatch(/^(apps|packages|plugins)\//)
          if (!fileCache.has(file)) {
            const content = tryReadRepoFile(file)
            if (content !== null) fileCache.set(file, content)
          }
        }
        expect(
          anchorResolves(anchor, fileCache),
          `${caseId}/${step.id}: anchor token missing from ${candidateFiles.join(' and ')} -> ${anchor.token}`,
        ).toBe(true)
      }
    }
  })

  // The candidate-file rule itself, isolated from disk: anchorResolves() must accept a token that is
  // only in a candidate (altFiles) file, and must still refuse when the token is in neither. Simulated
  // entirely in memory — no repo file is read or written for this case.
  it('anchor resolution accepts a token found only in a candidate altFiles entry, and rejects one found in neither', () => {
    const contentByFile = new Map<string, string>([
      ['apps/web/src/views/FakePrimaryView.vue', 'export const unrelated = 1'],
      ['apps/web/src/components/fake/FakeCandidatePanel.vue', 'data-testid="fake-only-in-candidate"'],
    ])

    const resolvedViaCandidate: HelpCaseStepAnchor = {
      file: 'apps/web/src/views/FakePrimaryView.vue',
      altFiles: ['apps/web/src/components/fake/FakeCandidatePanel.vue'],
      token: 'fake-only-in-candidate',
    }
    expect(anchorResolves(resolvedViaCandidate, contentByFile)).toBe(true)

    const missingEverywhere: HelpCaseStepAnchor = {
      file: 'apps/web/src/views/FakePrimaryView.vue',
      altFiles: ['apps/web/src/components/fake/FakeCandidatePanel.vue'],
      token: 'fake-token-nowhere',
    }
    expect(anchorResolves(missingEverywhere, contentByFile)).toBe(false)
  })

  // ...and the anchors must actually reach the reader, not just sit in a constant the spec imports.
  it('every walkthrough step renders its code anchors in the page', async () => {
    const root = await mountView()
    const groups = [
      ['help-case-sql-source-anchors', INTEGRATION_HELP_SQL_SOURCE_CASE_STEPS],
      ['help-case-k3-wise-anchors', INTEGRATION_HELP_K3_WISE_CASE_STEPS],
    ] as const
    for (const [prefix, steps] of groups) {
      for (const step of steps) {
        const cell = root.querySelector(`[data-testid="${prefix}-${step.id}"]`) as HTMLElement | null
        expect(cell, `${prefix}-${step.id} is not rendered`).not.toBeNull()
        for (const anchor of step.anchors) {
          expect(cell!.textContent).toContain(anchor.file)
          expect(cell!.textContent).toContain(anchor.token)
        }
      }
    }
  })

  // Single-source, not relaxed (IU-6c): the error-code vocabulary has exactly one home on this page —
  // the table driven by integrationErrorCodeEntries(). The new walkthrough prose must therefore not
  // paste machine codes of its own; it describes refusals in words and anchors them by FUNCTION name.
  it('the walkthrough sections print no error code outside the single-source table', async () => {
    const root = await mountView()
    const registered = new Set<string>(integrationErrorCodeEntries().map((entry) => String(entry.code)))
    for (const locale of ['en', 'zh-CN'] as const) {
      useLocale().setLocale(locale)
      await flushUi()
      for (const testid of ['help-section-case-sql-source', 'help-section-case-k3-wise']) {
        const section = root.querySelector(`[data-testid="${testid}"]`) as HTMLElement
        // `[A-Z][A-Z0-9]+` for the first segment (not `{2,}`) so a two-character prefix like the K3
        // codes' `K3_` is covered — an earlier draft of this regex missed exactly that family, which
        // is the one most likely to be pasted into this page's prose.
        const codeLike = section.textContent?.match(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]{2,})+\b/g) ?? []
        const unregistered = codeLike.filter((token) => !registered.has(token))
        expect(unregistered, `${testid} (${locale}) prints code-like text outside the single source`).toEqual([])
      }
    }
  })

  it('case titles switch language when the shared locale switches (zh-CN <-> en)', async () => {
    useLocale().setLocale('zh-CN')
    const root = await mountView()
    const caseOneHeading = () => (root.querySelector('[data-testid="help-section-case-sql-source"] h2') as HTMLElement).textContent
    const caseTwoHeading = () => (root.querySelector('[data-testid="help-section-case-k3-wise"] h2') as HTMLElement).textContent
    expect(caseOneHeading()).toContain('SQL 只读源')
    expect(caseTwoHeading()).toContain('K3 WISE 预设')

    useLocale().setLocale('en')
    await flushUi()
    expect(caseOneHeading()).toMatch(/SQL read-only source/i)
    expect(caseTwoHeading()).toMatch(/K3 WISE preset/i)
    expect(caseOneHeading()).not.toContain('只读源')
  })

  it('when-to-use section explains single-hop read source vs two-hop composition, values-free', async () => {
    const root = await mountView()
    const section = root.querySelector('[data-testid="help-section-when-to-use"]') as HTMLElement
    expect(section.textContent).toMatch(/single hop|read source/i)
    expect(section.textContent).toMatch(/two.hop|composition/i)
    // values-free: no digit-run > 4 anywhere in this section's copy (no real material/BOM numbers).
    expect(section.textContent).not.toMatch(/\d{5,}/)
  })

  // Single-source tripwire: the rendered error-code row count must equal the label module's OWN
  // registered entry count. This proves the view iterates the module rather than hand-copying a list
  // — if a future label is added/removed in errorCodeLabels.ts, this test (not a hand-maintained
  // count) stays in sync automatically.
  it('error-code table row count equals the label module registered code count (single-source tripwire)', async () => {
    const root = await mountView()
    const expectedEntries = integrationErrorCodeEntries()
    expect(expectedEntries.length).toBeGreaterThan(0)

    const rows = root.querySelectorAll('[data-testid="help-section-error-codes"] tbody tr')
    expect(rows.length).toBe(expectedEntries.length)

    // Spot-check a couple of known codes actually appear with their label text rendered.
    const ambiguousRow = root.querySelector(
      '[data-testid="help-error-code-row-READ_SOURCE_RESOLVER_AMBIGUOUS"]',
    ) as HTMLElement | null
    expect(ambiguousRow).not.toBeNull()
    expect(ambiguousRow!.textContent).toContain('READ_SOURCE_RESOLVER_AMBIGUOUS')
  })

  it('a planted fake code does NOT appear anywhere in the rendered table', async () => {
    const root = await mountView()
    const table = root.querySelector('[data-testid="help-section-error-codes"]') as HTMLElement
    expect(table.textContent).not.toContain('TOTALLY_MADE_UP_ERROR_CODE_NOT_REAL')
    expect(root.querySelector('[data-testid="help-error-code-row-TOTALLY_MADE_UP_ERROR_CODE_NOT_REAL"]')).toBeNull()
  })

  // G12/G41 added two FAQ entries (read-source-vs-pipeline, permission-visibility) on top of the
  // original 7 — widened from 5-8 to 7-10 to fit; the lower bound still protects against silent
  // deletion and the upper bound is not unbounded, so a runaway FAQ list still fails loudly.
  it('FAQ section renders 7-10 values-free Q&A entries', async () => {
    const root = await mountView()
    const items = root.querySelectorAll('[data-testid="help-section-faq"] [data-testid^="help-faq-question-"]')
    expect(items.length).toBeGreaterThanOrEqual(7)
    expect(items.length).toBeLessThanOrEqual(10)
    const faqSection = root.querySelector('[data-testid="help-section-faq"]') as HTMLElement
    for (const item of Array.from(items)) {
      expect(item.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    }
    // values-free: no digit-run > 4 anywhere in the FAQ copy.
    expect(faqSection.textContent).not.toMatch(/\d{5,}/)
    // The two design-lock-named FAQ examples must be present.
    expect(faqSection.textContent).toMatch(/container/i)
    expect(faqSection.textContent).toMatch(/ambiguous|multiple BOMs/i)
    // The two G12/G41 additions must be present, and the permission-visibility answer must NOT
    // hand-copy a permission code list (it should point at the design doc instead).
    expect(faqSection.textContent).toMatch(/read source.*pipeline|pipeline.*read source/i)
    expect(faqSection.textContent).toMatch(/why can't i see|section or button/i)
    expect(faqSection.textContent).not.toMatch(/integration:write|stock-prep:read/)
  })

  it('has a back-to-workbench link in the page header', async () => {
    const root = await mountView()
    const back = root.querySelector('.ms-page-header__back') as HTMLElement | null
    expect(back).not.toBeNull()
  })
})
