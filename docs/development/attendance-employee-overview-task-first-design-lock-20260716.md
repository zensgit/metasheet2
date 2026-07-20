# Employee attendance overview task-first design lock - 2026-07-16

> **Status: RATIFIED (owner 2026-07-21).** Owner review verdict: 设计层面
> APPROVE, 0 P1 / 0 P2 — OD-O1 through OD-O4 all accepted at their recommended
> values (ruling date 2026-07-21; recorded in §10). Ratification basis: the
> independent post-#4359 doc-sync recheck returned **NO-DRIFT** against landed
> main (`962fff55f` — every surface this lock references survives unchanged;
> verdict re-verified on the landed squash; record at PR #4370 review comment,
> 2026-07-21) and the owner independently confirmed Wave 0 `426ea624c` /
> Wave 1 `962fff55f` are ancestors of current `origin/main`. Per charter §14
> step 4 / §15, this ratification authorizes opening the Wave 2 runtime PR for
> issue #4355 from post-#4370-merge main — runtime work still lands through its
> own PR with the full charter §8.1 gate battery; this document itself changes
> no runtime.

## 1. Grounded problem statement

The overview already has the necessary employee capabilities, but their visual
priority does not match daily attendance work:

- `AttendanceView.vue` renders the live punch hero first, then immediately
  renders the full date/org/user filter row.
- The self-service grid starts with annual-leave balance, followed by status,
  rules, request status, quick actions, and the status guide. All six cards are
  siblings with similar visual weight.
- The lower overview then repeats range summary, calendar, request creation,
  anomaly handling, request report, and records. This makes the page complete,
  but the first viewport does not reliably answer "What must I do now?"
- The existing state logic is valuable and must be reused. In particular,
  `activeWorkbenchRecord`, `heroTodayTimeline`, `selfServiceFocusItems`,
  `selfServiceRequestFollowup`, and `selfServicePrimaryAction` already derive
  today's record, punch timeline, anomaly follow-up, pending requests, and the
  first available action.
- Punch failures are currently rendered through the shared `statusMessage`
  block inside the filter row. Moving or collapsing filters without moving the
  status block would hide the most time-sensitive feedback.

The work is therefore an information-architecture and responsive-layout slice,
not a new attendance engine.

## 2. Scope and hard boundaries

### In scope

1. Recompose the employee overview into three ordered bands:
   **Today**, **Needs attention**, and **More attendance tools**.
2. Place today's punch actions, timeline, status, and exactly one recommended
   follow-up ahead of all historical/filter content.
3. Move date/org/user filters into a collapsed-by-default history control while
   preserving every existing input, query, and refresh behavior.
4. Reorder existing request status, quick actions, annual balance, rules,
   summary, calendar, request form, anomaly, report, and records surfaces.
5. Add focused state-priority, DOM-order, deep-link, and responsive visual
   verification.

### Out of scope

- No punch calculation, location policy, retry policy, attendance policy,
  approval, request, anomaly, record, or calendar semantic change.
