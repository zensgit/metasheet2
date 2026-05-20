# T3C-2a - Permission Managers i18n Design

- **Date**: 2026-05-20
- **Type**: implementation-ready design packet
- **Status**: design only; no code implementation in this slice
- **Base inspected**: `origin/main@27d82f99b`
- **Goal**: localize the multitable permission manager chrome for record permissions and sheet permissions without changing permission semantics, API payloads, ACL persistence values, or accessibility structure.

## 1. Decision Summary

| Finding / Decision | Resolution |
|---|---|
| T3C-2a scope | Only `MetaRecordPermissionManager.vue` and `MetaSheetPermissionManager.vue`, plus their label helpers and tests. |
| PR split | Keep T3C-2a separate from T3C-2b form-share and T3C-2c API-token. Do not touch `MetaFormShareManager.vue` or `MetaApiTokenManager.vue` in this PR. |
| Label module shape | Create `apps/web/src/multitable/utils/meta-permission-labels.ts` for permission-specific copy. Extend `meta-manager-labels.ts` only for genuinely shared manager actions. |
| Common-vs-specific boundary | `Save`, `Remove`, `Clear`, `Apply`, `Copy ACL`, and similar reusable action chrome may live in `meta-manager-labels.ts`. Permission-domain nouns, tabs, empty states, access levels, subject badges, ACL-template messages, and permission statuses belong in `meta-permission-labels.ts`. |
| No helper redeclare | Do not redeclare cross-module helpers. T3C-1 almost duplicated `fieldTypeLabel`; this slice must grep for existing label helpers before adding new ones. |
| `fieldTypeLabel` anti-pattern | `meta-core-labels.ts` remains the single source for field-type labels; `boolean` must stay `checkbox` / `复选框`. Permission code must not introduce another field type table. |
| Raw data | Permission codes, subject ids, user/member-group/role names, field/view names, persisted enum values, backend error text, timestamps, and ACL scope strings stay raw. |
| Existing specs | Earlier scout said 0 specs, but current `origin/main` has behavior specs: `multitable-record-permission-manager.spec.ts` and `multitable-sheet-permission-manager.spec.ts`. i18n assertions are still greenfield and must be added explicitly. |
| Spec strategy | Add i18n-focused cases to the existing permission manager specs, or create adjacent `*-i18n.spec.ts` files if the existing files become too large. Either way, use the real component props and existing client shape. |
| A11y boundary | This PR localizes existing text/placeholder chrome only. Current inspected files have `placeholder=2`, `aria-label=0`, `title=0`; do not add new a11y structure or new aria/title attributes here. |

## 2. Files In Scope

| File | Role |
|---|---|
| `apps/web/src/multitable/components/MetaRecordPermissionManager.vue` | Record-level permission modal. Current static chrome includes header, current access, grant section, access-level labels, subject badges, loading/empty states, status/error fallbacks, and one search placeholder. |
| `apps/web/src/multitable/components/MetaSheetPermissionManager.vue` | Sheet-level permission modal with sheet / field / view tabs. Current static chrome includes access grants, candidates, field/view ACL templates, orphan cleanup, downstream copy flows, status/error fallbacks, and one search placeholder. |
| `apps/web/src/multitable/utils/meta-permission-labels.ts` | New permission-domain label module for T3C-2a. |
| `apps/web/src/multitable/utils/meta-manager-labels.ts` | Existing manager chrome module. Extend only when an action is reusable beyond permission managers. |
| `apps/web/tests/multitable-record-permission-manager.spec.ts` | Existing behavior spec. Add record permission i18n regression cases or keep it unchanged and add an adjacent i18n spec. |
| `apps/web/tests/multitable-sheet-permission-manager.spec.ts` | Existing behavior spec. Add sheet/field/view permission i18n regression cases or keep it unchanged and add an adjacent i18n spec. |
| `docs/development/multitable-t3c2a-permission-managers-i18n-design-20260520.md` | This design packet. |
| `docs/development/multitable-t3c2a-permission-managers-i18n-verification-20260520.md` | Verification packet after implementation. |

Out of scope:

