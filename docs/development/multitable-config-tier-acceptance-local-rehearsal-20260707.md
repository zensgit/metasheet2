# Config-tier acceptance — LOCAL REHEARSAL evidence (O-1 prep, 2026-07-07)

> **⚠️ 本文是「本地彩排」证据,不构成 O-1 staging 验收。** 本次全部运行仅发生在本机(一次性 Docker
> Postgres + 本地 `tsx` 进程),从未触碰任何 staging/prod 主机、真实部署环境或远端 secrets。
> **staging 正式验收仍属 operator**,按
> `docs/development/multitable-config-tier-acceptance-runbook-20260705.md` 执行。
> 本文的目的:(1) 证明 harness(#3609 合入后从未真跑过)首跑即可端到端跑通;(2) 把首跑发现的坑
> 前置给 operator,降低 staging 首跑的摩擦。

## 结论(TL;DR)

harness `packages/core-backend/scripts/config-tier-acceptance.mjs` 在本地完整跑通 **6 次运行、全部
预期姿态**:三 tier flag-off 契约、每 tier 单独 flag-on 全走、三 flag 全开一次覆盖(40 PASS / 0 FAIL /
0 SKIP)、无 EDITOR_TOKEN 时 perm-revert tier 干净整体 SKIP。**产品行为零缺陷;harness 自身零代码
缺陷**;发现 2 处 operator 需预先知道的环境前置/行为特性(见「发现」)。

## 环境

| 项 | 值 |
|---|---|
| 代码基线 | `origin/main @ 27c5cbe5a`(worktree 分支 `claude/gh-o1-local-rehearsal-20260707`,零源码改动) |
| 数据库 | 一次性 Docker 容器 `postgres:16`(实际 16.14, aarch64),随机高位端口 55551,用后即删 |
| 迁移 | `pnpm --filter @metasheet/core-backend db:migrate` → **244 条全部成功**(`kysely_migration` 计数 244) |
| 服务 | `pnpm --filter @metasheet/core-backend dev:core`(tsx, Node v25.9.0),`PORT=56617`,每种 flag 组合独立重启(flag 是 per-request 读 `process.env`,但改的是**进程外** env,必须重启进程) |
| 认证 | `JWT_SECRET` 自定 + `RBAC_TOKEN_TRUST=true`(NODE_ENV=development;claims 携带 `roles`/`perms`),admin=`multitable:read/write/share`,editor=`multitable:read` |
| 用户种子 | 两个用户行 INSERT 进 `users` 表(见发现 #1 —— 授权路由校验 subject 必须真实存在) |
| flag 集 | `MULTITABLE_ENABLE_CONFIG_UNCREATE` / `MULTITABLE_ENABLE_CONFIG_UNDELETE` / `MULTITABLE_ENABLE_PERMISSION_REVERT`,逐次组合(见运行矩阵) |

## 运行矩阵(6 次)

| Run | flag 姿态 | EDITOR_TOKEN | 结果 | exit |
|---|---|---|---|---|
| A | 全关 | 有 | **7 PASS / 0 FAIL / 6 SKIP** — 三 tier flag-off 契约(`403 <TIER>_DISABLED`,preview+execute 双路)全部成立 | 0 |
| B | 仅 uncreate 开 | 有 | **16 PASS / 0 FAIL / 4 SKIP** — uncreate 全走绿(含 `CONFIRM_REQUIRED`×2、`PLAN_DRIFT`+零写入);另两 tier flag-off 契约同证 | 0 |
| C | 仅 undelete 开 | 有 | **17 PASS / 0 FAIL / 4 SKIP** — undelete 全走绿(含 `ID_COLLISION`、`PLAN_DRIFT`、definition-only 回读) | 0 |
| D | 仅 perm-revert 开 | 有 | **21 PASS / 0 FAIL / 4 SKIP** — de-escalation 全走绿(含 `422 RESTORE_NOT_SUPPORTED` 拒绝升权、`409 GRANT_DRIFT`、revoke 回读) | 0 |
| E | 三 flag 全开 | 有 | **40 PASS / 0 FAIL / 0 SKIP** — 「一次运行覆盖全部启用组合」姿态成立 | 0 |
| F | 三 flag 全开 | **无** | **23 PASS / 0 FAIL / 3 SKIP** — perm-revert tier 按文档承诺整体干净 SKIP,不误伤另两 tier | 0 |

(另有一次 Run A 的首次尝试因发现 #1 的环境前置而 FATAL,详见发现 #1/#2 —— 那次失败本身是本彩排最有
价值的产出之一。)

## 每 tier 关键输出摘录

### config-uncreate(Run B,flag ON)

```
  ✓ PASS  (uncreate/ii) preview → 200
  ✓ PASS  (uncreate/ii) preview names the entity (masked diff, no counts/plan fields)
  ✓ PASS  (uncreate/iii) execute without confirm → 400 CONFIRM_REQUIRED
  ✓ PASS  (uncreate/iii) execute with wrong confirm → 400 CONFIRM_REQUIRED
  ✓ PASS  (uncreate/ii) execute with confirm:"uncreate" → 200
  ✓ PASS  (uncreate/ii) follow-up read: field is gone
  ✓ PASS  (uncreate/iii) stale token after blast-radius drift → 409 PLAN_DRIFT
  ✓ PASS  (uncreate/iii) zero writes on drift — field still present
```

### config-undelete(Run C,flag ON)

```
  ✓ PASS  (undelete/ii) preview names the entity + idCollision flag (masked, no plan fields)
  ✓ PASS  (undelete/ii) execute with confirm:"undelete" → 200
  ✓ PASS  (undelete/ii) follow-up read: field definition is back (name/type)
  ✓ PASS  (undelete/iii) id occupied by a foreign entity → 409 ID_COLLISION
  ✓ PASS  (undelete/iii) stale token after order-shift drift → 409 PLAN_DRIFT
```

### permission-revert(Run D,flag ON)

```
  ✓ PASS  (perm-revert/ii) direction=de-escalation, supported=true, masked (no raw grant)
  ✓ PASS  (perm-revert/ii) execute with confirm:"revert-permission" → 200
  ✓ PASS  (perm-revert/ii) follow-up read: grant fully revoked (no entry)
  ✓ PASS  (perm-revert/iii) direction=escalation, supported=false (before=write > live=read)
  ✓ PASS  (perm-revert/iii) escalation execute → 422 RESTORE_NOT_SUPPORTED
  ✓ PASS  (perm-revert/iii) grant unchanged after refused escalation (still read)
  ✓ PASS  (perm-revert/iii) stale token after grant drift → 409 GRANT_DRIFT
```

### flag-off 契约(Run A,全关)

```
  ✓ PASS  (uncreate/i)    flag-OFF preview/execute → 403 CONFIG_UNCREATE_DISABLED
  ✓ PASS  (undelete/i)    flag-OFF preview/execute → 403 CONFIG_UNDELETE_DISABLED
  ✓ PASS  (perm-revert/i) flag-OFF preview/execute → 403 PERMISSION_REVERT_DISABLED
```

每次运行的 throwaway sheet 均被 harness 自行 `DELETE → 200` 清理;throwaway base 按既有
reset-acceptance / pit-undelete-acceptance 模式留存(无 `DELETE /bases` 路由,惰性元数据)。

## 发现(harness 缺陷/坑,含 file:line)

**harness 自身零代码缺陷需要修** —— 6 种姿态输出与 runbook 场景表逐行吻合,exit code 语义正确
(全部 0)。以下 2 条是首跑发现、operator 必须预知的行为特性/环境前置:

1. **EDITOR_TOKEN 的用户必须真实存在于 `users` 表(grant-subject 校验)。**
   perm-revert tier 的 setup 会以 admin 对 editor 的 user id 发
   `PUT /sheets/:sheetId/permissions/user/:subjectId`;该路由在
   `packages/core-backend/src/routes/univer-meta.ts:6950-6957` 对 subject 做
   `SELECT id FROM users WHERE id = $1`,查无 → `404 NOT_FOUND (User not found)`。
   本地首跑用 `RBAC_TOKEN_TRUST=true` 的 trusted-claims token(用户不在库中)即触发此 404。
   **staging 用真实登录 token 时该前置自然满足**;但若 operator 用任何「非真实用户」的方式铸
   EDITOR_TOKEN,会在 setup 第一步 404。runbook 的 Env contract 未写明这一点。

2. **tier 内 setup 失败 → 整个 run FATAL exit 2,且不打印 summary 表。**
   上述 404 发生后,`findPermRevision`(`config-tier-acceptance.mjs:288`)抛错 →
   `run().catch`(`config-tier-acceptance.mjs:390`)以 `FATAL (setup or harness error)` exit 2。
   此时前两个 tier 已 PASS 的 6 行 + setup 的 1 行 `✗ FAIL` 都已打印,但 `── summary ──` 行不会出现,
   exit code 是 2 而非 1。语义上符合文档(exit 2 = config/setup error),cleanup(`finally`)也正确
   执行了(throwaway sheet DELETE → 200),**不算缺陷**;但 operator 看到 exit 2 + 无 summary 时,
   应往前翻找 `✗ FAIL` 行定位,而不是怀疑网络/部署。
   (评估过是否修改为「打印部分 summary」:改动会碰 run/finish 的控制流,不属于「小而确定」,按任务
   纪律只记录不改。)

此外一条对**本地复现**(非 staging)有用的环境注记:sheet-permission 的 grant 路由要求 actor 具备
`canManageSheetAccess`(admin 或 `multitable:share`),与 runbook 一致;trusted-token 模式下把
`multitable:share` 放进 `perms` claim 即可,无需 RBAC 表种子。

## 给 operator staging 首跑的注意事项清单

1. **两个 token 都必须是目标环境的真实用户**(能通过 `GET /api/auth/me`),且 EDITOR_TOKEN 的用户
   行真实存在于 `users` 表(见发现 #1)。ADMIN_TOKEN 需 sheet-admin(admin 角色或 `multitable:share`)。
2. **带上 EDITOR_TOKEN**。不带时 perm-revert tier 整体 SKIP(本彩排 Run F 已验证干净 SKIP),那样
   staging 验收就少了一个 tier 的证据。
3. **flag 改动必须重启/重发布服务**。flag 虽是 per-request 读 `process.env`
   (`univer-meta.ts:8240/8258/8277` preview、`:8389/8443/8490` execute),但运行中的进程不会拾取
   环境里新设的值 —— 本彩排每种组合都重启了进程,行为与 runbook「restart/redeploy」一致。
4. **exit 2 + 无 summary ≠ 环境故障**:先往前翻 `✗ FAIL` 行(见发现 #2);exit 2 也可能是 BASE_URL /
   ADMIN_TOKEN 缺失(`config-tier-acceptance.mjs:43`)。
5. **一次全开运行即可覆盖三 tier**(本彩排 Run E:40/0/0);若想逐 flag 独立取证,每 tier 单开的
   姿态(Run B/C/D)也都验证过是干净的。
6. **flag-off 契约先行**:按 runbook stop-conditions,翻 flag 前先跑一次全关(应得 6 PASS + SKIP,
   Run A 形态),确认部署的 bundle 真的带路由且 flag 当前为关。
7. 每次运行留下一个 throwaway base(惰性元数据,无删除路由,与既有验收 harness 模式一致);
   throwaway sheet 由 harness 自行删除,留意运行末尾的 `Cleanup: DELETE … → 200` 行。
8. harness 全程只碰自建 base/sheet/field/grant,不触碰任何存量数据 —— 与源码核对属实
   (`setup()` 自建,`cleanup()` 只删自建 sheet)。

## 运行日志留存

六次完整 stdout/stderr、五次服务 boot 日志、迁移日志均存于会话 scratchpad
(`o1-logs/{runA2,runB,runC,runD,runE,runF}-*.log` 等),未入 git(本 MD 为唯一入库证据,按任务约定)。
彩排结束后:本地服务进程已 kill,Docker 容器 `ms2-o1-rehearsal-8186` 已 `docker rm -f`,端口已释放。
