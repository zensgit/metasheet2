# 生产环境加密材料 fail-closed 设计（W5-B, 2026-09-14）

## 1. 威胁

落库凭据（数据源连接口令、钉钉 appSecret / 机器人 webhook secret、system_configs 中标记
`is_encrypted` 的值等）走 AES-256-GCM，密钥由 `pbkdf2(ENCRYPTION_KEY, ENCRYPTION_SALT, 100000, 32,
sha256)` 派生。改动前两处派生点都带公开的内置回退：

- `packages/core-backend/src/security/encrypted-secrets.ts`：盐回退 `default-salt-…`、主密钥回退
  `default-key-…`；
- `packages/core-backend/src/services/ConfigService.ts` 的 `SecretManager`：同样两个回退值。

两个回退值就写在本仓库里。生产若没配 `ENCRYPTION_KEY`/`ENCRYPTION_SALT`，所有落库凭据都用一把
**任何拿到仓库的人都能复现的密钥**加密——密文等同明文，且没有任何信号告诉运维这件事发生了：后端源码里
**没有**任何启动期校验（已 grep 确认，见 §5）。

对照：`JWT_SECRET` 早就是 fail-closed 的
（`src/security/auth-runtime-config.ts:46` `resolveRuntimeJwtSecret()` 在生产直接抛）。加密材料是同一
类"秘密来自环境变量、缺了就悄悄降级"的问题，此前漏了。

## 2. 改法

在 `src/security/encrypted-secrets.ts` 抽出唯一的解析口子，两条管线共用：

```
resolveEncryptionMaterial(env = process.env): { masterKey, salt }
getEncryptionMaterialIssues(env)   // values-free 的问题清单
assertProductionEncryptionMaterial(env)  // 只在生产抛，可供未来启动期调用
deriveEncryptionKey(env)           // pbkdf2，参数与改动前逐字不变
class EncryptionMaterialError extends Error   // 带 issues[]，不带任何值
```

行为：

| NODE_ENV | ENCRYPTION_KEY / ENCRYPTION_SALT | 结果 |
| --- | --- | --- |
| `production` | 任一缺失（含空串/纯空白） | 抛 `EncryptionMaterialError` |
| `production` | 任一等于内置默认值 | 抛 `EncryptionMaterialError` |
| `production` | 都已配置 | 正常派生；key < 32 字符只 warn 一次，不拦 |
| 非 `production` | 缺失或默认值 | **行为与改动前逐字一致**（继续用内置默认值），进程内 warn 一次 |
| 非 `production` | 已配置 | 正常派生，不 warn |

错误消息形如
`Invalid encryption material for production: ENCRYPTION_KEY not configured / not set; ENCRYPTION_SALT uses the built-in default placeholder value`
——只出现变量名和"未配置 / 为默认值"，**不回显任何值**（含不回显默认哨兵值本身）。warn 走
`core/logger` 的 `Logger`（不是 `console`），值放在 values-free 的 `issues` 元数据里。

两处接线：

- `encrypted-secrets.ts` 的 `encryptStoredSecretValue` / `decryptStoredSecretValue` /
  `normalizeStoredSecretValue` 都经 `deriveEncryptionKey()` → 读写两侧同时受门。
- `ConfigService.SecretManager.getKey()` 改为调用同一个 `resolveEncryptionMaterial()`；原本在
  **构造函数**里缓存的 `keyDerivationSalt` 字段随之删除（见 §3）。`encrypt()/decrypt()` 的
  `catch` 里加了一行 `if (error instanceof EncryptionMaterialError) throw error`：配置错是运维可行动
  的失败，不该被压成通用的 `Failed to encrypt value`（原消息本身也不含值，只是丢诊断）。

### 两个刻意的不对称，别"顺手改掉"

1. **校验看 trim 后的值，派生用原始值。** `getEncryptionMaterialIssues()` 用 trim 后的字符串判断
   "缺失/默认值"，但 `resolveEncryptionMaterial()` 返回的是 `env.ENCRYPTION_KEY || DEFAULT`（原始值）。
   如果把 trim 后的值拿去 pbkdf2，任何密钥带首尾空白的现网部署派生出的密钥都会变，**已落库的密文全部
   解不开**。测试里有一条专门钉死这个（`does not trim the value used for derivation`）。
2. **长度不在代码侧强制。** 生产短密钥只 warn 一次，不抛。理由见 §6。

## 3. 与 rotateKey 的兼容

`ConfigService.SecretManager.rotateKey(oldKey, newKey)`（`ConfigService.ts` 内）靠**临时改
`process.env.ENCRYPTION_KEY`** 在新旧密钥之间来回切：解密一行用 old、加密一行用 new，出错回滚成
`originalKey`。这要求密钥材料**每次调用都重新读 env、一个字节都不缓存**。

因此：

- `resolveEncryptionMaterial()` 只缓存"是否已 warn 过"两个布尔量，**不缓存密钥/盐**；
- `SecretManager` 原来在构造函数里把盐冻进 `this.keyDerivationSalt`，现已删除该字段，盐与密钥都在
  `getKey()` 里现读。对 rotateKey 是严格更正确（此前换盐要重建实例，现在不用），对现有调用方无差别
  （`ConfigService` 在方法内 `new SecretManager()`，不存在长寿命实例）；