- `MetaFormShareManager.vue` and form-share labels.
- `MetaApiTokenManager.vue` and API-token labels.
- Permission backend routes, ACL persistence, migrations, OpenAPI, or API contracts.
- Adding new aria/title coverage where none exists today.
- Rewording user, role, group, field, view, permission-code, or backend-error data.

## 3. Scout Anchors

| Anchor | Current evidence |
|---|---|
| Record component size | `MetaRecordPermissionManager.vue`: 707 lines. |
| Sheet component size | `MetaSheetPermissionManager.vue`: 1750 lines. |
| Placeholder count | 2 total: record search placeholder at line 90, sheet search placeholder at line 147. |
| Existing aria/title | `aria-label=0`, `title=0` in the two component files. |
| Button/action chrome | Earlier scout catalog counted 34 button/action text labels; static `<button>` nodes on current `origin/main` are 25 because the sheet tab/candidate templates collapse runtime multiplicity. Implementation must localize the action copy catalog, not just count literal `<button>` tags. |
| Existing behavior specs | `apps/web/tests/multitable-record-permission-manager.spec.ts` and `apps/web/tests/multitable-sheet-permission-manager.spec.ts` exist on current `origin/main`. They do not provide zh-CN i18n coverage. |
| Real record props | `visible`, `sheetId`, `recordId`, `client`; emits `close` and `updated`. |
| Real sheet props | `visible`, `sheetId`, `client`, `fields`, `views`, `fieldPermissionEntries`, `viewPermissionEntries`; emits `close`, `updated`, `update-field-permission`, `update-view-permission`. |

## 4. Raw Preserve List

Do not translate or normalize these values:

| Value class | Examples / source |
|---|---|
| User-authored identity labels | `entry.label`, `entry.subtitle`, candidate labels, user names, member-group names, role names. |
| Stable subject ids | `user_alice`, `role_ops`, UUID member-group ids, fallback `subjectId`. |
| Permission and ACL persisted values | `read`, `write`, `write-own`, `admin`, `default`, `hidden`, `readonly`, `none`, `visible`, `readOnly`, `{ remove: true }`. Display labels localize; values stay raw. |
| Permission codes / scopes | `spreadsheet:read`, `spreadsheet.read`, `spreadsheet.admin`, `view.records`, `record.delete`, etc. |
| Field and view names | `field.name`, `view.name`, field ids, view ids. |
| Field/view raw type ids | `field.type`, `view.type` currently render as badges. Do not introduce a local field-type table in this slice; if future UX wants humanized field types here, it must call existing `fieldTypeLabel`. |
| Backend/API error text | `cause?.message` stays raw. Only component-owned fallback strings are localized. |
| Runtime counts and timestamps | Numeric counts interpolate into localized templates; raw timestamps/version strings stay as data. |

## 5. Label Module Boundary

### 5.1 New permission module

Create:

```text
apps/web/src/multitable/utils/meta-permission-labels.ts
```

Expected exports:

```ts
export type MetaPermissionLabelKey = ...
export function permissionLabel(key: MetaPermissionLabelKey, isZh: boolean): string
export function permissionCountLabel(kind: 'fieldOverride' | 'viewOverride' | 'orphanFieldOverride' | 'orphanViewOverride', count: number, isZh: boolean): string
export function fieldStatusClearedOrphans(count: number, isZh: boolean): string
export function viewStatusClearedOrphans(count: number, isZh: boolean): string
```

The orphan-status helpers must preserve the existing English singular/plural fork, not render a parenthesized suffix literally:

```ts
export function fieldStatusClearedOrphans(count: number, isZh: boolean): string {
  if (isZh) return `已清除 ${count} 个孤立字段覆盖`
  return `Cleared ${count} orphan field override${count === 1 ? '' : 's'}`
}

export function viewStatusClearedOrphans(count: number, isZh: boolean): string {
  if (isZh) return `已清除 ${count} 个孤立视图覆盖`
  return `Cleared ${count} orphan view override${count === 1 ? '' : 's'}`
}
```

Permission-specific labels should live here:

