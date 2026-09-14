# 生产环境加密材料 fail-closed 验证记录（W5-B, 2026-09-14）

设计见 `docs/development/encryption-key-fail-closed-design-20260914.md`。

- 分支 `fix/encryption-key-fail-closed-production`，基线 `origin/main` = `c13e40769`
- 新增 spec：`packages/core-backend/tests/unit/encryption-material-fail-closed.test.ts`（17 条）
- 运行环境：Windows / Node 20 / vitest 1.6.1 / pnpm 9.15.9，`pnpm install --frozen-lockfile`

所有探针都是**离仓**的：变异体与 pristine 副本写在会话 scratchpad 下，通过 `vitest --config` 的
`resolve.alias` 注入，worktree 内没有落过任何变异文件。

## 1. 先红后绿

| 阶段 | 结果 |
| --- | --- |
| 改动前（改 src 之前实跑） | **12 failed / 5 passed（17）** |
| 改动前（用 `git show origin/main:` 的 pristine 副本 alias 回放，逐条复现） | **12 failed / 5 passed（17）** |
| 改动后 | **17 passed（17）** |

改动前就绿的 5 条，正是"不许回归"的那批（它们在改动后仍绿，说明没有行为漂移）：

- `does not drift the derived key: a pre-change default ciphertext still decrypts`
  （硬编码的 golden 密文由改动前的实现在默认密钥/默认盐下产出）
- `does not warn when non-production material is explicitly configured`
- `ConfigService … still round-trips outside production on defaults`
- `ConfigService … re-reads ENCRYPTION_KEY per call so rotateKey can swap old/new`
- `ConfigService … rotateKey re-encrypts stored rows from the old key to the new key`（mock 掉 `db`，
  真跑 `rotateKey()`，断言重加密后的行能被 newKey 解开且 `process.env.ENCRYPTION_KEY` 停在 newKey）

改动前红、改动后绿的 12 条覆盖：生产缺 key / 默认 key / 默认 salt / 缺 salt 抛；错误消息 values-free；
生产配齐后可往返；生产缺 key 时写路径（`encryptStoredSecretValue`、`normalizeStoredSecretValue`）和读路径
（`decryptStoredSecretValue`）都抛；非生产默认值下 warn 恰好一次；派生不 trim；ConfigService 两条同口径。

## 2. 变异（每条守卫都有"去掉它就红"的证据）

| # | 变异 | 结果 |
| --- | --- | --- |
| M1 | `isProductionRuntime()` 恒 `return false`（任务指定的那条） | **9 failed / 8 passed** |
| M2 | 去掉 warn-once 闩锁（`if (issues.length > 0 && !insecureMaterialWarned)` → `if (issues.length > 0)`） | **1 failed / 16 passed** |
| M3 | 去掉"默认盐在生产也拒绝"这一分支 | **1 failed / 16 passed** |
| M4 | 去掉 `ConfigService.encrypt/decrypt` 里 `if (error instanceof EncryptionMaterialError) throw error` 两行 | **2 failed / 15 passed** |
| 还原 | 不用 alias、跑真实源码 | **17 passed** |

M1 的 9 条红里同时包含 `ConfigService SecretManager shares the gate` 那组——证明 ConfigService 确实**接
在**同一个 helper 上，而不是各自复制了一份判断。M4 红的那两条证明"配置错不被压成通用
`Failed to encrypt value`"是被断言钉住的，不是顺手写的。

## 3. 相邻 suite

一次跑齐（都依赖默认密钥或加解密往返）：

```
tests/unit/encryption-material-fail-closed.test.ts
tests/unit/dingtalk-destination-secret-encryption.test.ts
tests/unit/dingtalk-work-notification-settings.test.ts
tests/unit/dingtalk-approval-card-config.test.ts
tests/unit/dingtalk-group-destination-service.test.ts
tests/unit/automation-v1.test.ts
tests/unit/encrypt-dingtalk-destination-secrets.test.ts
tests/unit/encrypt-dingtalk-integration-secrets.test.ts
tests/unit/directory-sync-work-notification-agent-id.test.ts
tests/unit/stock-preparation-handoff-notifier.test.ts
tests/unit/auth-runtime-config.test.ts
tests/unit/federation.contract.test.ts
```

→ **Test Files 12 passed (12) / Tests 426 passed (426)**。

（automation-v1 的输出里有 `error: Automation execution log persistence failed` 之类的行，那是它自己的
负路径用例在断言降级行为，不是失败。）

## 4. 本机红但判定为与本改动无关

`tests/unit/runtime-dependency-classification.test.ts`：**2 failed / 7 passed**，连跑两次同样红（确定性
红，不是 flake）。

根因是 Windows 路径分隔符，不是本改动：

- 该守卫用 `path.relative(CORE_BACKEND, file)` 生成站点键（`walkStartupGraph()`，测试文件 271 行），
  Windows 上得到 `src\core\logger.ts`；
- 而 `OPTIONAL_SOFT_DEPENDENCIES` 白名单里写的是正斜杠 `src/core/logger.ts`（65-76 行）；
- 失败输出里**同时**列出了 `@opentelemetry/api (eager import at src\core\logger.ts)` 和
  `js-yaml (eager import at src\services\ConfigService.ts)`——这两条恰好就是白名单里仅有的两项，说明
  occurrence 本身存在、只是键匹配不上。

本改动新增的两条 import 边都是**相对**路径（`encrypted-secrets.ts` → `../core/logger`，
`ConfigService.ts` → `../security/encrypted-secrets`），不产生任何新的外部模块 occurrence；
`src/core/logger.ts` 与 `src/services/ConfigService.ts` 在改动前就已在启动图内
（后者经 `src/di/container.ts:3` eager import）。CI（Linux）为裁判。

## 5. 类型检查

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json`（包内 src，tsconfig 排除了 test） | exit 0 |
| `npx tsc --noEmit -p tsconfig.w5b-tmp.json`（临时 config，只 include 新 spec 及其传递依赖） | exit 0 |

临时 `tsconfig.w5b-tmp.json` 跑完即删，**未入库**（`git status` 已确认）。

注：第一版临时 config 把基线的 `exclude`（`**/*.test.ts`、`**/__tests__/**`）覆盖掉了，于是 `src/**/*`
把 `src/**/__tests__/**` 里一批**既有**的类型错误（view-service / attendance-w4c3a / cache 等，共 ~140
条）也拉了进来——与本改动无关，收窄 include 后为 0。

## 6. 未做 / 未验证

- **没有真实生产环境验证。** 没有在 222 上确认 `ENCRYPTION_KEY` / `ENCRYPTION_SALT` 是否已配置。若某套
  生产环境此前用的是内置默认密钥，上线本改动前必须先按设计文档 §6 走迁移，否则已有 `enc:` 密文会解不
  开。**这是上线前的 owner 前置。**
- 没有接启动期断言（core-backend 没有集中的启动 env 校验点；见设计文档 §7）。
- 没跑集成 / db 套件（需要 PG），没跑 e2e。
- 没有改 `scripts/ops/validate-windows-runtime.ps1`。
- 密钥长度不在代码侧强制，只 warn 一次，没有为此写用例之外的强度校验。
