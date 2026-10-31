# 目录集成错误态与企业名称：验证记录（2026-10-29）

## 结论

代码修复和 Mac mini 隔离验证通过；交付为 Draft PR，线上问题尚未解除。staging 仍需另行批准受控重加密及上线，不可把历史默认材料设回生产配置。

## 代码范围与设计

基线 main：`a03d804d60d83717feaedce099e5ff14216afc58`。分支：`codex/directory-list-org-display-20261029`。

- 区分列表加载、失败、成功为空、成功有数据；失败可只读重试，无效响应也不再显示空列表。
- 增加可选 `config.corpName` 展示元数据。分别标注企业名称、Corp ID、本地组织；未知名称不从其他字段猜测。
- 企业名称由管理员维护，不是钉钉 API 实时核验结果。省略保留、空字符串清除、非法类型或超长输入拒绝。
- 无数据库迁移，无新开关；不改密钥检查、同步、登录应用或账号关联。

设计锁：[directory-integration-list-organization-design-lock-20261029.md](./directory-integration-list-organization-design-lock-20261029.md)。

## 加密材料只读追查与离线复验

已检查 61 份限定范围的 staging 配置和历史备份，未发现配置自定义 ENCRYPTION_KEY 或 ENCRYPTION_SALT 的文件。此结论不代表穷尽所有外部密钥保管位置。必要的密文和候选材料只复制到 Mac mini 私有目录，未复制到 Git。

| 检查 | 结果 |
| --- | --- |
| 集成数量 / 加密字段数量 | 3 / 4 |
| 历史内置默认材料解密 | 4 成功、0 失败 |
| 错误密钥负例 | 4/4 拒绝 |
| 损坏认证标签负例 | 4/4 拒绝 |
| 默认材料通过生产安全检查 | 否，符合现有 fail-closed 规则 |
| 隔离输入复验前后 | 未改变 |
| 61 份来源文件哈希复核 | 全部相同 |
| 在线数据库密文复核 | 未改变 |

离线过程调用当前分支的实际 `deriveEncryptionKeyFromMaterial` / `decryptSecretPayloadWithKey`，没有另写一套解密算法，也未启动线上服务或执行网络推送。结果说明现有密文使用历史公开默认材料；这不是找回了一组安全的历史密钥。不得以降低生产检查或设置默认材料作为修复。

计数证据：[离线结果](../../artifacts/directory-list-org-display/crypto-rehearsal-results.json)、[只读复核](../../artifacts/directory-list-org-display/post-readonly-check.json)。原始配置、密文、解密结果不进入 PR；明文未输出或持久化。

## 验证

环境：Mac mini 独立工作目录，Node 20.20.2，pnpm 10.16.1；Node 归档与官方 SHASUMS256 校验一致。目录元数据读写用合成 SQL mock，未对 staging 数据库做写入，也不将这些测试声称为真实数据库升级演练。

| 门槛 | 结果 |
| --- | --- |
| Vue 全文件回归 | 90/90 通过 |
| 后端 5 个定向文件 | 273/273 通过 |
| 前后端 TypeScript | 通过 |
| `pnpm validate:all` | 通过；插件校验有 9 项既有警告 |
| 变异检查 | 错误态守卫、名称长度守卫分别被削弱后均失败 |
| 恢复后复验 | Vue 90/90、名称单元测试 11/11 通过，源文件字节恢复 |
| 合成真实浏览器页面 | 错误、名称已知、名称未知、成功为空四态通过 |
| 前端 CI 接入 | 复用既有 spec，已在 attendance-web-guard 及 run-required-web-tests 两处登记 |
| `git diff --check` | 通过 |

```sh
pnpm --filter @metasheet/web exec vitest run --watch=false tests/directoryManagementView.spec.ts
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/directory-sync-corp-name.test.ts tests/unit/directory-sync-work-notification-agent-id.test.ts tests/unit/directory-tenant-change-guard.test.ts tests/unit/encryption-material-fail-closed.test.ts tests/unit/admin-directory-5xx-values-free.test.ts --reporter=dot
pnpm validate:all
```

回归包括 500、网络失败、无效响应、加载中、只读重试、已知／未知名称、显式保存／清除、旧调用省略字段、非法类型／超长输入、既有 Agent ID 边界、Corp ID 不可变和生产加密检查。

## 合成页面截图

仅使用合成数据；未把真实组织、账户、密文或凭据放入截图。

- [失败态](../../artifacts/directory-list-org-display/directory-error.png)
- [企业名称已知](../../artifacts/directory-list-org-display/directory-known.png)
- [企业名称未知](../../artifacts/directory-list-org-display/directory-unknown.png)
- [成功空列表](../../artifacts/directory-list-org-display/directory-empty.png)

## 待批准的线上修复

1. 清点 staging 全部受同一材料影响的加密存储及消费路径，固定待处理记录集合和配置／密文备份。当前只核验目录集成 4 个字段，不能据此声称全库轮换覆盖完成。
2. 另行批准后，生成专用强材料并先在隔离副本演练受控重加密、解密一致性和配置回滚；不得覆盖生产材料，也不得通过普通“已加密即跳过”的写入路径冒充重加密。
3. 提交一次性线上变更清单和维护窗口，批准后才执行；验收目录列表、账号及企业关联不变、生产保护仍有效。
4. 当前 Draft 代码的合并、发布和部署另批。即使合并这份 UI 修复，也不会自动解除 staging 的加密配置阻断。

CI 说明：本报告记录本地隔离验证，不宣称当前 head 的 13 项必需 CI 全绿；Draft PR 自动触发的结果需另行检查，不自动重跑整轮 CI。

## Source fingerprints

| File | SHA256 |
| --- | --- |
| `apps/web/src/views/DirectoryManagementView.vue` | `6590d075c5ecb5e42d2f07c5b00f02b1ab9da84c03b426f9ce5257ec3321342d` |
| `apps/web/tests/directoryManagementView.spec.ts` | `1e69e4151cbf194bf3533fed5a8a32fae011e1d5d5b7f7f184effd6265871bb9` |
| `packages/core-backend/src/directory/directory-sync.ts` | `d7ee01a3a44966738df26142da25a720efb19ee9c58bb4d381cf90acdc932a4d` |
| `packages/core-backend/tests/unit/directory-sync-corp-name.test.ts` | `50550e104e350b95aff7438227fb7b859aa720a40f1ad9cf71a5d48936b8a4c7` |
