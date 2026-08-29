# 跨机开发公约(2026-08-29,Proposed → owner 合并即生效)

> **立文缘由**:metasheet2 现由至少两台计算机并行开发(A 机:备料接管/integration 线;B 机:云课堂 elearning、timemachine 线),共用同一 GitHub 仓库与同一生产目标(222)。本周实证三类跨机摩擦:①合并列车被另一机中途插入,冲突解算重复支付;②owner 在 A 机通道下达的"elearning 搁置"指令未到达 B 机,该线继续产出 8 个 DRAFT;③复核件把本机工作区 WIP 当作对方交付审出两条假 P0(第三次 STALE-BASE 事件)。**仓库是两机唯一共享通道,一切协调必须落在仓库内**;聊天、Downloads 交接、单机会话记忆均不构成跨机指令。
>
> values-free。修改本文属 T 层(默认前进 + 24h 异步否决);车道归属与搁置令的变更属 owner 层。

## 1. 车道归属(path → 机)

| 车道 | 路径 | 归属 | 状态 |
|---|---|---|---|
| 备料接管 / integration | `plugins/plugin-integration-core/`、`docs/development/takeover-beiliao-*/`、`docs/development/platform-overall-design/`、stock-prep 相关 `packages/core-backend` 迁移 | A 机 | 活跃(章程唯一优先级) |
| timemachine / multitable recovery | `packages/core-backend/src/multitable/` 恢复面、`scripts/ops/multitable-recovery-*`、相关 workflow | B 机 | 活跃 |
| 云课堂 elearning | `plugins/plugin-elearning/`、elearning 迁移与 FE | B 机 | **owner 已裁搁置(2026-08-27"先不管 elearning"),本文即该指令的跨机送达。DRAFT 可保留,不再新增产出,不合并,直至 owner 明示解除** |
| 考勤 / 审批 | 各自既有路径 | 按 PR 实际发起机 | 活跃 |

跨车道改动(动了别机车道的文件)→ PR 描述里显式标注 `cross-lane`,并等对方车道复核。

## 2. 六条机械规则

1. **迁移编号认领**:新增编号型 SQL 迁移(`0NN_*.sql`)前,必须 `git fetch` 后检查 `origin/main` 与全部远端分支的最大编号,取 `max+1`;两机同日开号时,后推者让号。Kysely 时间戳迁移(`zzzz*`)天然免撞,优先采用。
2. **合并列车不插队**:一机的多 PR 顺序合并期间(PR 描述含 `merge-train` 标注,或短时间连续合并可辨),另一机暂缓合并 main,至列车完成。今日实证:一次插入 = 下游每支多付一轮冲突+CI。
3. **热点文件解法入库**:`plugin-integration-core/package.json` 测试链冲突一律**取并集**(两侧套件一个不丢);`s6a-package-provenance-pins.json` 冲突一律**按合并后树的原始 LF 字节重算**并断言等于 `git show HEAD:` 的 sha256;`.github/workflows/plugin-tests.yml`、`Dockerfile.backend`、根 `package.json` 属共用热点,改动走最小 PR 尽快合并。
4. **REVIEW-BASE 双向生效**:任何复核件首行必须声明 `REVIEW-BASE: <40-hex sha>`;基线 ≠ `origin/main` tip 时只准标 STALE-BASE,不得出 GO/NO-GO/P0。**引用代码行号前先确认该文件在声明基线上存在且非本机未提交 WIP**——把自己工作区的 WIP 当对方交付审,本周已产出两条假 P0。
5. **部署身份入库**:任何机向 222(或其他共享目标)部署,快照必须推 tag(`deploy-rN-YYYYMMDD`),ZIP/TGZ SHA-256 记入 PR 或部署评论;未推 tag 的部署身份视为不可复原。
6. **owner 指令入库**:优先级变更、线的搁置/解除,以本文(或 decision-register)的提交为准;单机通道(聊天/Downloads)收到的指令,由收到方**当日**落成本文的 PR 送达另一机。

## 3. 当前生效的搁置令(owner,随本文送达)

- **elearning 全线搁置**:#5150 与 #5152–#5154、#5211–#5223 等 DRAFT 保留不动,不新增、不合并;解除需 owner 明示(建议同时裁 §设计锁的 unpark 条件)。
- **完整 HG-0 平台工程 NO-GO**(双方复核一致);B2a 窄闭环(PR-A/B/C/D 四支)按序合入中。
- `/stock-prep` MVP 工作台的采纳/退役/parked 三选一仍待 owner。
