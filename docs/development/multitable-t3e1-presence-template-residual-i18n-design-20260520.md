# T3E-1 Presence + Template Residual i18n Design

Date: 2026-05-20
Branch: docs/multitable-t3e1-residual-i18n-design-20260520
Status: design only; no code changes yet

## 1. Decision Summary

T3E-1 is a small residual i18n slice. It intentionally avoids opening the larger manager/dialog surfaces.

| Decision | Outcome |
| --- | --- |
| Scope | Localize `MetaYjsPresenceChip` default copy and Workbench template-library fallback/toast strings |
| Module placement | Reuse existing label modules: `meta-core-labels.ts` for presence default, `workbench-labels.ts` for template-library copy |
| Raw data boundary | User IDs, template names, and server/runtime `error.message` values remain raw |
| Out of scope | Workbench dynamic toast bulk, `MetaBulkEditDialog`, `ConditionalFormattingDialog`, T3D automation |
| Implementation gate | Design MD review first, then code + verification MD, stop before push |

## 2. Files In Scope

Implementation files:

| File | Planned change |
| --- | --- |
| `apps/web/src/multitable/components/MetaYjsPresenceChip.vue` | Replace hard-coded default label with locale-aware computed default |
| `apps/web/src/multitable/utils/meta-core-labels.ts` | Add `presence.collaboratingNow` |
| `apps/web/src/multitable/views/MultitableWorkbench.vue` | Replace template-library fallback strings and install toasts with workbench labels/helpers |
| `apps/web/src/multitable/utils/workbench-labels.ts` | Add template-library error/toast keys and `templateInstalled()` helper |

Test files:

| File | Planned change |
| --- | --- |
| `apps/web/tests/multitable-core-i18n.spec.ts` | Cover the new core presence key |
| `apps/web/tests/yjs-awareness-presence.spec.ts` | Cover zh-CN default label and explicit-label preservation |
| `apps/web/tests/multitable-workbench-i18n.spec.ts` | Cover new Workbench keys and `templateInstalled()` helper |

Docs:

| File | Planned change |
| --- | --- |
| `docs/development/multitable-t3e1-presence-template-residual-i18n-design-20260520.md` | This design plan |
| `docs/development/multitable-t3e1-presence-template-residual-i18n-verification-20260520.md` | To be created during implementation |

## 3. Exact Chrome Targets

### 3.1 MetaYjsPresenceChip

| Source | Current EN | zh-CN | Key/helper | Notes |
| --- | --- | --- | --- | --- |
| `MetaYjsPresenceChip.vue` default prop label | `Collaborating now` | `正在协作` | `presence.collaboratingNow` | Only used when caller does not pass `label` |

Current template also builds a title from the label plus raw user IDs:

```vue
:title="`${label}: ${filteredUsers.map((user) => user.id).join(', ')}`"
```

Implementation should use the resolved label for both visible text and title, but must keep the user IDs raw.

### 3.2 Workbench Template Library

| Source | Current EN | zh-CN | Key/helper | Notes |
| --- | --- | --- | --- | --- |
| `loadTemplateLibrary()` fallback | `Failed to load templates` | `加载模板失败` | `tpl.errorLoad` | Only used when `e.message` is absent |
| install permission toast | `Template installation requires multitable write access.` | `安装模板需要多维表写入权限。` | `toast.templateInstallBlocked` | Appears in both `openTemplateLibrary()` and `onInstallTemplate()` |
| install sync fallback | `Installed template but failed to refresh workbench context` | `模板已安装，但刷新工作台上下文失败` | `toast.templateRefreshFailed` | Only used when `workbench.error.value` is absent |
| install success | `Installed ${templateName}` | `已安装 ${templateName}` | `templateInstalled(templateName, isZh)` | Template name remains raw data |
| install failure fallback | `Failed to install template` | `安装模板失败` | `toast.templateInstallFailed` | Only used when `e.message` is absent |

## 4. Label Module Plan

### 4.1 `meta-core-labels.ts`

Add one key to the existing core label module instead of creating a one-string module:

```ts
| 'presence.collaboratingNow'
```

Planned mapping:

```ts
'presence.collaboratingNow': {
  en: 'Collaborating now',
  zh: '正在协作',
}
```

Rationale: `MetaYjsPresenceChip` is a shared low-level Meta* component and this residual label belongs with existing core chrome such as cell/table labels.

### 4.2 `workbench-labels.ts`

Add static keys:

```ts
| 'tpl.errorLoad'
| 'toast.templateInstallBlocked'
| 'toast.templateRefreshFailed'
| 'toast.templateInstallFailed'
```

Add helper:

```ts
export function templateInstalled(templateName: string, isZh: boolean): string {
  return isZh ? `已安装 ${templateName}` : `Installed ${templateName}`
}
```

Rationale: Workbench template-library strings already sit inside the Workbench shell. The helper preserves the template name as raw user/data content while localizing the surrounding chrome.

## 5. Implementation Notes

