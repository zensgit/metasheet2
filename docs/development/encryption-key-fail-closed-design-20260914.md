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

## 5. 与 validate-windows-runtime.ps1 的口径关系（F3 订正）

`scripts/ops/validate-windows-runtime.ps1:142-168` 把 `default-key-change-in-production` /
`default-salt-change-in-production` 列进了 `$weakSecrets`，两侧用同一组哨兵值（代码侧导出为
`DEFAULT_ENCRYPTION_KEY` / `DEFAULT_ENCRYPTION_SALT`，脚本侧是字面量数组，注释互指）。

但**不能说"验证器已经拒绝这两个值"**，初稿这么写是错的：

- 这些站点一律 `Add-Check … 'WARN' …`，而脚本末尾 `:324` 是
  `if ($failed.Count -gt 0) { exit 1 } else { exit 0 }`——只有 **FAIL** 行进 `$failed`。默认哨兵值
  只会让它打一行黄字，**退出码仍是 0**。
- `:164` 的 `<32` 长度检查**显式排除 ENCRYPTION_SALT**，提示语写的还是 JWT_SECRET。

| 检查 | ps1 | 代码 |
| --- | --- | --- |
| 未设置 | WARN（exit 0） | 生产抛 |
| 等于默认哨兵 | WARN（exit 0） | 生产抛 |
| KEY < 32 字符 | WARN（exit 0） | 只 warn（不抛） |
| SALT 长度 | 不检查 | 不检查 |

结论：**"过了验证器"不等于"材料安全"**，本模块是唯一会真正拒绝的地方。ps1 只 WARN 有其道理（它是
session-scoped 的，看不见 nssm 服务自己的 `AppEnvironmentExtra`，把缺失判成 FAIL 会误杀配置正确的主机）
——但正因为如此，它不能当作安全结论的依据。**本次没有改 ps1。**

## 6. 部署前置（重要，会改变现网行为）

1. **生产必须设置 `ENCRYPTION_KEY` 与 `ENCRYPTION_SALT`**，且都不能是内置默认值。否则进程在**首次凭据
   加密或解密**时抛错失败——这是有意的，不是回归。
2. **上线前必须人工确认**目标环境的这两个变量已设为非默认值。不能拿
   `validate-windows-runtime.ps1` 的退出码当依据：它对默认哨兵值只 WARN、仍然 exit 0（见 §5）。
   去服务环境里实看（`nssm get <ServiceName> AppEnvironmentExtra`），不要只看当前 shell。
3. **如果某套生产环境此前一直在用内置默认密钥**（即 env 里没配），那里已有的 `enc:` 密文是用默认密钥加
   的。直接补上新的 `ENCRYPTION_KEY` 会让这些旧密文解不开（authTag 校验失败）。迁移路径二选一：
   - 在仍未设置 env 的进程里调
     `SecretManager.rotateKey(DEFAULT_ENCRYPTION_KEY, 新密钥, { newSalt: 新盐 })`，它会用默认材料读、用
     新材料写；跑完再把新值写进服务环境（见 §3 的 F1 说明）；或
   - 用 `packages/core-backend/scripts/encrypt-dingtalk-*-secrets.ts` 那套流程重新落密文。

   注意 `rotateKey` 只覆盖 `system_configs` 表。钉钉 / 数据源 / 考勤集成的密文在各自的表里，需要各自的
   重加密流程。这些都需要停机窗口和 owner 决策，**不在本次改动范围内**。
4. 长度建议 ≥32 字符随机值；代码不强制，`validate-windows-runtime.ps1` 只会 WARN。

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
- 没有改 `validate-windows-runtime.ps1`，没有碰 stock-prep、multitable 编辑器。
- 没有为"密钥轮转"加任何新的 API/路由；`rotateKey` 仍然只能从代码内调用。

---

# 复核返修（PR #5711 第一轮，同日）

## F1 — rotateKey 死锁（blocker）

