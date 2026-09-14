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

---

# 复核返修验证（PR #5711 第一轮，同日）

设计侧的说明见设计文档末尾的「复核返修」节。新增/改动的文件：
`packages/core-backend/src/security/encrypted-secrets.ts`、
`packages/core-backend/src/services/ConfigService.ts`、
`plugins/plugin-attendance/index.cjs`、
`packages/core-backend/tests/unit/encryption-material-fail-closed.test.ts`、
`packages/core-backend/tests/unit/attendance-integration-secret-material-gate.test.ts`。

## R1. 用例数

| spec | 返修前 | 返修后 |
| --- | --- | --- |
| `tests/unit/encryption-material-fail-closed.test.ts` | 17 passed | **22 passed** |
| `tests/unit/attendance-integration-secret-material-gate.test.ts`（新，F2） | — | **8 passed** |

新增 5 条（F1）：生产下允许轮换读并 values-free warn 一次；旁路不上写路径（同一进程同一 env 下写仍抛）；
生产 default→strong 全量轮换成功（默认 key+盐 → 强 key+盐，读用旁路、写不用，结束后无旁路也能解开）；
生产 strong→default **key** 被拒且 env 回滚；生产 strong→default **salt** 被拒且 env 回滚。
新增 8 条（F2）：生产未配置 / 默认 key / 默认盐三种拒绝、错误 values-free、写路径
（`encryptIntegrationSecretValue`）同样被拦、生产配齐后往返、非生产默认材料派生**字节等同**
`pbkdf2(默认key, 默认盐, 100000, 32, sha256)`、派生不 trim。

## R2. 变异（全部离仓；TS 走 `--config` 别名，CJS 走 `require.cache` 内存注入）

| # | 变异 | 结果 |
| --- | --- | --- |
| M1 | `isProductionRuntime()` 恒 false（F4 后该函数在 `auth-runtime-config.ts`） | **14 failed / 8 passed (22)** |
| M2 | 去掉 warn-once 闩锁 | **1 failed / 21 passed** |
| M3 | 去掉"默认盐在生产也拒绝" | **2 failed / 20 passed** |
| M4 | 去掉 `ConfigService` 里 `EncryptionMaterialError` 原样重抛 | **4 failed / 18 passed** |
| **M5（F1）** | **去掉 `allowDefaultsForRotationRead` 旁路** | **2 failed / 20 passed** —— 正是
  `allows a rotation READ on default material…` 与
  `rotates OFF the built-in defaults in production…` 这两条 |
| **M6（F2）** | **去掉 plugin-attendance 的生产门** | **5 failed / 3 passed (8)** —— 三条仍绿的是
  往返 / 不漂移 / 不 trim 这批反回归项 |
| 还原 | 不加任何别名与注入 | **22 passed + 8 passed** |

M6 的做法值得记一笔：spec 用的是 Node 的 `require()`，vite 的 `resolve.alias` **管不到**它（第一次尝试
别名，8 条全绿＝变异根本没生效）。改成在 `setupFiles` 里用 `Module._compile(mutatedSource, 真实filename)`
把变异模块塞进 `require.cache`，相对 `require` 照常解析，磁盘上不落任何变异文件。

## R3. 相邻 suite / 类型检查（返修后重跑）

- 13 个套件（原 12 个 + 新的 attendance gate）：**Test Files 13 passed / Tests 439 passed**。
- 另抽 3 个会 `require` `plugin-attendance/index.cjs` 的既有考勤套件 + 新 spec：
  **4 passed / 66 tests passed**（确认插件仍能正常加载、导出的测试缝没破坏既有导出）。
- `npx tsc --noEmit -p tsconfig.json`：exit 0。
- 临时 config（include 两个新 spec）：exit 0，跑完即删，未入库。
- `tests/unit/runtime-dependency-classification.test.ts` 仍是 §4 里那条 Windows 路径分隔符的确定性红，
  与本轮改动无关（本轮新增的 import 边同样都是相对路径）。

## R4. 本轮未做 / 仍未验证

- plugin-attendance 侧**没有**非生产告警（该处没有可用 logger）；两个 TS 管线的告警不变。
- `rotateKey` 只覆盖 `system_configs`；钉钉 / 数据源 / 考勤集成的密文各在各自的表，迁移脚本不在本 PR。
- 仍未在 222 上实看生产 env；上线前置未解除。
- "第四条管线"已按两个特征全仓 grep 过：`default-key-change-in-production` /
  `default-salt-change-in-production` 现在只剩三处生产代码（本 helper、plugin-attendance、ps1 的哨兵
  列表）+ 两个新 spec；`process.env.ENCRYPTION_KEY || …` 形态的回退除本 helper 外只出现在测试里。
  但这只覆盖了"同名 env + 同一批默认串"的实现，**换了变量名或换了默认串的自带加密仍可能存在，未排查**。
