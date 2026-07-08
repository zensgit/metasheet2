# Multitable Global History — R5 微轮记录:#3749 吸收审计 + 无闸门补强(2026-07-07)

**性质:** 固定节奏微轮(R4 见 `…r4-gate-front-round-record-20260707.md`)。触发:R4 收轮复扫发现当日跨车道大交付 **#3749**(Codex 线,"complete Global History remaining code gates")尚未经本线吸收性审计——按线纪律,落在本线面上的 runtime 变更须 post-hoc 审计,审出的补测试/补边角属无闸门开发(先例 R3-1)。

## 1. 吸收审计(Opus adversarial-reviewer,refute-first,全部实跑取证)

**判定:APPROVE(post-hoc;合并可靠)— 0 P1 · 0 P2 · 6 P3 · 3 NIT。** MD = `/tmp/pr3749-absorption-audit-claude-20260707.md`。

承重结论(实跑,非推理):
- `RESET_RETENTION_CONFLICT` 守卫**真实弹**:env 读取与 retention resolver 逐字节一致;位于两条 reset 路由任何 DB 操作之前(结构性 zero-writes);两条写路由皆守;对齐 PIT_RESET STOP-SHIP 的正确一半且 MD 如实声明。
- (b2) golden **经验性 mutation-proven**(neuter 守卫→恰好 1 红/13),且该文件在真实 CI gate(`plugin-tests.yml`)内,非 green-because-skipped。
- 三 tier typed-confirm **服务端权威**(400 CONFIRM_REQUIRED + execute 事务内 re-check LIVE grant)——FE 门是 defense-in-depth 而非 theater;无 wire-vs-fixture 漂移。
- 原拟 P2(FE `supported` 门未测)因上游服务端缓解降级 P3。

## 2. 补强(PR #3857,Sonnet 车道,逐项 mutation 隔离证据)

| 项 | 内容 | 证据 |
|---|---|---|
| P3-1 | permissionRevert `supported:false`/escalation FE 负例 | neuter 门→恰 1 红/26(车道自证 + 主会话独立复验) |
| P3-2 | picker 历史加载 error/empty/unavailable 三分支 | 3 条独立 mutation 各恰 1 红 |
| P3-3 | undelete 非冲突正路执行 | requiredConfirm undelete 分支 neuter→恰 1 红 |
| P3-4 | 破坏性 tier execute 失败呈现(409/422→`config-restore-error`) | catch 赋值 neuter→恰 1 红 |
| P3-6 | modal 内联双语散串收编 `meta-record-labels.ts`(STRICT-ZERO):`configRestoreBoolYes/No` + `configRestoreTypedConfirm` helper(confirm token 不翻译) | 渲染文本逐字节保形;既有 23 spec 全绿 |
| P3-5 | T-source 方向文档 §3 补同毫秒语义适用于已上线 picker 的一句话 | docs-only |
| NIT-b | 守卫 `.trim()` 不对称 | **回滚不改**(车道内部顾问审出改动方向趋松,违「只许更严」);记录为安全向的美观性过阻断 |
| NIT-a/c | picker 英文-only 既有债 / MD 占位符 | 记录不修(既有债扩展/点时记录) |

验证:两 spec 35/35 + web-guard 全矩阵 511/511 + `vue-tsc -b` 干净;零后端 diff。主会话闸门审(独立复跑 + P3-1 独立 mutation 抽验)= APPROVE(`/tmp/pr3857-review-claude-20260707.md`)。**#3857 MERGED `dc8c08e03`。**

## 3. 轮后状态

线状态与 R4 收轮一致:**池空**;五个 owner 闸门不变(ratify 4c-1(U-L8 二择一)/ ratify 4c-2 / T-source 保持A2或简化A1 / O-1 staging 正式跑 / destructive-tier FE 闭合判定)。解锁哨兵在岗。

## 4. R5b 追记(2026-07-07)

§2 中 NIT-a(ResetToPointPicker 英文-only)原判「记录不修」,复判为**纪律归位**:strict-zero 收线后的规则是未来 UI 字符串一律进 typed label 模块,该组件生于收线之后,属规则内新债而非既有债扩展。R5b 微切片将其全部可见字符串收编 `meta-record-labels.ts`(`record.resetPicker*` 命名空间 + `resetPickerRecordCount` 插值 helper)并补 zh;EN 渲染逐字节保形(7 分支 before/after DOM diff 为空),flag(PIT_RESET)休眠零线上风险。