- record/sheet titles and subtitles
- tab labels
- section labels
- loading/empty states
- subject badges (`Person`/`User`, `Member group`, `Role`)
- access labels (`Read`, `Write`, `Write own`, `Admin`, `None`)
- field/view ACL state labels (`Default`, `Hidden`, `Read-only`)
- permission status/fallback error messages
- ACL copy/status templates
- orphan override labels

### 5.2 Existing manager module

`meta-manager-labels.ts` already owns field/view manager chrome and shared manager actions. Extend it only for action chrome that is broadly reusable:

| Candidate | Module |
|---|---|
| `action.save` | `meta-manager-labels.ts` if absent. |
| `action.remove` | `meta-manager-labels.ts` if absent. |
| `action.clear` | `meta-manager-labels.ts` if absent. |
| `action.apply` | `meta-manager-labels.ts` if absent. |
| `action.copyAcl` | Prefer `meta-permission-labels.ts` unless another manager already uses ACL copy semantics. |
| `permission.sheet.title`, `permission.record.title` | `meta-permission-labels.ts`. |
| `permission.access.read`, `permission.access.writeOwn` | `meta-permission-labels.ts`. |

### 5.3 No redeclare self-check

Before implementation, run:

```bash
rg -n "fieldTypeLabel|accessLevelLabel|subjectType.*Label|const .*LABELS|function .*Label" apps/web/src/multitable
```

Rules:

- Do not duplicate `fieldTypeLabel`; import from `meta-core-labels.ts` if field-type display is ever needed.
- Do not create separate record-permission and sheet-permission label modules. T3C-2a owns both in one `meta-permission-labels.ts`.
- If a helper naturally crosses permission managers and other manager panels, place it in `meta-manager-labels.ts`; otherwise keep it permission-specific.

## 6. Copy Plan

### 6.1 Record Permission Manager

| Existing EN | Proposed key | ZH |
|---|---|---|
| `Record Permissions` | `record.title` | 记录权限 |
| `Manage who can access this record and at what level.` | `record.subtitle` | 管理谁可以访问此记录以及访问级别。 |
| `Current access` | `record.currentAccess` | 当前访问权限 |
| `Loading permissions...` | `record.loadingPermissions` | 正在加载权限... |
| `No record-specific permissions yet.` | `record.empty` | 暂无记录专属权限。 |
| `Grant to people, member groups, or roles` | `record.grantSection` | 授权给人员、成员组或角色 |
| `Search people, member groups, or roles` | `record.searchPlaceholder` | 搜索人员、成员组或角色 |
| `Loading eligible people, member groups, and roles...` | `record.loadingCandidates` | 正在加载可授权的人员、成员组和角色... |
| `No matching eligible people, member groups, or roles.` | `record.noCandidates` | 没有匹配的可授权人员、成员组或角色。 |
| `No matching people.` | `record.noPeople` | 没有匹配的人员。 |
| `No matching member groups.` | `record.noMemberGroups` | 没有匹配的成员组。 |
| `No matching roles.` | `record.noRoles` | 没有匹配的角色。 |
| `Inactive user` | `subject.inactiveUser` | 已停用用户 |
| `Cleanup only` | `subject.cleanupOnly` | 仅可清理 |
| `Grant blocked` | `subject.grantBlocked` | 授权已阻止 |
| `User` | `subject.user` | 用户 |
| `Member group` | `subject.memberGroup` | 成员组 |
| `Role` | `subject.role` | 角色 |
| `Read` | `access.read` | 读取 |
| `Write` | `access.write` | 写入 |
| `Admin` | `access.admin` | 管理员 |
| `Permission updated` | `record.status.updated` | 权限已更新 |
| `Permission removed` | `record.status.removed` | 权限已移除 |
| `Permission granted` | `record.status.granted` | 权限已授予 |
| `Failed to load record permissions` | `record.error.loadPermissions` | 加载记录权限失败 |
| `Failed to load permission candidates` | `record.error.loadCandidates` | 加载权限候选项失败 |
| `Failed to update permission` | `record.error.update` | 更新权限失败 |
| `Failed to remove permission` | `record.error.remove` | 移除权限失败 |
| `Failed to grant permission` | `record.error.grant` | 授予权限失败 |