初版的门把 `rotateKey()` 自己锁死了：迁移的第一步是 `process.env.ENCRYPTION_KEY = oldKey` 再
`decrypt()`，而唯一需要迁移的场景里 `oldKey` **就是内置默认值**，于是读这一步先被门拦住，`catch` 又原样
重抛——"先以默认值为 oldKey 跑 rotateKey"在初版下根本做不到。

修法（`encrypted-secrets.ts` + `ConfigService.ts`）：

- `resolveEncryptionMaterial()` / `deriveEncryptionKey()` 增加**显式**选项
  `{ allowDefaultsForRotationRead: true }`。只在生产且确实存在"缺失/默认值"问题时生效，返回原始的默认材
  料并**每进程 values-free warn 一次**；
- 只有 `rotateKey()` 里"用旧密钥解密这一行"传这个选项。`encrypt()` 上**没有**这个参数，
  `encryptStoredSecretValue()` / `decryptStoredSecretValue()` 也不转发——写入口的严格度一点没放宽；
- 这个旁路**不可配置**：它是代码层的实参，不是 env / 请求头 / 请求体，外部无法触发。

附带（只有在同一处才说得通）：`rotateKey(oldKey, newKey, { newSalt? })` 增加可选的 `newSalt`。
`rotateKey` 原本只换 key 不换盐，而真正需要迁移的那套环境**盐也是默认值**——读要用旧盐、写必须落到非默
认盐，否则写这一步照样被门拒绝、迁移仍然完不成。不传 `newSalt` 时行为与改动前逐字一致；`rotateKey` 此前
在 `src/` 里没有任何调用方，加可选参数不影响既有调用。

同时修掉一个既有小坑：失败回滚路径上的 `process.env.ENCRYPTION_KEY = originalKey` 在 `originalKey` 为
`undefined` 时会写进字符串 `"undefined"`——那对新的门来说像"已配置的非默认密钥"，会静默用错密钥。改为
`restoreEnvValue()`，未设置就 `delete`。

spec 里"轮换后 `process.env.ENCRYPTION_KEY` 停在新 key"那条断言保留，但加了注释：那是 `rotateKey()`
**原有**的收尾行为（进程切到新密钥），不是本 PR 新立的契约。

## F2 — 第三条管线：plugin-attendance（blocker）

`plugins/plugin-attendance/index.cjs` 自带一份 `getIntegrationSecretKey()`：同样的 `enc:` 前缀、同样的
aes-256-gcm、同样的 pbkdf2 参数、同样两个默认值回退，并且真的用它把钉钉 `appSecret` 加密写库
（`normalizeIntegrationConfigForStorage`）、解密读出（`normalizeIntegrationConfig`）——完全绕过前面那个
helper。

修法：CJS 无法 import TS helper，按 `plugins/plugin-integration-core/lib/credential-store.cjs:63-71` 的
既有先例**就地最小实现**同一个生产门——同样的两个哨兵、同样 values-free 的错误、同样"校验看 trim、派生
用原始值"的不对称，注释指回 `encrypted-secrets.ts` 要求同步。非生产行为不变；该插件此处没有可用的
logger，**没有**加告警（两个 TS 管线的告警仍在）。

`plugins/plugin-attendance/index.cjs` 不在 `.gitattributes` 的 pin 段里，也不在
`s6a-package-provenance-pins.json` 里——**不需要重打 pin**。

## F3 — 见 §5、§6（已就地改写）

## F4 — 去重

`isProductionRuntime()` 改为从 `src/security/auth-runtime-config.ts` 复用（该模块零 import，不会成环）。
`normalizeEnvString()` 在那边是模块私有、没导出，所以这边保留一份并加注释要求同步。

顺带写明一点两处一致的口径：`NODE_ENV` 只有恰好等于 `'production'` 才算生产，`'prod'` 不算——这与既有的
JWT_SECRET 门用的是同一个判定函数，两个秘密不可能对"现在是不是生产"产生分歧。