- No backend route, payload, schema, permission, org-scope, or database change.
- No removal of existing self-service functions or supported deep links.
- No new employee analytics, notification channel, or mobile-native shell.
- No admin-center redesign (#4353) and no attendance-group workspace redesign
  (#4354/#4359) in this slice.

## 3. Required landing order

At the 2026-07-16 grounding snapshot, `#4359` is an active draft that modifies
`AttendanceView.vue` and attendance web tests. Regardless of its later PR state,
the #4355 runtime branch must not be authored from a pre-#4359 tree.

Required order:

1. #4359 reaches main with its own gate green.
2. Re-read the post-#4359 `AttendanceView.vue` and self-service specs; update this
   lock only if the group-workspace work changed shared overview behavior.
3. Owner ratifies this lock and its decisions in section 10.
4. Build #4355 runtime from fresh `origin/main`.
5. Serialize #4353 and #4355 runtime work because both use the same large Vue
   file. Recommended product order is #4359 -> #4355 -> #4353: finish the active
   group slice, make the employee daily surface task-first, then reorganize the
   admin center.

This ordering is a collision constraint, not a hidden dependency between the
employee and admin experiences.

## 4. Information architecture

### 4.1 Today band

The first overview band is a full-width daily workspace with two sibling
surfaces, not nested cards:

1. **Today's punch**: current time/date, check-in, check-out, and the existing
   two-node in/out timeline.
2. **Today's status**: today's record status and compact values for latest punch,
   work minutes, and late/early minutes.

The existing punch buttons remain the only punch write path and continue to call
`punch('check_in')` / `punch('check_out')`. The timeline remains derived from
`heroTodayTimeline`; a historical fallback record must never be presented as
today's timeline.

The shared status banner moves out of the filter row and directly below the
daily workspace. Its message, code, hint, and real retry action remain intact.
The outdoor-note form remains adjacent to the punch outcome. It must not be
hidden inside the history disclosure.

### 4.2 Needs-attention band

Render one canonical attention item with one primary action. Do not render the
existing focus list and recommended-action callout as two competing copies.
The runtime should extract or extend one pure priority builder and have both
copy and action come from that single source.

Priority is deterministic and first-match-wins:

| Priority | State | Required presentation | Action |
|---|---|---|---|
| 1 | Outdoor note required or an actionable punch failure | Preserve message, code, hint, and any real retry control next to the hero | Existing note retry or `statusActionLabel`; never invent a retry for location-restricted errors |
| 2 | Current focus date has an anomaly | State the anomaly count and focus date | Existing missing-punch flow |
| 3 | Latest request is rejected and needs a new submission/review | State that the request was rejected without calling it pending | Existing request history/report path |
| 4 | One or more requests are pending | State pending count; do not imply the employee can approve | Existing request report path |
| 5 | Focus record is late, early, late+early, partial, or absent | Describe the recorded status | Existing records path |
| 6 | No record/request/anomaly signal exists | Reuse the current attendance-setup guidance | Clear no-data/setup state; no fake action |
| 7 | Normal, adjusted, off, or otherwise caught up | Explicit all-clear state | No primary write action; records remains secondary |

The builder may consume the same facts currently used by
`selfServiceFocusItems` and `selfServiceRequestFollowup`; it must not fetch new
data or reinterpret backend status codes. Unknown statuses fail closed to a
neutral "review records" presentation, never to "all clear."

### 4.3 More-attendance-tools band

After the daily workspace and attention item, present supporting functions in
this order:

1. Request status and recent requests.
2. Quick actions: missing punch, leave, overtime, shift swap, and records.
3. Annual-leave balance.
4. Attendance rules, collapsed or visually de-emphasized by default.
5. History filters and historical surfaces: summary, calendar, request form,
   anomalies, request report, and records.
6. Status guide as low-frequency reference content.

The request form and historical detail remain on the same route. Quick actions
continue to prefill and scroll; they do not open a second implementation.

## 5. Filter and status behavior

- Add a stable `data-attendance-history-filters` disclosure immediately before
  historical content. It is collapsed by default on overview and contains the
  existing From, To, Org ID, User ID, and Refresh controls.
- Use disclosure/visibility behavior that preserves input state and mounted DOM.
  Closing the control must not reset filters or trigger network requests.
- A deep link to any existing overview section may open/scroll the relevant
  historical region, but it must not alter the filter values.
- The status block is not part of the disclosure. Punch, refresh, request, and
  other actionable outcomes must stay visible when filters are collapsed.
- Reports mode keeps its current report-toolbar behavior. This lock changes only
  `mode === 'overview'` presentation.

## 6. Compatibility contracts

The runtime implementation must preserve:

- Existing selectors including `data-testid="attendance-hero-punch"`,
  `data-testid="attendance-hero-timeline"`, every `data-selfservice-card`,
  `data-selfservice-action`, request-form id, and request/record selector.
- Existing overview section ids:
  `attendance-overview-requests`, `attendance-overview-anomalies`,
  `attendance-overview-request-report`, and `attendance-overview-records`.
- Approval-center focused-request landing via `initialSectionId` and
  `initialRequestId`.
- Employee-only request actions: normal overview cards must not expose approve or
  reject actions.
- Existing API call count, request payloads, status/error mapping, stale-state
  clearing, punch-note retry payload, and no-settings-read employee posture.
- Existing locale behavior and current `tr('EN', '中文')` copy source.

No component may duplicate an existing DOM id. Reordering is allowed; creating a
second hidden copy of a form or card is not.

## 7. Responsive layout contract

### Desktop: 1440 x 900

- Today's punch/status workspace and the current attention item are visible
  without page scrolling at the viewport size named in #4355.
- Use a restrained two-column composition: the daily workspace is the dominant
  column; the attention surface is the supporting column. Stable grid tracks or
  `minmax()` constraints prevent text or status chips from resizing the layout.
- No horizontal page scroll. Long translated copy wraps; buttons do not overlap
  the timeline or status.
- The filter disclosure begins below the primary daily/supporting content.

### Mobile: 390 x 844

- DOM and visual order is: today status/punch -> primary attention action ->
  request/quick-action support -> all lower-frequency content.
- One-column layout, no horizontal page scroll, and no fixed-width control wider
  than the content viewport.
- Punch buttons remain touch-sized. They may be stacked, but the time/timeline
  and primary action cannot be obscured by them.
- The history disclosure and all existing form controls remain usable after
  expansion. Long codes, names, and bilingual text wrap inside their parent.

The implementation must use existing `--ms-*` tokens for new colors, spacing,
radii, and shadows. It must not introduce a new one-hue visual theme, decorative
background art, or custom inline SVG icons.

## 8. Runtime file shape

Recommended single runtime PR after ratification:

1. `apps/web/src/views/attendance/attendanceOverviewPriority.ts` - pure state
   selector and types only.
2. `apps/web/src/views/AttendanceView.vue` - layout and wiring; no API changes.
3. `apps/web/tests/attendance-overview-priority.spec.ts` - pure matrix tests.
4. `apps/web/tests/attendance-selfservice-dashboard.spec.ts` - mounted DOM,
   actions, selector compatibility, and deep-link regression tests.
5. `.github/workflows/attendance-web-guard.yml` - add the new pure spec to the
   run list and both path-filter blocks. The existing self-service spec is
   already truly wired; a new spec without all three workflow edits is
   skip-shaped green.

If the priority logic stays inside the already-wired self-service spec instead
of a new file, the workflow file need not change. Do not create a new spec and
leave it outside the required guard.

No feature flag is recommended: this is a reversible frontend hierarchy change
with preserved APIs and selectors. Rollback is the runtime PR revert. A flag
would double the template paths and make responsive verification less honest.

## 9. Verification gates

### 9.1 Pure priority matrix

Tests must independently pin:

- actionable punch failure outranks anomaly and requests;
- anomaly outranks rejected/pending requests;
- rejected request is not lost behind an all-clear record;
- pending request never exposes approval actions;
- late/early/partial/absent map to records review;
- setup/no-data has no fabricated CTA;
- normal/off/all-clear does not fabricate a blocking task;
- unknown record/request state fails to neutral review, not success.

At least two mutations must be recorded: swap anomaly and request precedence;
and map unknown status to all-clear. Each mutation must make its targeted test
red.

### 9.2 Mounted integration

Extend `attendance-selfservice-dashboard.spec.ts` to prove:

- daily workspace precedes the attention and secondary bands in DOM order;
- exactly one primary recommended action is rendered;
- the filters start collapsed, expand without resetting values, and refresh with
  the same query shape;
- status message/code/hint and outdoor-note retry remain visible while filters
  are collapsed;
- every existing quick action still reaches the canonical request form or
  records section;
- focused approval-center deep links still load and expose review actions only
  for the focused pending request;
- all existing self-service selector and no-settings-read regressions remain
  green.

### 9.3 Visual verification

Use Playwright against the real local Vue surface at 1440x900 and 390x844.
Capture normal, anomaly/missing-punch, pending-request, punch-error, and no-data
states. For each viewport verify:

- `document.documentElement.scrollWidth <= document.documentElement.clientWidth`;
- primary surfaces have non-zero bounding boxes;
- no overlap among punch buttons, timeline, status banner, attention action, and
  the next section;
- desktop primary surfaces are above the fold;
- mobile daily and primary-action nodes precede secondary nodes and remain
  readable without horizontal pan.

Screenshots are review evidence, not a substitute for DOM/state assertions.

### 9.4 Required commands

```bash
pnpm --filter @metasheet/web exec vitest run \
  attendance-overview-priority attendance-selfservice-dashboard --reporter=dot
pnpm --filter @metasheet/web exec vue-tsc -b
```

The PR must also pass the full `attendance-web-guard` required check after a
fresh rebase onto the post-#4359 main branch.

## 10. Owner decisions

Ratification records these defaults unless the owner explicitly changes one:

- **OD-O1 - attention precedence:** accept the first-match order in section 4.2
  (**recommended**).
- **OD-O2 - filters:** collapsed-by-default history disclosure on overview;
  reports mode unchanged (**recommended**).
- **OD-O3 - supporting content:** request status and quick actions before annual
  balance/rules; rules de-emphasized but not removed (**recommended**).
- **OD-O4 - rollout:** direct frontend rollout after post-#4359 rebase, required
  guard, typecheck, and two-viewport visual proof; no parallel legacy template
  and no feature flag (**recommended**).

**Ratified 2026-07-21**: the owner accepted OD-O1, OD-O2, OD-O3, and OD-O4 at
their recommended values, with no modifications ("OD-O1～O4 的推荐裁决可接受",
owner review 2026-07-21). Runtime work for issue #4355 (charter Wave 2) is
authorized from post-#4370-merge main onward, subject to the charter §8.1 gate
battery on the runtime PR itself.

## 11. Completion definition

#4355 is complete only when:

1. this lock is RATIFIED;
2. the runtime PR lands after #4359 from fresh main;
3. all priority, mounted, guard, typecheck, and visual gates pass;
4. desktop and mobile screenshots demonstrate the issue acceptance criteria;
5. a verification MD records the exact merged SHA, test commands/results,
   mutation evidence, viewport evidence, and any deliberately deferred item.

Design-lock merge alone is not runtime completion.
