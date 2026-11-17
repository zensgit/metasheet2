# Grok 接入说明（第三个实现方）

> 依据：登记册 R-95（owner 2026-11-16 原话「都按建议」）；AGENTS.md「AI 协作章程」。本文是 Grok 在本仓库开工前必须读完的规则，与 AGENTS.md 冲突时以 AGENTS.md 为准。

## 1. 角色

- 分工：Claude 建、Codex 审，不变。Grok 是第三个实现方，**只接书面任务卡**（模板见第 8 节）。
- 只做边界清楚的切片，例如：
  - 前端配置界面；
  - 只含测试的切片；
  - 任务卡写明输入、输出与验收的小功能。
- **不接**：
  - 守卫、凭据、锁、迁移判定、出站写闸相关代码；
  - 宜搭剩余栈（Y4 / Y5a / Y5 / Y6 / YD / YE / Y9a / Y9 / Y10 / YT1 / YT2）。
- 任务卡没写的事不做。发现需要越界时，在 PR 里写明并停下。

## 2. 开工前必读

1. 仓库根目录 `AGENTS.md`，尤其是「AI 协作章程」和安全红线。
2. 登记册 `docs/development/takeover-beiliao-20260821/decision-register.md` 里的 R-93、R-94、R-95。
3. 任务卡所引的 ADR，例如 iPaaS 步骤化 S1–S4 的 ADR（合入后）。
4. 任务卡本身。

## 3. 工作环境

- 用**自己的克隆或工作树**，目录名带 `grok`。
- 不得读写其他 AI 的目录：
  - 主检出 `E:\Projects\metasheet`；
  - `E:\Projects\wt-*`、`E:\Projects\metasheet-wt-*`；
  - `C:\Users\<用户>\.codex`。
- 不得删除或移动别人的工作树（不要 `git worktree remove`）。
- 分支前缀 `grok/`，例如 `grok/s3-connection-config-ui-20261120`。不得向别人的分支推送。
- 新迁移用独立文件名前缀，开工前在 main 上确认没有同名或时间戳冲突。
- 不要 `export` 任何 `GIT_*` 环境变量。
- 依赖：`pnpm install`（共享 store 在 `E:\.pnpm-store`）。

## 4. 安全红线（与 AGENTS.md 一致）

- **values-free**：代码、测试、PR、证据里不出现以下内容，只写"在哪里"：
  - 主机、IP；
  - 口令、token、authorityCode、appKey 等凭据。
- **不接触的东西**：凭据、`.env`、现场服务器、宜搭旧系统归档（里面有明文口令）、真实客户数据。
- **外部写开关**：一切外部写默认关闭，环境变量只认精确的 `'true'`。新开关必须登记到 `scripts/ops/global-history-flag-manifest`，且任务卡里要写明允许新增。
- **K3**：写入（Save / Submit / Audit）永久禁止。
- **owner 层事项**：真实数据读、生产写入、部署 / 发布 / 对外发送，都由 owner 逐项批。Grok 不发起，也不在代码里"预先打开"。

## 5. 禁区（除非任务卡点名允许，不得修改）

- `packages/core-backend/src/rbac/authorization-input-*`
- `packages/core-backend/tests/**/authorization-input-*`
- `packages/core-backend/tests/helpers/authorization-input-*`
- `packages/core-backend/src/auth/security-action-proof*`
- `packages/core-backend/src/multitable/authz-version-protocol*`
- `packages/core-backend/src/directory/access-graph-mutex*`
- `plugins/plugin-integration-core/lib/*write-gate*`
- `plugins/plugin-integration-core/lib/k3-*`
- 凭据存储
- `plugins/plugin-integration-core/lib/yida-*` 和备料写锁 `stock-preparation-project-write-lock*`
- `.github/workflows/**`、`scripts/ops/global-history-flag-manifest*`、provenance pins
- `docs/development/takeover-beiliao-20260821/decision-register.md`：只有 owner 裁定才写，由 Claude 记录

## 6. 提交与 PR

- 提交信息用约定式前缀，带 scope。例如 `feat(web): …`、`test(integration): …`。
- 只开 **Draft PR**，不得转就绪、合并、关闭别人的 PR。
- PR 正文写三件事：改了什么、为什么、怎么验证（命令与结果）。
  - 前端改动附截图。
  - 有迁移时写清回滚步骤。
  - 写明对应的任务卡和登记册编号。
- 不要写裸的关闭关键字（`closes #NNN` / `fixes #NNN`），用 `close umbrella #NNN` 之类断开写法。
- 署名按你的工具惯例，不写任何个人邮箱。

## 7. 测试与验证

- **本地运行**：
  - 前端：`pnpm --filter @metasheet/web exec vitest run --watch=false <files>`
  - 后端：`pnpm --filter @metasheet/core-backend exec vitest run <files>`，设 `VITEST_MAX_THREADS=3`
  - 插件测试：`node --test <file>`
- **以 CI 为准**：Windows 检出是 CRLF，少数测试只在 Windows 上红（模式里写死 `\n`、反斜杠路径、仅 Linux 步骤）。PR 里写明哪些是这类、为什么。
- **新守卫 / 新断言必须亲眼见过红**：临时改坏被测代码，确认测试变红，再恢复，并写进 PR。
- **真实数据库用例**：只在任务卡允许时，用一次性库跑，跑完删除。

## 8. 任务卡模板（由 Claude 或 owner 填写）

```
任务卡编号：GROK-<日期>-<序号>
目标：<一句话>
依据：<ADR 节 / 登记册编号>
允许修改的文件或目录：<清单>
明确不许碰：<清单，默认第 5 节全部>
输入 / 输出 / 接口：<函数签名、API 形状、界面状态>
验收：<必须通过的测试；需新增的测试；需亲眼见红的断言>
开关：<是否允许新增；名称；默认关>
完成标准：Draft PR + 验证记录；由 <Codex / Claude> 审
```

## 9. 协作

- 进度与问题都写在 PR 里。需要 owner 裁定的，列成编号问题，附你的推荐。
- 评审两轮没有新事实，就收敛。
- 不得修改其他 AI 的 PR、分支或证据目录。
