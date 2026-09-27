> **历史快照 —— 2026-05-22 写就,2026-09-26 补入仓库。** 本文是多维表 i18n 收口审计当日的原始记录,以下正文逐字保留,未作修改。
>
> - 文中列为「待修 / 下一切片」的事项此后都已收口:composable 与导入辅助的回退由 #1768 完成;Yjs「Not authenticated」由 #1803(设计)与 #1805(代码)完成。**本文不是当前待办清单。**
> - 本文 §7 的结论是当日状态「未闭环」(Not closed)。`multitable-yjs-auth-i18n-closure-design-20260523.md` 第 10 行把本文引作「§7 已宣告闭环」,与原文不符;以本文原文为准。
> - 原文 §2 写「17 label/helper modules」,紧随其后的清单实际列出 18 个,为原文笔误,未改。
> - 补入原因:main 上有 4 处文档按路径引用本文,此前该文件只存在于一个未推送的本地提交(`a62933db5`),引用悬空。

# Multitable Final I18n Closure Audit (2026-05-22)

## 1. Baseline

Branch: `docs/multitable-final-i18n-closure-audit-20260522`

Base:

```text
35eab8580 fix(attendance): flag truncated advanced scheduling workbench snapshots (#1762)
```

Scope:

- `apps/web/src/multitable/**`
- source files only (`*.vue`, `*.ts`)
- frontend multitable i18n/chrome residuals

Out of scope:

- backend contracts / migrations / attendance / K3
- tests as user-facing chrome
- raw user data, technical IDs, protocol tokens, examples, and formula tokens

## 2. Commands

`rg` is unavailable in this shell, so the audit used `find` and `grep`.