### 6.2 Sheet Permission Manager

| Existing EN | Proposed key | ZH |
|---|---|---|
| `Manage Access` | `sheet.title` | 管理访问权限 |
| `Override sheet-level access for eligible people, member groups, or roles. Admin includes sharing and sheet deletion. Write-own remains user-only.` | `sheet.subtitle` | 为可授权人员、成员组或角色覆盖表级访问权限。管理员包含分享和删除表权限；仅写入自己仍只适用于用户。 |
| `Sheet Access` | `sheet.tab.sheet` | 表访问权限 |
| `Field Permissions` | `sheet.tab.fields` | 字段权限 |
| `View Permissions` | `sheet.tab.views` | 视图权限 |
| `Current access` | `sheet.currentAccess` | 当前访问权限 |
| `Loading access list...` | `sheet.loadingAccess` | 正在加载访问列表... |
| `No sheet-specific access grants yet.` | `sheet.emptyAccess` | 暂无表专属访问授权。 |
| `Clear overrides` | `sheet.clearOverrides` | 清除覆盖 |
| `Copy downstream ACL...` | `sheet.copyDownstreamPlaceholder` | 复制下游 ACL... |
| `Copy field+view ACL` | `sheet.copyFieldViewAcl` | 复制字段+视图 ACL |
| `Eligible people, member groups, or roles` | `sheet.eligibleSection` | 可授权人员、成员组或角色 |
| `Search people or roles` | `sheet.searchPlaceholder` | 搜索人员或角色 |
| `Searching eligible people, member groups, and roles...` | `sheet.searchingCandidates` | 正在搜索可授权人员、成员组和角色... |
| `No matching eligible people, member groups, or roles.` | `sheet.noCandidates` | 没有匹配的可授权人员、成员组或角色。 |
| `People` | `subject.people` | 人员 |
| `Person` | `subject.person` | 人员 |
| `Member groups` | `subject.memberGroups` | 成员组 |
| `Roles` | `subject.roles` | 角色 |
| `Write own` | `access.writeOwn` | 仅写入自己 |
| `Sheet access override updated` | `sheet.status.updated` | 表访问覆盖已更新 |
| `Sheet access override removed` | `sheet.status.removed` | 表访问覆盖已移除 |
| `Sheet access override saved` | `sheet.status.saved` | 表访问覆盖已保存 |
| `Failed to load sheet access` | `sheet.error.loadAccess` | 加载表访问权限失败 |
| `Failed to update sheet access` | `sheet.error.updateAccess` | 更新表访问权限失败 |
| `Failed to clear subject overrides` | `sheet.error.clearSubjectOverrides` | 清除对象覆盖失败 |

### 6.3 Field and View Permission Tabs