- 也因此**不能**把 `resolveEncryptionMaterial()` 改成 memoized：那会在 rotateKey 的第一行之后把所有行
  都按同一把密钥处理，静默写坏整张 `system_configs`。

验证里有两条用例钉这件事：一条只验机制（同一实例跨 env 切换的加解密语义），一条用 mock 的 `db` 真的跑
`rotateKey()` 并断言重加密后的行能被新密钥解开、`process.env.ENCRYPTION_KEY` 停在 newKey。

## 4. 为什么非生产不拒

`packages/core-backend/tests/setup.ts:22` 把 `NODE_ENV` 置为 `test`，而相当多既有 spec（
`dingtalk-destination-secret-encryption`、`dingtalk-work-notification-settings`、`automation-v1`、
`encrypt-dingtalk-*` 等）直接依赖内置默认密钥完成加解密往返。在非生产也 fail-closed 会把这些套件整片
染红，且逼每个开发者本地配 env 才能跑单测——收益为零（本地库里没有真凭据），代价很大。

所以非生产维持原样，只加一条**每进程一次**的告警：既提醒"这些密文不是机密"，又不会在每加密一个字段时
刷屏。CI 的 e2e smoke 用 `E2E_INTEGRATION_ENCRYPTION_KEY` 显式给密钥，不受影响。

"一次"是契约的一部分：变异掉 warn 闩锁会让用例红（见验证文档 M2）。

## 5. 与 validate-windows-runtime.ps1 的口径关系

`scripts/ops/validate-windows-runtime.ps1:142-168` 早就把 `default-key-change-in-production` /
`default-salt-change-in-production` 列进 `$weakSecrets`，并对 `ENCRYPTION_KEY` 要求 ≥32 字符。本次改动
**不是新增要求**，是把运维验证器已经在喊的口径落到代码里，两侧共用同一组哨兵值（代码侧现在把它们导出为
`DEFAULT_ENCRYPTION_KEY` / `DEFAULT_ENCRYPTION_SALT`，脚本侧仍是字面量数组，注释已互指）。

差异，写清楚免得以后打架：

| 检查 | ps1 | 代码 |
| --- | --- | --- |
| 未设置 | WARN（env 可能挂在服务上而不在当前 shell） | 生产抛 |
| 等于默认哨兵 | WARN | 生产抛 |
| KEY < 32 字符 | WARN | 只 warn（不抛） |
| SALT 长度 | 不检查 | 不检查 |

ps1 之所以只 WARN 不 FAIL，是因为它是 session-scoped 的、看不见 nssm 服务自己的环境；进程内的代码看得
见真实运行环境，所以它可以也应该更硬。**本次没有改 ps1。**

## 6. 部署前置（重要，会改变现网行为）

1. **生产必须设置 `ENCRYPTION_KEY` 与 `ENCRYPTION_SALT`**，且都不能是内置默认值。否则进程在**首次凭据
   加密或解密**时抛错失败——这是有意的，不是回归。
2. **如果某套生产环境此前一直在用内置默认密钥**（即 env 里没配），那里已有的 `enc:` 密文是用默认密钥加
   的。直接补上新的 `ENCRYPTION_KEY` 会让这些旧密文解不开（authTag 校验失败）。迁移路径二选一：
   - 先把 `ENCRYPTION_KEY`/`ENCRYPTION_SALT` 设成**内置默认值本身**跑一次
     `SecretManager.rotateKey(默认值, 新密钥)`，再切到新值；或
   - 用 `packages/core-backend/scripts/encrypt-dingtalk-*-secrets.ts` 那套流程重新落密文。

   这两条都需要停机窗口和 owner 决策，**不在本次改动范围内**。上线前必须先确认目标环境到底有没有配过
   `ENCRYPTION_KEY`。
3. 长度建议 ≥32 字符随机值；代码不强制，`validate-windows-runtime.ps1` 会 WARN。

## 7. 没做 / 留给后续

- **没有接启动期断言。** 按要求先 grep 了 `JWT_SECRET` 在 core-backend 的既有校验点：只有
  `AuthService` 构造函数里的懒校验（`src/auth/AuthService.ts:153`）和两个配置模块
  （`src/config.ts:69`、`src/config/index.ts:65`）里的 `resolveRuntimeJwtSecret()` 调用。而
  `src/config/index.ts` 全仓只有 `src/telemetry/index.ts` 在用，`src/config.ts` 在 `src/` 里没有任何
  导入方——**core-backend 没有集中的启动期 env 校验点**。`src/index.ts` 2400+ 行且有多支 PR 在动，按
  边界不去碰。因此本次只做惰性检查：失败发生在首个凭据操作，而不是进程启动。
  `assertProductionEncryptionMaterial()` 已导出，将来谁建了集中校验点，接一行即可。
- **长度不在代码侧强制**：避免打断已有的"短但非默认"密钥的部署（那种情况密文仍然是真机密，只是强度不
  够），留给运维验证器 WARN。
- 没有改 `validate-windows-runtime.ps1`，没有碰 `plugins/`、stock-prep、multitable 编辑器。
- 没有为"密钥轮转"加任何新的 API/路由；`rotateKey` 仍然只能从代码内调用。
