# Multitable Import Modal Result/Repair Port

## Context

`multitable-next` 之前只保留了一个简化版 `MetaImportModal`:

- 只支持 `paste -> preview -> importing`
- `@import` 只发 `records[]`
- workbench 只会直接 bulk import
- 没有 result screen
- 没有失败行重试
- 没有 inline repair
- 没有 picker-assisted repair
- 没有 import draft reconcile

旧多维 worktree 在这条链上更完整，但也只覆盖到了 `person` link repair，没有把普通 `link` 字段纳入 import resolver / picker repair。

## Design

### 1. Restore the rich import contract

把 import pipeline 恢复为旧线的 richer contract：

- `buildImportedRecords(...) -> ImportBuildResult`
- `MetaImportModal` emits `import(payload: ImportBuildResult)`
- `MultitableWorkbench` 合并：
  - modal preflight failures
  - backend bulk import failures

这样 UI 才能真正区分：

- preflight data-resolution failure
- backend create-record failure
- retryable transient failure
- manual-fix-only failure

### 2. Restore modal result / repair flow

`MetaImportModal` 恢复为四步状态机：

- `paste`
- `preview`
- `importing`
- `result`

并恢复这些能力：

- failed row preview
- retry only failed subset
- inline failed-cell editing
- picker-assisted repair
- blocked close while importing
- draft reconcile after upstream field drift

### 3. Exceed the old worktree: support generic link repair

旧线只对 `person` field 启用 resolver + picker repair。  
这轮把 generic `link` 也接进来了：

- `delimited.ts` 现在对 `link` 字段走 resolver path
- `MultitableWorkbench.vue` 为所有 `link` 字段构造 `importFieldResolvers`
- `MetaImportModal.vue` 对所有 `link` 字段开放 picker repair

策略：

- `person` link 仍走专门的 people resolver
- generic `link` 走 `listLinkOptions(fieldId, search=token)` 的 exact-match resolver
- unresolved / ambiguous generic links 会进入 result screen，允许 picker repair

这让 clean mainline 在 import repair 上已经超过旧参考代码。

### 4. Reuse link-label utilities consistently

把 link/person 相关文案统一收进 `link-fields.ts`，并回灌到：

- `MetaLinkPicker`
- `MetaFormView`
- `MetaRecordDrawer`
- `MetaCellEditor`

避免 import modal、form、drawer、cell editor 的 link 文案继续分叉。

## Files

Core implementation:

- `apps/web/src/multitable/components/MetaImportModal.vue`
- `apps/web/src/multitable/components/MetaLinkPicker.vue`
- `apps/web/src/multitable/views/MultitableWorkbench.vue`
- `apps/web/src/multitable/import/delimited.ts`
- `apps/web/src/multitable/import/bulk-import.ts`
- `apps/web/src/multitable/utils/link-fields.ts`
- `apps/web/src/multitable/utils/people-import.ts`

UI label alignment:

- `apps/web/src/multitable/components/MetaFormView.vue`
- `apps/web/src/multitable/components/MetaRecordDrawer.vue`
- `apps/web/src/multitable/components/cells/MetaCellEditor.vue`

Tests:

- `apps/web/tests/multitable-import.spec.ts`
- `apps/web/tests/multitable-import-modal.spec.ts`
- `apps/web/tests/multitable-people-import.spec.ts`
- `apps/web/tests/multitable-link-picker.spec.ts`
- `apps/web/tests/multitable-workbench-view.spec.ts`
- `apps/web/tests/multitable-field-manager.spec.ts`

## Verification

Ran:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-import.spec.ts \
  tests/multitable-import-modal.spec.ts \
  tests/multitable-people-import.spec.ts \
  tests/multitable-link-picker.spec.ts \
  tests/multitable-workbench-view.spec.ts \
  tests/multitable-field-manager.spec.ts \
  --reporter=dot
pnpm --filter @metasheet/web build
```

Results:

- `tsc --noEmit`: passed
- focused Vitest: `6 files / 39 tests passed`
- `@metasheet/web build`: passed

## Notes

- 这轮没有跑更高层真实 smoke，因为本地 API/Web/DB 运行环境仍不是稳定常驻。
- Claude Code 已按要求调用做 reviewer；如果它没有在短等待窗口内返回稳定文本，最终验收仍以本地 `tsc + vitest + build` 为准。