| Existing EN | Proposed key | ZH |
|---|---|---|
| `Field-level permissions` | `field.title` | 字段级权限 |
| `No fields available.` | `field.noFields` | 暂无可用字段。 |
| `No subjects with sheet access. Grant sheet access first to configure field permissions.` | `field.noSubjects` | 暂无拥有表访问权限的对象。请先授予表访问权限，再配置字段权限。 |
| `Bulk apply to all fields` | `field.bulkApply` | 批量应用到所有字段 |
| `Default` | `field.state.default` | 默认 |
| `Hidden` | `field.state.hidden` | 隐藏 |
| `Read-only` | `field.state.readonly` | 只读 |
| `Apply to all fields` | `field.applyAll` | 应用到所有字段 |
| `Copy from member group...` | `permission.copyFromMemberGroup` | 从成员组复制... |
| `Copy ACL` | `permission.copyAcl` | 复制 ACL |
| `Clear orphan overrides` | `permission.clearOrphanOverrides` | 清除孤立覆盖 |
| `No current sheet access` | `permission.noCurrentSheetAccess` | 当前无表访问权限 |
| `Orphan ${subject}` | `permission.orphanSubject(subjectLabel)` | 孤立的 {subjectLabel} |
| `Field permission updated` | `field.status.updated` | 字段权限已更新 |
| `Field permission cleared` | `field.status.cleared` | 字段权限已清除 |
| `Cleared 1 orphan field override` / `Cleared {n} orphan field overrides` | `field.status.clearedOrphans(n)` | 已清除 {n} 个孤立字段覆盖 |
| `Applied field permission to {n} fields` | `field.status.applied(n)` | 已将字段权限应用到 {n} 个字段 |
| `Cleared field permission overrides on {n} fields` | `field.status.clearedAll(n)` | 已清除 {n} 个字段上的权限覆盖 |
| `Copied field ACL template from source member group` | `field.status.copiedTemplate` | 已从源成员组复制字段 ACL 模板 |
| `Field ACL template already matches source member group` | `field.status.copyTemplateNoop` | 字段 ACL 模板已与源成员组一致 |
| `View-level permissions` | `view.title` | 视图级权限 |
| `No views available.` | `view.noViews` | 暂无可用视图。 |
| `No subjects with sheet access. Grant sheet access first to configure view permissions.` | `view.noSubjects` | 暂无拥有表访问权限的对象。请先授予表访问权限，再配置视图权限。 |
| `Bulk apply to all views` | `view.bulkApply` | 批量应用到所有视图 |
| `None` | `view.state.none` | 无 |
| `Apply to all views` | `view.applyAll` | 应用到所有视图 |
| `View permission updated` | `view.status.updated` | 视图权限已更新 |
| `View permission cleared` | `view.status.cleared` | 视图权限已清除 |
| `Cleared 1 orphan view override` / `Cleared {n} orphan view overrides` | `view.status.clearedOrphans(n)` | 已清除 {n} 个孤立视图覆盖 |
| `Applied view permission to {n} views` | `view.status.applied(n)` | 已将视图权限应用到 {n} 个视图 |
| `Copied view ACL template from source member group` | `view.status.copiedTemplate` | 已从源成员组复制视图 ACL 模板 |
| `View ACL template already matches source member group` | `view.status.copyTemplateNoop` | 视图 ACL 模板已与源成员组一致 |
| `Copied downstream field and view ACL from source member group` | `sheet.status.copiedDownstreamAcl` | 已从源成员组复制下游字段和视图 ACL |
| `Downstream field and view ACL already matches source member group` | `sheet.status.copyDownstreamNoop` | 下游字段和视图 ACL 已与源成员组一致 |

## 7. Component Wiring Plan

Both components should import:

```ts
import { useLocale } from '../../composables/useLocale'
import { permissionLabel, ... } from '../utils/meta-permission-labels'
```

Use:

```ts
const { isZh } = useLocale()
const p = (key: MetaPermissionLabelKey) => permissionLabel(key, isZh.value)
```

Implementation notes:

- Keep raw select option `value` attributes unchanged.
- Replace display labels only.
- For `ACCESS_LEVEL_OPTIONS`, replace `label: 'Read'` style objects with computed label helpers, or keep raw values in constants and derive labels at render time.
- For `fieldPermDraftLabel()` and `viewPermDisplayLabel()`, return localized display labels while preserving the raw `data-access-level` values. The current CSS uses display strings `Hidden` / `Read-only` in `data-access-level`; implementation should change these data attributes to raw state values (`hidden`, `readonly`, `default`) before localizing visible text, or leave them raw if already present. Do not put localized Chinese into styling selectors.
- `subjectOverrideSummaryLabel()` and orphan-count messages need helper functions because English has singular/plural while zh does not.
- `cause?.message ?? fallback` should become `cause?.message ?? p('...')`. Do not wrap `cause?.message`.
- `field.type` and `view.type` badges remain raw in this slice.

## 8. Spec Plan

### 8.1 Existing behavior specs

Current `origin/main` has:

- `apps/web/tests/multitable-record-permission-manager.spec.ts`
- `apps/web/tests/multitable-sheet-permission-manager.spec.ts`

Keep the existing behavior assertions. Add i18n coverage without weakening the behavior tests.

### 8.2 Required i18n matrix

