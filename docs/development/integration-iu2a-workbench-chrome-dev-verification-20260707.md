# IU-2a: Workbench chrome — PageShell + rail anchors + el-card sections + full tokenization — dev verification (2026-07-07)

Scope: design-lock `docs/development/integration-ux-workbench-redesign-design-lock-20260706.md`
(RATIFIED, #3739) §2 IU-2 stage A ("解构第一段:壳与导航,零逻辑搬移") + §3 hard locks. Stage B
(per-section component extraction + active-section switching) is a later slice, out of scope here.
Base = origin/main including IU-1 #3743 (`errorCodeLabels.ts`) and IU-6 #3750
(`IntegrationHelpView.vue` + `/help/integration` link).

**Zero-behavior-change discipline**: no script logic moved, no `data-testid` renamed/removed, no
service call / route contract / `v-if`/`v-model` semantics changed. The 49 pre-existing
`IntegrationWorkbenchView.spec.ts` tests pass **unchanged** — that is this slice's proof.

## What changed

### 1. PageShell + PageHeader chrome

`IntegrationWorkbenchView.vue`'s root is now wrapped in `<PageShell width="wide">` (mirroring
`src/views/approval/TemplateAuthoringView.vue`'s adoption pattern). **Width tier choice: `wide`**
(100%, not `default`'s 1200px) — the workbench is a six-group, multi-panel data-pipeline builder
with a 5-column mapping-editor grid and a 2-column preview pane; `default`'s 1200px cap would
force those grids into cramped columns, and the new sticky left rail needs its own horizontal
budget alongside the section stack.

The former hand-rolled `<header class="integration-workbench__header">` (eyebrow + h1 + lead +
K3/help links) is replaced by:
- `<p class="integration-workbench__eyebrow">Data Factory</p>` kept verbatim (same class, same
  text), now positioned just above `<PageHeader>` instead of above the old raw `<h1>`.
- `<PageHeader title="数据工厂" subtitle="连接任意 CRM / …">` — the original lead paragraph text
  becomes the subtitle (same position/role: one line directly under the title).
- The K3 WISE preset link + `/help/integration` link (`integration-help-link`, IU-6) move into
  `PageHeader`'s `#actions` slot, verbatim (same router-links, same classes, same testid) — this is
  the "keep/relocate the help link into PageHeader" instruction fulfilled.

Dead CSS pruned as a direct consequence (no longer any element to select): `.integration-workbench
h1`, `.integration-workbench__header` (both the flex rule and the two mobile media-query
references), and the `.integration-workbench__lead` selector (merged away, `.integration-workbench__panel p`
kept). `.integration-workbench`'s own `max-width/margin/padding` box-model rules were removed —
PageShell now owns the outer container; the class stays only as the descendant-selector scope for
`h2`/`input`/`select`/`textarea`/`code`/`pre`/`.panel` rules, which is why it wasn't deleted outright.

### 2. Sticky left rail — `IntegrationWorkbenchRail.vue` (new)

Structural mirror of `src/views/attendance/AttendanceAdminRail.vue`, deliberately simplified to
this slice's scope: **six fixed groups**, no filter/expand/compact-toggle machinery (that rail
manages a much larger admin surface; IU-2a is chrome + anchor navigation only). Presentational —
props `groups: IntegrationWorkbenchRailGroup[]`, `activeGroupId`, `tr` (bilingual helper); emits
`select(group)`. The view owns all state and DOM behavior.

Groups (design-lock §2 IU-2 taxonomy) map onto the ten existing `<section>` blocks as follows —
documented here because the mapping is not 1:1 and one group's sections are not DOM-contiguous:

| Rail group | Section id(s) | Original `<h2>` |
|---|---|---|
| 连接管理 (connection) | `int-sec-connection` | 连接系统 / 数据源 |
| 读取源 (read-source) | `int-sec-read-source` | 读取源配置(顾问自助) |
| 组合 (combination) | `int-sec-combination-config`, `int-sec-combination-run` | 读取源组合配置 / 读取源组合运行 |
| 清洗映射 (cleaning-mapping) | `int-sec-object-template`, `int-sec-cleaning-dataset`, `int-sec-cleaning-rules`, `int-sec-preview` | 选择系统与数据集 / 数据集与多维表清洗 / 清洗映射规则 / (样例记录+目标模板JSON+引用映射来源+Payload预览) |
| 运行与推送 (run-push) | `int-sec-run-push` | 运行与推送 |
| 监控与死信 (monitoring) | `int-sec-monitoring` | 运行监控 |

Note: `int-sec-preview` (the JSON/field-rule-authoring/payload-preview panel) is the very last
`<section>` in the DOM — physically after `int-sec-monitoring` — but assigned to 清洗映射 because
its content (target-template JSON, reference-mapping bindings, field-rule authoring) is
mapping-authoring work, not execution monitoring. Markup order could not change (zero-behavior-change
constraint), so the rail's active-highlight will jump back to "清洗映射" if a user scrolls past
monitoring to the very bottom — a documented, accepted quirk of a chrome-only slice, not a bug.

**Behavior in this slice (anchor navigation only, no show/hide)**: clicking a rail button calls
`document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' })` and
optimistically sets the active group; a feature-detected `IntersectionObserver`
(`typeof IntersectionObserver === 'undefined'` guard — true in this project's jsdom test
environment, no polyfill installed) tracks scroll position across all ten section ids and updates
the active highlight to whichever section has the highest `intersectionRatio`. All ten sections
stay rendered unconditionally (no `v-if`) — that is what keeps the 49 tests green.

### 3. Section chrome — `el-card shadow="never"` wrapping

Each of the ten `<section class="integration-workbench__panel">` blocks got a stable `id` and is
now wrapped in `<el-card shadow="never">`; the original `panel-head` div (title `<h2>` + description
`<p>` + optional action button, e.g. `refresh-systems`/`add-mapping`/`save-pipeline`/
`refresh-observation`) moved verbatim into the card's `#header` slot, with the rest of the
section's original content in the default slot. This is a markup-wrapper-only change — no
attribute, testid, `v-if`, or `v-model` inside any moved block was touched. The tenth section
(`int-sec-preview`) has no single title (it contains four `<h2>`s across a two-column preview
layout) so it is wrapped in `el-card` without using the header slot — its content stays in the
default slot as-is.

### 4. Tokenization — 142 → 0

Style-block audit before this slice: **140** hex literals in `IntegrationWorkbenchView.vue`'s
`<style scoped>` block (the design-lock's "142" audit figure is close enough — likely counted
before/after an intervening one-line UF-6-era edit; the two other `#`-prefixed matches in the file,
`#2232`/`#1970`, are GitHub issue references in comments, not colors, confirmed by inspection).
Every literal mapped onto an existing `--ms-*`/`--el-*` token (mapping table below); **zero**
hex/rgb literals remain (`grep -c` verified, and the file is now in `ui-foundation-style-guard.spec.ts`'s
`TARGET_FILES`, so this is CI-enforced going forward, not just a one-time grep).

Representative mappings (full set is 52 distinct source values → the token below; convergence of
several near-identical legacy shades onto one token is intentional design-system consolidation):

| Legacy hex family | Token |
|---|---|
| `#5c6878`/`#3c4b60`/`#54637a`/`#42536a`/`#5a6473` (secondary/body text) | `var(--ms-text-2)` |
| `#1f3551`/`#17202a`/`#233246`/`#35465c`/`#24476b`/`#111827` (dark title/label text) | `var(--ms-text-1)` |
| `#d8e0e8`/`#d7deea` (panel border) | `var(--ms-border-light)` |
| `#e4ebf2` (thin dividers, table borders) | `var(--el-border-color-lighter)` |
| `#bfccd9`/`#cbd5e1` (input/button border) | `var(--ms-border)` |
| `#ffffff`/`#fbfcfe` (card background) | `var(--ms-bg-card)` |
| `#f8fafc`/`#f8fbff` (subtle panel background) | `var(--ms-bg-page)` |
| `#8f1d1d`/`#9b1c1c` (danger text) | `var(--el-color-danger)` |
| `#fff0f0`/`#fbe7e7` (danger background) | `var(--el-color-danger-light-9)` |
| `#17622f`/`#1f6f43` (success text) | `var(--el-color-success-dark-2)` |
| `#edf7ef`/`#e3f3e8`/`#f3fbf5` (success background) | `var(--el-color-success-light-9)` |
| `#744600`/`#92400e`/`#8a5a12`/`#8a4d00`/`#7c2d12`/`#7a4a00`/`#5b3417` (warning/brown text) | `var(--el-color-warning-dark-2)` |
| `#fff8e8`/`#fffaf5`/`#fff7ed`/`#fdf3e0` (warning background) | `var(--el-color-warning-light-9)` |
| `#f3d8bd`/`#f3c8a8` (warning border) | `var(--el-color-warning-light-7)` |
| `#357abd`/`#1f5f99` (link/action blue) | `var(--ms-color-primary)` |
| `#eef4fb`/`#eef2ff`/`#e7eef6`/`#e5edf7` (info/primary tint background) | `var(--el-color-primary-light-9)` |
| `#111827` (dark `pre` background) | `var(--ms-text-1)` — this is an **exact** value match (tokens.css defines `--ms-text-1: #111827`) |
| `#3730a3` | `var(--el-color-primary-dark-2)` |
| `#b9dfc4` | `var(--el-color-success-light-7)` |
| `#c77777` | `var(--el-color-danger-light-3)` |
| `#eef2f7` | `var(--el-fill-color-light)` |

All static `style="..."` attributes: zero before, zero after (none were ever present in this file).

### 5. Nav orphan fix — `/data-sources`

`apps/web/src/App.vue`: added one `router-link` to `/data-sources`, gated by the same
`canUseIntegration` computed (`hasPermission('integration:write')`) as the existing 数据工厂 entry,
placed immediately after it. New `navLabels.dataSources` key (`外接数据源` / `Data Sources`),
matching the route's own `meta.titleZh`. No other nav restructuring.

### 6. Help link

Already present from IU-6 (`data-testid="integration-help-link"`, `to="/help/integration"`) —
relocated into `PageHeader`'s `#actions` slot per item 1 above, text/route/testid unchanged.

## Zero-behavior-change statement

- No `services/integration/*.ts` file touched; no wire shape, route contract, or permission gate
  changed.
- No `data-testid` renamed or removed anywhere in `IntegrationWorkbenchView.vue`.
- No `v-if`/`v-model` semantics changed — every conditional and binding is byte-identical to before,
  only re-parented one level deeper (into `el-card`'s slots) where sections were wrapped.
- `App.vue`: purely additive nav entry; existing entries/order otherwise unchanged.
- `pnpm exec vue-tsc -b` clean (exit 0) on both Node 20.20.2 and the default local Node 25.9.0.

## Test evidence

**Baseline (before this slice, unmodified origin/main HEAD `ea62caaf8`)**, confirmed via
`git stash` / run / `git stash pop` (not just "tests pass" — actually re-ran against the pristine
file):

```
pnpm exec vitest run IntegrationWorkbenchView --reporter=dot
✓ tests/IntegrationWorkbenchView.spec.ts  (49 tests)
Test Files  1 passed (1) · Tests  49 passed (49)
```

**After this slice — the same 49 tests, unchanged assertions, still green** (only test-harness
plumbing added: a local `ElCard` stub registered on each test's `createApp()` instance, since real
Element Plus is not globally installed in this spec's test harness and the view now renders
`<el-card>`; this is infrastructure, not a change to what any of the 49 tests assert):

```
pnpm exec vitest run IntegrationWorkbenchView --reporter=dot
✓ tests/IntegrationWorkbenchView.spec.ts  (49 tests)
Test Files  1 passed (1) · Tests  49 passed (49)
```

**New spec** `apps/web/tests/IntegrationWorkbenchRail.spec.ts` (6 tests): rail unit tests (renders
all six groups, active-group `aria-current`/class, `select` emit carries the full group object) +
a light Workbench integration check (PageShell `wide` + PageHeader title present, rail + all ten
section ids present, a rail click calls `scrollIntoView` on the right section element, and the view
mounts with no crash when `IntersectionObserver` is unavailable — jsdom's actual default, not
simulated).

**Style guard**: `IntegrationWorkbenchView.vue` and the new `IntegrationWorkbenchRail.vue` added to
`ui-foundation-style-guard.spec.ts`'s `TARGET_FILES` (ADDED to the existing UF-6 mechanism, not
duplicated — no new style-scan spec file was written).

Full integration-guard list, extended with `IntegrationWorkbenchRail`, run on **both** runtimes:

```
pnpm --filter @metasheet/web exec vitest run composition-vocab-mirror multitable-resolver-vocab-mirror \
  integrationErrorCodeLabels fieldHints IntegrationReadSourceConfigPanel \
  IntegrationReadSourceCompositionPanel IntegrationReadSourceCompositionAuthoringPanel \
  readSourceCompositions.service IntegrationWorkbenchView IntegrationWorkbenchRail \
  IntegrationK3WiseSetupView IntegrationHelpView --reporter=dot

Test Files  12 passed (12) · Tests  187 passed (187)   [Node 20.20.2 AND Node 25.9.0]
```

Also ran, both runtimes:
- `apps/web/tests/ui-foundation-style-guard.spec.ts` — 53 passed (was 47; +2 files × 2 axes + net
  helper-test parity — style guard is green with both new files at zero hex/rgb and zero static
  `style=`).
- The full `approval-web-guard.yml` vitest filter list (which runs `ui-foundation-style-guard` and
  `pageShell`) — 523 passed (29 files), confirming the `App.vue`/`PageShell`/`PageHeader` reuse
  didn't regress the approval surface.
- `apps/web/tests/App.spec.ts` — 2 passed (nav change doesn't touch anything it asserts).
- `pnpm exec vue-tsc -b` — clean.

Known noise, pre-existing and unrelated: `apps/web/tests/approvalStaticPicker.spec.ts` has 2 failing
tests (`ensureUserOptionVisible` hydration assertions) — confirmed identical on unmodified
origin/main via stash/run/pop; unrelated to this slice, not in any guard list this PR touches, left
untouched. Console noise: `[Vue warn] Failed to resolve component: el-tooltip` (pre-existing, same
as IU-6's note) and two new-but-harmless warnings from `PageHeader` in the bare test harness
(`injection "Symbol(router)" not found`, `Failed to resolve component: el-icon/el-button` — both
from `PageHeader`'s unconditional `useRouter()` call and its `v-if="showBack"`-gated back button,
neither of which this view exercises since no `back`/`backTo` prop is passed); assertions are
unaffected.

## IU-2b remainder (explicitly NOT in this slice)

- Per-section component extraction (splitting the six/ten-section monolith's script logic into
  dedicated components) — this slice is chrome-only, zero script migration.
- Active-section switching with show/hide (this slice keeps all ten sections permanently rendered;
  only the rail highlight changes on scroll).
- `IntegrationK3WiseSetupView.vue` tokenization (0/107 hex per the design-lock's audit baseline) —
  out of IU-2a's named scope (`IntegrationWorkbenchView.vue` + nav wiring only).
- IU-3/IU-4/IU-5 (read-source wizard, composition wizard, JSON-textarea structuring) remain
  gated on IU-2 landing per the design-lock's slice ladder.

## Files touched

- `apps/web/src/views/IntegrationWorkbenchView.vue` (PageShell/PageHeader/rail wiring, ten
  `el-card`-wrapped sections with stable ids, full style-block tokenization, dead-CSS pruning)
- `apps/web/src/components/integration/IntegrationWorkbenchRail.vue` (new)
- `apps/web/src/App.vue` (`/data-sources` nav entry + `navLabels.dataSources`)
- `apps/web/tests/IntegrationWorkbenchView.spec.ts` (ElCard test-harness stub only — no assertion
  changes)
- `apps/web/tests/IntegrationWorkbenchRail.spec.ts` (new)
- `apps/web/tests/ui-foundation-style-guard.spec.ts` (`TARGET_FILES` +2)
- `.github/workflows/integration-guard.yml` (path triggers + vitest run list +
  `IntegrationWorkbenchRail`)
- `.github/workflows/approval-web-guard.yml` (path triggers for the two files now covered by
  `ui-foundation-style-guard.spec.ts`)
- `docs/development/integration-iu2a-workbench-chrome-dev-verification-20260707.md` (this file)
