# 审批、自动化与 Canvas 组合收口执行台账（2026-07-22）

**状态：IMPLEMENTED ON MAIN / MERGED-MAIN MATRIX PASS / UAT AND FLAGS PENDING**

merged-main 记录基线：`origin/main@adbd092fd30b0a17ce914106aa5bffa5053af346`。串行 squash：
#4540 `cd3d3372b9ddfa8530be687a43c3b4b54d726997` -> #4524
`974d3c8b9aa83c3bd19d993ea946c0b600c1b0d0` -> #4531
`0b59321ed0a40ed1cebcd77623651de15c209752` -> #4539
`adbd092fd30b0a17ce914106aa5bffa5053af346`。
本台账记录实现、合入和验证证据，不构成 UAT、部署或启用授权。

## 1. 已在 main 的底座

| 能力 | 状态 | 证据边界 |
|---|---|---|
| durable delivery S1-S5/S7 | 已合入 | #4337；代码存在不等于 flag ON |
| FWB ledger、mapping、record-link executor、decision-value freeze | 已合入底座 | #4341/#4343/#4344；生产 authoring/activation 由数据栈补齐 |
| revision/outbox 事务模式 | 已合入 | FWB create/update 复用，不另造状态机 |

## 2. 来源栈与组合头

| Lane | PR / exact head | 内容 | 组合处置 |
|---|---|---|---|
| Data root | #4510 `f6d05814a8` | 附件、FWB activation、画布基础和 CI | 被 #4540 吸收 |
| Record-link | #4524 `974d3c8b9` | 安全 record-link 字段、选择器与 DB 权限正控 | 已按序 squash 到 main |
| FWB update | #4531 `0b59321ed` | 更新受约束已有记录 | 已按序 squash 到 main |
| FWB composition | #4539 `adbd092fd` | 新建/更新 authoring 与生产组合 | 已按序 squash 到 main；merged-main 验收基线 |
| Canvas root | #4433 `fc5477d7e4` | 分支编排与纵向画布 | 被 #4540 吸收 |
| Canvas all-path | #4532 `762dc0fd5` | 条件内并行路径全部汇合 | 被 #4540 吸收 |
| Canvas inspector | #4533 `babc6d975` | 共享检查器、键盘和响应式 | 被 #4540 吸收 |
| Version restore | #4536 `3bb327a93` | diff/restore 与当前校验 | 被 #4540 吸收 |
| Navigation | #4537 `b2f69116b` | zoom/pan/minimap/overlay | 被 #4540 吸收 |
| Reorder | #4538 `a3562083af` | 同区域语义重排 | 被 #4540 吸收 |
| Integration | #4540 `cd3d3372b` | 两条线的唯一联合解析与测试面 | 已按序 squash 到 main |

## 3. 组合审阅发现与修复

1. `graphTopologyEdit.ts` 自动合并产生重复 helper；去重并由 web typecheck/35 项拓扑测试钉住。
2. 数据线默认关闭 `approvalCanvasV2` 后，Canvas 规格没有显式开 flag；改为响应式 feature mock，并保留 flag-OFF 正控。
3. 共享检查器重新显示 raw user/role/field id 和 per-branch JSON 样例；改为 typed picker、业务标签和测试发布样例。
4. 字段权限行和 form-field-user 选项回退到 field id；改为“未命名字段”，不再泄露内部标识。
5. 前后端并行路径遍历冲突；保留运行时配置边/default/fallback 的镜像语义，忽略 stray edge。
6. 5 个 Canvas 源码和 3 个规格不触发 `approval-web-guard`；补齐 pull_request/push 两套路径，required 常驻门不变。
7. record-link 的事务内 DB 权限复查使旧 authoring UAT 只凭 JWT wildcard 的正控返回 403；不降级产品门，改为在
   fixture 中建立并清理真实 `approvals:write` DB 授权，最终 record-link + authoring UAT 45/45。
8. 条件分支允许无规则但带公式时，纯字面量或受字段边界保证的恒真公式可捕获全部流量；新增 AST 动态依赖
   判定和基于必填数值字段 `min/max` 的保守区间证明。创建/更新/发布/恢复拒绝无动态依赖及可证明恒真公式；
   历史静态或 capture-prone 公式在运行时 values-free 409，不能静默进入 fallback。无法证明恒真的动态公式保留。
