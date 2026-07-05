# 组合 authoring 面(config-time UI)一轮 — 设计与验证 — 2026-07-05

## 0. 本轮定位

实体机验收 runbook(#3598)诚实标注了组合线最后一块产品缺口:**组合 authoring 无 UI,Phase 1 只能裸
curl**。本轮固定节奏关掉该缺口——纯 client、config-time、走既有 C-R4-1 路由,零 server 改动:

```text
N1 authoring service 层(save/approve/retire/audit + clamp)   → #3617 4c7665752
N2 authoring 面板(独立组件 + workbench 挂载 + 测试)          → #3621 9e77045a5 + #3625
```

写路径 / 递归 build 未触碰(各自 gated;生产写客户显式禁)。

## 1. 设计要点

### 1.1 N1 service 层(`readSourceCompositions.ts` 扩展)

- **pinned builder**:`buildReadSourceCompositionPayload(draft)` 只读 4 个命名 draft 字段;
  `version:1` / `operations:['read']` / step ids / `fromStep` / `toInput:'key'` 全为钉死常量——
  调用方(含被篡改的 draft 对象)无法把任何多余字段送上 wire。
- **draft 校验不回显**:`validateReadSourceCompositionDraft` 只产字段键控的粗粒度消息,
  secret-shaped 超长值断言不出现在任何消息中。
- **fieldErrors clamp**:save 时 400 CONFIG_INVALID 的校验三元组,经与 #3588 planErrors 同款三
  pattern(validator-code 前缀严格 / 结构路径 / reason)clamp,任一不过整条丢弃,挂在
  `ReadSourceCompositionApiError.fieldErrors`。
- **audit values-free**:action 闭枚举(未知整行丢);`detail` 只留 `{from,to}` 状态枚举对,
  version 或走私字段一律丢弃。

### 1.2 N2 面板(`IntegrationReadSourceCompositionAuthoringPanel.vue`)

- 独立组件挂载 workbench(11 行 diff),不塞 22k 行 SFC。
- 两个 step picker 只列 **approved + resolver_lookup** 读配置;name / sourceTarget(默认
  `internal_id`)输入;保存行展示 id/version/status/reused;approve/retire 带 in-flight 禁用 +
  **requestId+签名 stale guard**;values-free 审计列表;边界提示(authoring 归配置面,运行归运行面板)。
- **payload 纪律**:组件从不组 wire body——draft 直入 `saveReadSourceCompositionVersion`
  (builder 在 service 内),测试锁死篡改字段到不了 wire。
- **权限决策**(本轮最有含金量的判断):`integration:write` **动作拒绝**(disabled + handler 守卫)
  而非面板隐藏——精确对齐 server 路由分层(save/approve/retire=write-tier;list/get/audit/run=
  read-tier),picker/审计对 read-tier 可见,变更动作被门。admin-hide 模式被有意不用(该路由族
  要求 write 非 admin)。
- **generic error clamp**(#3625):面板只渲染已知 service error class 的 clamped message
  (`ReadSourceCompositionApiError` / `ReadSourceApiError`);generic/transport `Error.message`
  统一降级为固定 fallback,避免最后一层 client render 回显业务值。

## 2. 验证汇总

| 件 | 验证 |
| --- | --- |
| N1 | 33/33(service 24 + mirror 3 + run 面板 6);vue-tsc 净;仅 2 文件;独立干净 worktree 复验 |
| N2 | **88/88**(authoring 7 + run 6 + service 24 + mirror 3 + workbench 全量 48);vue-tsc 净;`git diff --check` 净;独立复验 |
| 哨兵纪律 | N1/N2 测试合计 10+ 处 `not.toContain` 哨兵扫描(业务值三元组渲染丢弃、409 粗码不回显、消息不回显原值) |

## 3. 模型分派实录(按难度自动选择)

| 件 | 分派 | 结果 |
| --- | --- | --- |
| N1 service | Sonnet-5 agent(worktree 隔离,spec 钉死 #3586/#3588 clamp 纪律) | 过质量闸;偏差判断正确(不动既有行形状,避免破坏 exact-toEqual 测试) |
| N2 面板 | Sonnet-5 agent(spec 钉死 payload 纪律 / testid / stale guard) | 过质量闸;**两处超 spec 的正确判断**:权限 tier 对齐 server 而非照抄 admin-hide;发现 run 面板 watch 防不住 deferred promise,补真 requestId+签名 guard |
| spec 撰写 / 逐行质量闸 / 独立复验 / 集成落地 | Fable-5 主循环 | 每件均干净 worktree 独立跑测,非只信 agent 汇报 |

分派策略(设计/安全推理 → 主循环强模型;机械/镜像件 → Sonnet 并行 agent + 质量闸)至此
**三轮验证有效**(C-R4-3b 云端 / 验收准备轮 / 本轮)。

## 4. 本轮后的线状态

组合线(#1709 只读)产品面完整:authoring 面板(本轮)→ approve → 运行面板(C-R4-3b)→
values-free 证据,实体机验收 Phase 1-4 全程可面板+API 混合执行,不再需要裸 curl 组 payload。

下一步(全部待 owner 指令):
1. **实体机验收执行**(owner-run,runbook #3598 + 冒烟 #3600;Phase 1 现可面板化)。
2. **W1 #3548** 仍 draft,un-draft 后审阅。
3. **REC-R1** 双门(命名场景 + 显式 opt-in)。
4. **benchmark 改进项**各自设计锁 opt-in。

## 5. 边界纪律(本轮零跨越)

零 server 改动;#3625 同面 client hardening,不新增 route/runtime;写路径未碰;递归未 build;
未与并行 session worktree 冲突(两 agent 各自隔离 worktree,#3548/#3574 未扰)。