变异探针 M1 的目标也随之移到 `auth-runtime-config.ts`。

---

# 复核返修（PR #5711 第二轮，同日）

## R1 — 空表轮换零校验（medium）

`rotateKey()` 里唯一校验目标材料的地方是 `encrypt()`，而 `encrypt()` 在**每行**循环里调用。
`system_configs` 没有 `is_encrypted=true` 的行时循环体一次都不执行，于是
`rotateKey(强密钥, 内置默认值)` 会"成功"返回，并在收尾处把 `process.env.ENCRYPTION_KEY` 设成默认哨兵
——进程被悄悄切到一把公开密钥上。

修法：在**取行之前**（比循环还早，也就比任何 env 改动都早）用
`assertProductionEncryptionMaterial()` 对 `(newKey, newSalt ?? 当前盐)` 做一次生产口径校验。它与行数无关，
失败时 env 一个字节都还没改过，所以"抛了但 env 半旋转"不可能发生。非生产仍是 no-op（与本模块其它地方
口径一致）。

## R2 — 插件门不 trim（medium-low）

插件侧写的是严格 `process.env.NODE_ENV === 'production'`，而 TS 侧
（`auth-runtime-config.ts` 的 `isProductionRuntime`）先 trim。于是 `NODE_ENV=" production "` 这种由
env 文件/服务配置带进空格的情况下，core-backend 已经 fail-close，插件却仍然用内置默认密钥把 appSecret
写进库——同一台机器上两条管线对"现在是不是生产"给出相反答案。

修法：插件侧改用它自己已有的 `normalizeTextValue()`（等价于 `String(x ?? '').trim()`）再比较，注释指回
同口径来源。两侧各加一条 `" production "` 的用例。

## R3 — 出厂模板缺加密材料（high，运维面）

五个随包发布的模板都 `NODE_ENV=production` 却完全没有提到 `ENCRYPTION_KEY` / `ENCRYPTION_SALT`：

- `docker/app.env.example`
- `docker/app.env.attendance-onprem.template`
- `docker/app.env.multitable-onprem.template`
- `docker/app.staging.env.example`
- `docker/app.env.attendance-onprem.ready.env`

本 PR 合并后，按这些模板新装的实例会在**第一次存密**（钉钉集成保存、数据源口令、加密的
`system_configs`）直接抛错——失败落在客户那边。

修法：每个模板在 `JWT_SECRET` 之后加一段注释 + 两行**空值**声明（values-free，不写任何示例值），注释说明
生产必填、`openssl rand -hex 32` 生成、缺失或默认值时后端 fail-closed（指向
`encrypted-secrets.ts`）、已有密文时改这两个值等于密钥轮转。

**`.ready.env` 的判定**：它是**模板**，不是某次真实部署的落盘——文件头自称 "ready draft"、敏感值全是
`change-me`、`scripts/ops/attendance-onprem-package-build.sh:48` 把它整份打进安装包、多份部署文档让运维
`cp docker/app.env.attendance-onprem.ready.env docker/app.env`。所以同样加。同时把它文件头"只需替换 3 个
`change-me`"的说法和 `docs/deployment/attendance-onprem-app-env-template-20260306.md` 的"替换这 3 项"一起
改成 5 项，否则文档立刻变成假的。

**打包时是否注入：否。** `attendance-onprem-package-build.sh` / `multitable-onprem-package-build.sh` 只是
把模板逐份复制进包（没有 `envsubst`、没有 `sed -i`、全文没有 `ENCRYPTION` 字样）；
`validate-windows-runtime.ps1` 也从不读写 `docker/app.env*`，它注册服务时读的是**当前 shell** 的环境变量。
也就是说**模板就是契约**：值必须由运维填，没有任何一步会替他们补上。新加的
`tests/unit/deploy-template-encryption-material.test.ts` 把这个契约钉住（两个 key 必须声明、必须为空、
必须有解释性注释）。
