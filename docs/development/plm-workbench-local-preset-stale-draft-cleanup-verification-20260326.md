# PLM Workbench Local Preset Stale Draft Cleanup Verification

## Scope

验证本地 `BOM / Where-Used` preset route owner 失效时：

- 旧 owner 自己的 `name/group` 草稿会被清掉
- 已存在的 pending selector 草稿会被保留

## Focused Verification

命令：

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmLocalFilterPresetRouteIdentity.spec.ts
```

结果：

- `1` 个文件
- `4` 个测试通过

覆盖点：

- 匹配时保留 `route owner + selector + drafts`
- stale owner 且 selector 仍指向旧 owner 时，清空 `route owner + selector + drafts`
- stale owner 但用户已有不同 pending selector 时，只清 route owner，保留 drafts
- same-key import update 且 `preserveSelectedPresetKeyOnClear = true` 时，保留 selector 和 drafts

## Type-check

命令：

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

结果：

- 通过

## Full Verification

命令：

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

预期：

- local preset stale cleanup 的 draft 语义不会回归其它 collaborative / preset / view 流程