9. record-link 的 base-read 产品门正确但测试没有把它设为唯一变量；新增同一 actor/template/sheet/record 的
   submit + picker 负例，再只补 `multitable:base:read` 得到双正控，防止未来删门后 required 真库仍绿。
10. 复核生产 FWB 路径确认所有 `targetType: 'number'` 映射当前均被
    `exact_number_mapping_unavailable` 拒绝；撤销“金额/数量已写回”的文档声明，保留 D0-D4 为独立能力线。
11. Canvas publish preflight 曾把 parallel node key 和动态来源 fingerprint 直接放入可见文案，保存/发布 catch
    还会回显任意后端 message；改为无标识符的业务文案及 machine-code allowlist，未知 API/本地错误统一使用
    values-free fallback。附件 runtime 已确认在 flag 分支内 dynamic import，无需再改。
12. 外部复核构造出 `{amount} == {amount}` 与 `requester.department == requester.department`：它们带动态引用，
    却仍会恒真捕获分支。semantic truth 与 capture policy 已拆分；创建/更新/发布/恢复拒绝 capture-prone
    结构，历史模板运行时 values-free 409。并行编辑的本地拒绝文案也改为通用业务提示，不再携带 corrupt
    draft 的 raw node key。
13. #4524 重叠后的 required 真库暴露两项旧基线问题：审批 fixture 只给 JWT wildcard、未建立最终 DB
    `approvals:write` 权限，以及 record-link 列表投影把 UUID 与 `text[]` 比较。保留产品 default-deny 门，
    统一让 integration actor 建立 DB 权限；投影改为 `uuid[]` 并补单测。19 个受影响 integration 文件
    在新库上 107/107。
14. #4531 和 #4539 均在父层实际落 main 后重叠；#4539 11/11 提交 `range-diff` 等价。最终 merged-main
    新库迁移通过，FWB create 18/18、update 15/15、S1-S8 9/9。

## 4. 多模型使用与最终责任

| 模型/角色 | 本轮用途 | 结论边界 |
|---|---|---|
| Kimi K3 | 只读 UI 冲突审阅 | 找到共享 editor 的 raw-id 回退和合并重复；Codex 独立修复并复测 |
| Grok 4.5 | 组合 exact-head 只读复核 | 找到 identity-tautology 绕过；另提出 dry-run 诊断与 number mapper 疑虑，交由 Codex 按真实调用链裁决 |
| ReClaude / Opus | 公式、record-link、FWB 定向复核 | 确认 identity-tautology；确认 base-read 和 number activation fail closed；认为 dry-run 仅返回作者输入/结构诊断，不构成服务端值泄露 |
| Codex | 分歧裁决、代码修复、真库/单测/typecheck 与最终台账 | 接受恒等式和 raw node-key 修复；保留有用的 values-free dry-run 诊断及未来 D0-D4 使用的纯 number mapper |

代理结论只绑定其读取的 exact head；不能跨 rebase 或替代测试、CI 和 owner 决策。

## 5. 落地记录与后续顺序

1. #4540 -> #4524 -> #4531 -> #4539 已串行 squash 到 main；每层在 retarget 后重新通过 required checks。
2. 每次 rebase 均保留旧头并执行 `range-diff`；#4539 的 11 个独有提交逐一 patch-equivalent。
3. merged main 空库迁移成功；FWB create、FWB update 与 S1-S8 正式矩阵 3 files / 42 tests 通过。
4. 三件套更新到 merged-main exact heads 后，才进入真实租户 UAT。
5. flags 仍按 durable -> Class A -> Class B -> FWB -> attachments/Canvas staged rollout 分级开启。

## 6. 当前 owner 门

- 来源 PR 的 supersede/关闭处置，避免重复落地；
- 真实企业、真实模板、真实附件和真实多维表 UAT；
- 分级 flag 与观察窗口；
- number/decimal 写回、自由重连、大图虚拟化、移动 bottom sheet 等下一轮 opt-in。
