# T3D-1 Automation Log + Delivery I18n Verification - 2026-05-21

## DoD

T3D-1 is limited to the automation execution log viewer, DingTalk group delivery viewer, DingTalk person delivery viewer, and the initial automation i18n label module.

PASS:
- `meta-automation-labels.ts` added with log, delivery, status, support, and error chrome labels plus typed helpers.
- `MetaAutomationLogViewer.vue`, `MetaAutomationGroupDeliveryViewer.vue`, and `MetaAutomationPersonDeliveryViewer.vue` render zh-CN chrome while preserving raw IDs, statuses, backend error messages, data attributes, and CSS suffixes.
- A11y boundary is locked by sentinel counts: no new `aria-label`, `title`, or `placeholder` attributes in the T3D-1 fixtures.
- Targeted Vitest: 3 files / 25 tests passed.
- `vue-tsc --noEmit`: exit 0 / no output.
- `pnpm --filter @metasheet/web build`: passed.
- `git diff --check origin/main..HEAD` and `git diff --check`: clean.

## Scope

In scope:
- `apps/web/src/multitable/utils/meta-automation-labels.ts`
- `apps/web/src/multitable/components/MetaAutomationLogViewer.vue`
- `apps/web/src/multitable/components/MetaAutomationGroupDeliveryViewer.vue`
- `apps/web/src/multitable/components/MetaAutomationPersonDeliveryViewer.vue`
- `apps/web/tests/meta-automation-labels.spec.ts`
- `apps/web/tests/meta-automation-delivery-viewers-i18n.spec.ts`
- `apps/web/tests/MetaAutomationLogViewer.spec.ts`
- `docs/development/multitable-t3d-automation-i18n-design-20260521.md`
- This verification note.

Out of scope:
- T3D-2 rule editor.
- T3D-3 automation manager shell/cards.
- T3D-4 DingTalk rule configuration copy.
- Backend, contracts, migrations, attendance, K3.

## Preflight Grep

Command:

```bash
rg -n "DingTalk Group Deliveries|All statuses|Success|Failed|Refresh|Loading deliveries|No DingTalk group deliveries|DingTalk Person Deliveries|Skipped / unbound|Inactive user|DingTalk account is not linked|Failed to load DingTalk|Execution Logs|Total|Avg duration|Failed to load logs|Retry|Loading logs|No execution logs found|Copy redacted packet|Download JSON|Clipboard unavailable|Redacted packet copied|Redacted JSON downloaded|Copy failed|Download failed" apps/web/src/multitable/components
```

Initial source hit set was confined to:
- `MetaAutomationLogViewer.vue`
- `MetaAutomationGroupDeliveryViewer.vue`
- `MetaAutomationPersonDeliveryViewer.vue`

Classification:
- Localized chrome: titles, status labels, buttons, loading/empty states, support-action labels.
- Raw data retained: IDs, usernames, backend error messages, DingTalk destination/user IDs, redacted packet content.
- Deferred: T3D-2/T3D-3/T3D-4 automation surfaces.

## Helper Reachability

Command:

```bash
rg -n "automationLabel\(|automationStatusLabel\(|automationActionTypeLabel\(|supportCopyFailed\(|supportDownloadFailed\(" apps/web/src/multitable apps/web/tests
```

Evidence:
- `automationLabel(...)`: label module + all 3 target components + label tests.
- `automationStatusLabel(...)`: log viewer, group delivery viewer, person delivery viewer, label tests.
- `automationActionTypeLabel(...)`: log viewer expanded step rows + label tests.
- `supportCopyFailed(...)`: log viewer catch path + label tests.
- `supportDownloadFailed(...)`: log viewer catch path + label tests.

T3D-1 is the first automation i18n slice, so there is no earlier T3D helper to reuse yet. This self-grep is the baseline reachability record for T3D-2/3/4.

## Tests

Command:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/meta-automation-labels.spec.ts \
  tests/MetaAutomationLogViewer.spec.ts \
  tests/meta-automation-delivery-viewers-i18n.spec.ts \
  --reporter=dot
```

Result:

```text
✓ tests/meta-automation-labels.spec.ts  (4 tests)
✓ tests/meta-automation-delivery-viewers-i18n.spec.ts  (4 tests)
✓ tests/MetaAutomationLogViewer.spec.ts  (17 tests)

Test Files  3 passed (3)
Tests       25 passed (25)
```

Coverage points:
- Helper key list uniqueness and en/zh readability.
- Status helper localization and unknown raw fallback.
- Action-type helper localization, legacy action aliases, and unknown raw fallback.
- Support failure helpers as localized prefix + raw detail.
- zh-CN log viewer chrome, raw `data-status`, raw `triggeredBy`, and support action behavior.
- zh-CN group/person delivery chrome, raw status attributes, raw user/subtitle/DingTalk IDs, localized static fallback, backend error raw preservation.
- English baseline remains available.

## A11y Sentinels

T3D-1 localizes existing visible text only. It does not add new a11y attributes.

Spec-locked fixture counts:
- Log viewer: `[aria-label] = 0`, `[title] = 0`, `[placeholder] = 0`.
- Group delivery viewer: `[aria-label] = 0`, `[title] = 0`, `[placeholder] = 0`.
- Person delivery viewer: `[aria-label] = 0`, `[title] = 0`, `[placeholder] = 0`.

## Raw Boundary

Preserved raw:
- `data-status` values (`success`, `failed`, `skipped`).
- CSS class suffixes derived from status values.
- `<option value="...">` status values.
- `triggeredBy`.
- log IDs, delivery IDs, rule IDs, and sheet IDs.
- DingTalk destination/user IDs.
- backend `Error.message` values.
- redacted support-packet content and filenames.
- unknown status/action enum values via `String(value)` fallback.

Localized:
- visible status text.
- target component chrome labels.
- static fallback messages where no backend message exists.
- support-copy/support-download success and failure prefixes.

## Typecheck And Build

Typecheck:

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result: exit 0 / no output.

Build:

```bash
pnpm --filter @metasheet/web build
```

Result:

```text
✓ built in 5.68s
```

Known build warnings:
- Existing Vite chunk-size warnings.
- Existing `WorkflowDesigner.vue` dynamic/static import warning.

Neither warning is introduced by this slice.

## Diff Hygiene

Commands:

```bash
git diff --check origin/main..HEAD
git diff --check
```

Result: both clean.

Dependency note:
- The T3D worktree did not have local dependencies installed.
- An ignored symlink `apps/web/node_modules -> /Users/chouhua/Downloads/Github/metasheet2/apps/web/node_modules` was used only to run web Vitest/typecheck/build from this worktree.
- Root `node_modules` symlink was removed.
- No `node_modules` path is staged or part of the PR diff.

## Conclusion

T3D-1 is ready for implementation review. It establishes `meta-automation-labels.ts`, localizes the smallest automation surface first, and preserves the raw runtime/config boundaries needed by later T3D slices.
