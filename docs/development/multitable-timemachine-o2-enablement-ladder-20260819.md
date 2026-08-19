# 多维表 Time Machine O-2 启用阶梯（enablement ladder）— PROPOSED

> Status: **PROPOSED**（本文档不自我批准；RATIFY = owner 在承载 PR 留 exact-SHA 批注）。
> 本文档只定义**顺序与判据**，不执行任何一步。每一级台阶都是**独立的 owner/ops 动作**，
> 文档合入 ≠ 任何 flag/trigger 变更授权。
> 基线：#4654 closeout（merged `12f1f8c466`，inert 落地）+ 双主机 postdeploy-full PASS
> （prod run `31650980676`、both run `31651250987`）。当前姿态：4 flag 全 unset、
> 9 authority triggers DISABLED、无 `meta_links.foreign_record_id` FK。

## 0. 为什么需要阶梯

closeout 落的是**默认关闭的基座**。把它变成活能力涉及两类互相独立的开关：

- **DB 侧**：8 张平台授权表上的 9 个 triggers（出厂 DISABLED）。ENABLE 后平台权限写路径
  开始参与 recovery-authority 串行化 ⇒ 平台写者第一次真的会遇到 40001。
- **应用侧**：4 个 env flag（`MULTITABLE_HISTORY_CONTIGUITY_STRICT` /
  `MULTITABLE_ENABLE_WRITER_FENCE` / `MULTITABLE_ENABLE_SHEET_REVERT` /
  `MULTITABLE_ENABLE_PIT_RESET`）。

顺序错误的代价不对称：先开 flag 后开 trigger ⇒ recovery 对 `authorityLease='unavailable'`
fail-closed（安全但全部失败）；先开 trigger 而平台写路径没做 40001 分类 ⇒ 用户可见 500
（这正是 O2-S2 存在的理由）。所以**trigger 先行、flag 逐个、staging 先于生产**。

## 1. 前置（L0，全部满足才允许 L1）

- [ ] O2-S1（注册同事务原子性）、O2-S2（40001 单一分类器 + 11 写者 census）、
      O2-S3（recovery 租约有界退避）已合 main 且随镜像部署到目标主机。
- [ ] 目标主机 `postdeploy-full` containment PASS（当前镜像、pending migrations = 0）。
- [ ] 回滚路径演练过一次：`ALTER TABLE … DISABLE TRIGGER` 全量脚本 + 单 flag 移除步骤
      （见 §5），并重跑 postdeploy-full 验证回到 inert 姿态。

## 2. 阶梯（每级 = 独立 owner 授权 + 观察期）

**L1 — staging ENABLE triggers（flags 保持全 OFF）**
9/9 triggers ENABLE（仅 staging）。flags 全 OFF ⇒ recovery 端点仍不可达，本级只暴露
「平台写 × authority 串行化」。观察 ≥2 日历日：40001 发生率、S2 分类器命中
（409/具名 retryable，**零** unmapped 500）、平台写延迟无回归。

**L2 — staging `MULTITABLE_HISTORY_CONTIGUITY_STRICT=1`**
只读侧收严（历史链断裂拒绝重建）。观察：strict 拒绝率 = 预期（合成断链演练拒绝、
正常表通过），无误伤。

**L3 — staging `MULTITABLE_ENABLE_WRITER_FENCE=1`**
写者围栏可达。观察：普通写路径无回归；S3 退避在写者间隙内拿到租约（演练）；
写者不停时 recovery 仍具名 busy（fail-closed 不变）。

**L4 — staging `MULTITABLE_ENABLE_SHEET_REVERT=1`（canary）**
在**具名合成 org**（禁客户数据）上执行 revert 演练：precise-anchor 成功、
preview-drift abort 正控、trash/link 状态核对。

**L5 — staging `MULTITABLE_ENABLE_PIT_RESET=1`（canary）** — 同 L4 纪律做 reset 演练。

**L6 — staging soak**：全开姿态 ≥7 日历日。判据（全部满足才可申请生产）：
零 unmapped 40001（=零该类 500）、零 40P01、零 containment 意外、canary 演练全绿、
recovery busy-exhaustion 率在口径内。

**L7+ — 生产**：重复 L1→L5（同序、同判据、独立授权、canary org 另立）。任一观察不达
⇒ 停在当前级或回滚一级，**不跳级、不补授权**。

## 3. 每级通用规则

授权 = owner 亲笔（exact 内容 + 目标环境 + 级别）；执行后立即跑 `postdeploy-full`
（containment workflow 的 flag 腿此时**预期红**的项须与本级声明的开启集合精确一致——
差一个即回滚）；观察窗内新增 P1/P2 ⇒ 冻结阶梯。

## 4. 已登记残余（启用面不扩，此处只登记处置）

- **foreign-fence 共享查找表形状**（FK KEY SHARE vs 行锁 FOR UPDATE，pre-existing）：
  可用性问题非死锁；L4/L5 canary 演练须包含一次 link-in 表并发写场景确认无 40P01。
  根治（围栏全部 link-in sheet 或弱化记录锁）留独立立项。
- **retention 后恢复 / 整表 resurrect / 归档异步恢复（Phase D）**：与本阶梯无耦合，
  另立设计锁。
- **`#4446` resurrect 参考件**：reference-only（`multitable-4446-resurrect-reference-design-20260812.md`），
  不随本阶梯启用。

## 5. 回滚（每级可逆，单向依次撤）

flag 级：从 compose/env 移除该 flag → 重启 → `predeploy-flags` 验证该 flag CONTAINED。
trigger 级（大红开关）：9/9 `DISABLE TRIGGER` → `postdeploy-full` 验证回到出厂 inert
指纹（`8c1be0b0…`/`14c180aa…` 仍应精确匹配——DISABLE 不改函数体）。
回滚不需要迁移、不丢数据（authority locks 表保留，无消费者时惰性）。
