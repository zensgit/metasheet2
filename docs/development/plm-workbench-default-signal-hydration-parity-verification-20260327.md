# PLM Workbench Default Signal Hydration Parity Verification

## 变更范围

- `packages/core-backend/src/routes/plm-workbench.ts`
- `packages/core-backend/tests/unit/plm-workbench-routes.test.ts`

## 回归点

### 1. 默认 team view 改名后仍保留 lastDefaultSetAt

`plm-workbench-routes.test.ts` 的 `renames a team view for the owner` 现在锁定：

- 默认 view 重命名成功后
- 返回体仍带 `isDefault: true`
- 同时保留 `lastDefaultSetAt`

这保证 default scene / recent-default 排序不会因为 rename 立刻掉信号。

### 2. 默认 team preset 改名后仍保留 lastDefaultSetAt

`plm-workbench-routes.test.ts` 的 `renames a team preset for the owner` 现在锁定：

- 默认 preset 重命名成功后
- 返回体仍带 `isDefault: true`
- 同时保留 `lastDefaultSetAt`

这保证 BOM / Where-Used 的 recent-default 语义不会在 rename 后瞬间丢失。

### 3. batch preset archive 返回项保留 lastDefaultSetAt

`plm-workbench-routes.test.ts` 的 `batch archives manageable team presets and reports skipped ids` 现在锁定：

- 默认 preset 被 batch archive 后
- 返回项虽然 `isDefault: false`
- 但仍保留历史 `lastDefaultSetAt`

这保证 batch lifecycle 和 list/default/save 返回合同一致。

## 执行记录

### Backend Focused

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend
pnpm exec vitest run tests/unit/plm-workbench-routes.test.ts
```

结果：

- `1` 个文件 / `36` 个测试通过

### Backend Build

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend
pnpm build
```

结果：

- 通过