| Case | Required assertions |
|---|---|
| Record EN baseline | `useLocale().setLocale('en')`; original English chrome still renders: `Record Permissions`, `Current access`, `Grant`, `Remove`, `Search people, member groups, or roles`. |
| Record zh chrome | `useLocale().setLocale('zh-CN')`; title, current access, empty/loading, subject badges, access labels, grant/remove/save actions, placeholder, status/fallback errors render in zh. |
| Record raw preserve | In zh-CN, user names, emails, role names, member-group ids/names, and `subjectId` fallback remain unchanged. |
| Sheet EN baseline | English default stays stable across sheet / field / view tabs: `Manage Access`, `Sheet Access`, `Field Permissions`, `View Permissions`, `Apply`, `Copy ACL`, `Clear orphan overrides`. |
| Sheet zh chrome | Sheet tab, candidate section, field tab, view tab, ACL copy, orphan cleanup, and status/fallback errors render in zh. |
| Sheet raw preserve | In zh-CN, field names, view names, raw `field.type`, raw `view.type`, permission codes/scopes, subject labels, ids, and backend error text remain unchanged. |
| Data attribute safety | Select values and `data-*` keys remain raw (`read`, `write-own`, `hidden`, `readonly`, `none`, subject ids). Styling selectors must not depend on localized visible text. |
| Helper unit coverage | `meta-permission-labels.spec.ts` covers all static keys, count helpers for `n=1` and `n=2`, and unknown/raw fallback behavior where applicable. |

### 8.3 Fixture discipline

- Use real component props from the current components; do not invent props.
- Use existing `createApp + container + app?.unmount() + useLocale().setLocale('en')` pattern from nearby i18n specs.
- Reuse or extend existing permission manager mock clients so calls still assert the real API shape.
- Do not add production-only data attrs just for i18n tests. Existing `data-record-permission-*`, `data-sheet-permission-*`, `data-field-permission-*`, and `data-view-permission-*` selectors are enough.

## 9. A11y Boundary

Current inspected permission managers have:

- `placeholder=2`
- `aria-label=0`
- `title=0`

This PR localizes the two existing placeholders. It must not add new aria-label/title coverage, new focus behavior, or structural accessibility changes. The close buttons currently render `×` / `&times;` without aria labels; that is an a11y follow-up slice, not T3C-2a.

Verification MD should explicitly state:

```text
A11y note: no new aria/title structure was introduced. Existing placeholder chrome was localized; close-button aria is deferred to a dedicated a11y slice.
```

## 10. Implementation Checklist

1. Rebase branch onto latest `origin/main` before writing code.
2. Add/extend label modules:
   - new `meta-permission-labels.ts`
   - only necessary shared action keys in `meta-manager-labels.ts`
3. Wire `useLocale()` into both permission manager components.
4. Replace visible chrome and fallback strings; preserve raw values and raw error messages.
5. Add label helper unit tests.
6. Add i18n render assertions for record and sheet managers.
7. Run helper redeclare grep and record it in verification.
8. Run targeted tests and type-check.
9. Write verification MD.
10. Rebase again before push; if PR goes behind during CI, use `git push --force-with-lease`, never plain `--force`.

## 11. Verification Commands

Minimum local matrix:

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/meta-permission-labels.spec.ts \
  tests/multitable-record-permission-manager.spec.ts \
  tests/multitable-sheet-permission-manager.spec.ts

pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web build
git diff --check
```

If the implementation chooses adjacent i18n spec files instead of extending existing specs, replace the test paths with the actual file names and keep the existing behavior specs in the same run.

## 12. Reviewer Checklist

- The PR does not touch form-share, API-token, automation, backend routes, migrations, or a11y structure.
- `meta-permission-labels.ts` owns permission-domain copy.
- Shared action labels are not duplicated across modules.
- No new `fieldTypeLabel` or field-type label map exists outside `meta-core-labels.ts`.
- Existing behavior specs still pass.
- i18n specs cover EN regression, zh-CN chrome, and raw data preservation.
- Select values, API call arguments, `data-*` identifiers, and persisted enum values remain raw.
- Verification MD records the current origin/main base, helper-redeclare grep, exact test commands, and a11y deferral.