```bash
find apps/web/src/multitable -type f \( -name '*.vue' -o -name '*.ts' \) | wc -l
find apps/web/src/multitable/utils -maxdepth 1 -name '*labels.ts' -print | sort

grep -R -n -E ">[[:space:]]*[A-Z][A-Za-z0-9 ,.'’:/()&+_-]*[[:space:]]*<" \
  apps/web/src/multitable --include='*.vue'

grep -R -n -E "(placeholder|aria-label|title)=\"[^\"]*[A-Za-z][^\"]*\"" \
  apps/web/src/multitable --include='*.vue'

grep -R -n -E "validateAttachmentSelection|formatLinkActionLabel|Choose linked records|Mentions|Unread|Timeline view|Gantt view|Hierarchy view|Loading\\.\\.\\.|No records|Create first record|Select a date field|Formula|Unexpected closing|People field only allows|This field only allows|Validation failed|Insufficient permissions|Please sign in|Please check" \
  apps/web/src/multitable --include='*.ts' --include='*.vue'

grep -R -n -E "error\\.value = .*'|error\\.value = .*\"|rowFailure = .*\\`|new Error\\('Import cancelled'|Choose linked records" \
  apps/web/src/multitable/composables apps/web/src/multitable/import apps/web/src/multitable/components/cells/MetaCellEditor.vue \
  --include='*.ts' --include='*.vue'
```

Scout size:

```text
106 multitable source files
17 label/helper modules
```

Label/helper modules now present:

```text
category-labels.ts
meta-api-error-labels.ts
meta-api-token-labels.ts
meta-attachment-labels.ts
meta-automation-labels.ts
meta-base-picker-labels.ts
meta-bulk-edit-labels.ts
meta-comment-labels.ts
meta-core-labels.ts
meta-form-share-labels.ts
meta-formula-labels.ts
meta-import-labels.ts
meta-link-picker-labels.ts
meta-manager-labels.ts
meta-permission-labels.ts
meta-record-labels.ts
meta-view-render-labels.ts
workbench-labels.ts
```

## 3. Planned A-D Findings Status

| Original audit slice | Status | Evidence |
| --- | --- | --- |
| Slice A: small residuals | Closed | Mention popover uses `meta-comment-labels`; `formatLinkActionLabel` caller passes `isZh.value`; attachment/people/display helpers accept locale. |
| Slice B: visual views | Closed | Visual view chrome is routed through `meta-view-render-labels.ts` plus existing shared helpers. |
| Slice C: formula docs/diagnostics | Closed | Formula category/function descriptions and diagnostics are localized through `meta-formula-labels.ts`; formula tokens stay raw. |
| Slice D: API fallback errors | Closed | `api/client.ts` has no inline English fallback string matches; fallbacks live in `meta-api-error-labels.ts`. |

Specific planned checks:

```text
origin/main:apps/web/src/multitable/components/cells/MetaCellEditor.vue:429:  return formatLinkActionLabel(props.field, count, isZh.value)
origin/main:apps/web/src/multitable/components/cells/MetaCellEditor.vue:487:  const validationError = validateAttachmentSelection(props.field, files, attachmentIds.value.length, isZh.value)
```

`api/client.ts` post-Slice-D fallback grep:

```bash
grep -R -n "Validation failed\|Insufficient permissions\|Please sign in to continue\|Please check the submitted data and try again" apps/web/src/multitable/api/client.ts
```

Output: no matches.

## 4. Raw / Accepted Findings

These grep hits are intentionally not localized.

| Finding | Classification |
| --- | --- |
| `POST` / `PUT` / `GET` options in `MetaAutomationRuleEditor.vue` | HTTP method protocol values. |
| Keyboard labels such as `Enter`, `Escape`, `Tab`, `Ctrl+C`, `Ctrl+V` | Physical key names. |
| `https://example.com`, `name@example.com`, `https://...`, `ops@example.com` placeholders | Format examples / user input examples. |
| `fld_target`, `image/png,application/pdf`, `kg, hours, pcs...`, `INV-` placeholders | Technical field IDs, MIME examples, units, prefixes. |
| `record.opsDestinationId`, `record.escalationDestinationIds` placeholders | Template/path syntax. |
| Formula function names, examples, insert text, `{fld_xxx}` tokens | Formula language surface stays raw. |
| Field names, view names, record titles, option values, chart labels | User-authored data. |
| `MetaCellEditor.vue` non-link fallback `Choose linked records...` | Defensive unreachable branch; preserving EN avoids adding a dead key. |
| `useYjsDocument.ts` `INVALIDATED: document invalidated by REST write` | Technical Yjs diagnostic. |

## 5. New Residual Finding

The closure audit found one residual cluster not covered by the original
final-audit A-D plan: defensive fallback strings in composables/import helpers.

These are mostly `e.message ?? 'fallback'` branches, non-`Error` catch fallbacks,
or import resolver absence paths. They are less visible than template chrome,
but they can still surface through error banners/toasts. A strict-zero i18n
standard should fix them in a follow-up slice.

### 5.1 Composable Error Fallbacks

| File | Lines / strings |
| --- | --- |
| `useMultitableWorkbench.ts` | `Failed to load sheets`; `Failed to load sheet metadata`; `Failed to load base metadata` |
| `useMultitableGrid.ts` | `Failed to load view data`; `Record editing is not allowed for this row.`; `Record deletion is not allowed for this row.`; `sheetId or viewId is required`; `Failed to create record`; `Failed to delete record`; `Failed to patch cell`; `The latest record version is not available on this page anymore.` |
| `useMultitableComments.ts` | `Failed to load comments`; `Failed to add comment`; `Failed to resolve comment`; `Failed to update comment`; `Failed to delete comment` |
| `useMultitableCommentInbox.ts` | `Failed to load comment inbox`; `Failed to load unread comment count`; `Failed to mark comment as read` |
| `useMultitableCommentInboxSummary.ts` | `Failed to load mention summary` |
| `useMultitableCommentPresence.ts` | `Failed to load comment presence` |
| `useMultitableRecordPermissions.ts` | `Failed to load record permissions`; `Failed to grant record permission`; `Failed to revoke record permission` |

Raw grep excerpt:

```text
apps/web/src/multitable/composables/useMultitableWorkbench.ts:162:      error.value = e.message ?? 'Failed to load sheets'
apps/web/src/multitable/composables/useMultitableGrid.ts:595:    error.value = 'Record editing is not allowed for this row.'
apps/web/src/multitable/composables/useMultitableComments.ts:24:      error.value = e.message ?? 'Failed to load comments'
apps/web/src/multitable/composables/useMultitableCommentInbox.ts:25:      error.value = e.message ?? 'Failed to load comment inbox'
apps/web/src/multitable/composables/useMultitableRecordPermissions.ts:17:      error.value = e.message ?? 'Failed to load record permissions'
```

### 5.2 Import Helper Fallbacks

| File | Lines / strings |
| --- | --- |
| `import/delimited.ts` | `No import resolver is configured for people field ...`; `No import resolver is configured for linked field ...`; `Unable to resolve people value for ...`; `Unable to resolve linked value for ...` |
| `import/bulk-import.ts` | `Import cancelled` AbortError message |

Raw excerpt:

```text
apps/web/src/multitable/import/delimited.ts:161:            ? `No import resolver is configured for people field ${field.name}`
apps/web/src/multitable/import/delimited.ts:162:            : `No import resolver is configured for linked field ${field.name}`
apps/web/src/multitable/import/delimited.ts:171:            ? `Unable to resolve people value for ${field.name}: ${rawValue}`
apps/web/src/multitable/import/delimited.ts:172:            : `Unable to resolve linked value for ${field.name}: ${rawValue}`)
apps/web/src/multitable/import/bulk-import.ts:41:  const error = new Error('Import cancelled') as Error & { name: string }
```

### 5.3 Yjs Diagnostic Boundary

`useYjsDocument.ts` still has:

```text
Not authenticated
INVALIDATED: document invalidated by REST write
```

`INVALIDATED: ...` is clearly technical. `Not authenticated` could be localized
if the Yjs error surface is polished later, but it belongs with a Yjs connection
UX slice rather than the multitable chrome follow-up.

## 6. Recommendation

Do not declare a strict-zero final closure yet if the target includes defensive
fallback branches.

Recommended next slice:

```text
final-audit-composable-fallbacks
```

Scope:

- `useMultitableWorkbench.ts`
- `useMultitableGrid.ts`
- `useMultitableComments.ts`
- `useMultitableCommentInbox.ts`
- `useMultitableCommentInboxSummary.ts`
- `useMultitableCommentPresence.ts`
- `useMultitableRecordPermissions.ts`
- `import/delimited.ts`
- `import/bulk-import.ts`

Likely implementation strategy:

- Add small label/helper modules only where an existing domain module is a clear
  owner (`workbench-labels.ts`, `meta-core-labels.ts`, `meta-comment-labels.ts`,
  `meta-permission-labels.ts`, `meta-import-labels.ts`).
- Prefer optional `isZh = false` parameters for pure utilities.
- For composables, follow the T3D-3 precedent: call `useLocale()` once in the
  composable body if the composable is already Vue-bound, and use event-time
  fallback strings.
- Preserve `e.message` raw precedence.

Risk:

- This is not template chrome. It touches behavior-path error fallbacks, so it
  needs focused composable/unit tests rather than broad render specs.

## 7. Closure Verdict

| Category | Verdict |
| --- | --- |
| Original A-D final audit plan | Closed on `origin/main`. |
| Visible Vue template chrome | No new true-positive hardcoded English found. |
| Label module coverage | 17 modules, current surfaces have clear owners. |
| Raw-data / technical literals | Classified and accepted. |
| Strict-zero defensive fallbacks | Not closed; new `final-audit-composable-fallbacks` slice recommended. |

Operational conclusion:

- If the bar is "planned T3 + final audit A-D complete": complete.
- If the bar is "no user-visible English fallback anywhere under
  `apps/web/src/multitable/**`": one final composable/import fallback slice
  remains.