### 5.1 MetaYjsPresenceChip Default Must Be Reactive

Do not keep the label in `withDefaults()` as a string default, because that default is not locale-reactive.

Planned shape:

```ts
const props = withDefaults(defineProps<{
  users?: PresenceUser[]
  currentUserId?: string | null
  fieldId?: string | null
  label?: string
}>(), {
  users: () => [],
  currentUserId: null,
  fieldId: null,
})

const { isZh } = useLocale()
const resolvedLabel = computed(() => props.label ?? coreLabel('presence.collaboratingNow', isZh.value))
```

The template should use `resolvedLabel` for both visible text and title.

### 5.2 Explicit Label Prop Remains Caller-Controlled

Existing consumers that pass a label must keep full control. Example: `MetaCellEditor.vue` passes the T3A2-localized `cell.editing` label and should not be overridden by the new default logic.

Test requirement: keep or add a spec proving an explicit label such as `Editing now` remains visible as-is.

### 5.3 Workbench Error Values Are Event-Time Strings

`templateLibraryError` stores a string at the time the async failure occurs. If the user changes locale after the error was stored, the stored fallback will not retranslate until a reload/retry. This is acceptable for this slice because existing toast/error behavior is event-time based.

Server/runtime `e.message` and `workbench.error.value` remain raw when present. Only frontend fallback strings are localized.

Same event-time semantic applies to `templateInstalled()` after its return value enters the toast queue. A locale toggle after install will not retranslate the success toast, which is acceptable for ephemeral toasts.

### 5.4 Preflight Grep

Before module changes, run:

```bash
rg -n "Collaborating now|Failed to load templates|Template installation requires|Installed template but failed|Installed |Failed to install template" apps/web/src/multitable/ apps/web/tests/
```

Confirm each planned key maps to a real call-site; resolve any miss before wiring.

## 6. Raw Data / Do-Not-Translate Boundary

| Value | Boundary |
| --- | --- |
| Presence user IDs in `MetaYjsPresenceChip` title | Raw identifiers, not translated |
| Explicit `label` prop passed to `MetaYjsPresenceChip` | Caller-owned, not retranslated by the component |
| Template names in install success toast | Raw template data, only the surrounding sentence is translated |
| `e.message` from runtime/server errors | Raw error value preserved when present |
| `workbench.error.value` | Raw runtime value preserved when present |

## 7. Test Plan

Targeted frontend tests:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-core-i18n.spec.ts \
  tests/yjs-awareness-presence.spec.ts \
  tests/multitable-workbench-i18n.spec.ts \
  --watch=false
```

Type/build gates:

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
```

Diff hygiene:

```bash
git diff --check origin/main..HEAD
```

Expected new/updated coverage:

| Spec | Coverage |
| --- | --- |
| `multitable-core-i18n.spec.ts` | New `presence.collaboratingNow` key is covered in the exhaustive key list |
| `yjs-awareness-presence.spec.ts` | zh-CN default renders `正在协作`; explicit labels remain unchanged; raw IDs remain in title |
| `multitable-workbench-i18n.spec.ts` | New Workbench static keys plus `templateInstalled()` en/zh helper behavior |

## 8. Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Default presence label is not locale-reactive | Remove string default from `withDefaults()` and use a computed fallback from `useLocale()` |
| Explicit label consumers regress | Keep existing explicit-label spec and add default-only spec separately |
| Template name accidentally translated or normalized | `templateInstalled()` accepts and preserves raw `templateName` |
| Runtime/server error text accidentally translated | Use localized fallback only behind `e.message ?? ...` and `workbench.error.value ?? ...` |
| Workbench heavy render tests become brittle | Keep this slice covered by label-helper tests plus the narrow presence component spec; do not mount full Workbench for these static fallbacks |

## 9. Deferred Surfaces

These were found during scout but are intentionally out of T3E-1:

| Deferred slice | Surface | Reason |
| --- | --- | --- |
| T3E-2 | Workbench dynamic toasts/fallbacks | Many interpolated and workflow-dependent strings; needs separate grep classification |
| T3E-3 | `MetaBulkEditDialog.vue` | Full dialog chrome, parent-generated bulk-edit messages, and action/count grammar belong together |
| T3E-3 | `ConditionalFormattingDialog.vue` | Rule editor dialog with operator/color/confirm strings; should not be mixed into T3E-1 |
| T3D | Automation manager/rule editor/log viewer | Larger rule-domain surface with enum semantics; requires design MD first |
| Final audit | Global multitable i18n grep | Best after T3D/T3E residual slices are complete |

## 10. Acceptance Gate

Implementation can start after design review if these conditions remain true:

1. Scope stays limited to presence default + Workbench template-library fallback/toasts.
2. No `MetaBulkEditDialog.vue` or `ConditionalFormattingDialog.vue` code changes in T3E-1.
3. No backend, contract, migration, attendance, or K3 files touched.
4. All added keys have real call-sites; no dead keys.
5. Implementation stops before push for review.
