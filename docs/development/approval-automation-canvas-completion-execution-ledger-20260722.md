# 审批、自动化与 Canvas 组合收口执行台账（2026-07-22）

**状态：COMPOSED AND LOCALLY VERIFIED / DRAFT STACK #4540 -> #4524 -> #4531 -> #4539 / NOT LANDED**

记录基线：`origin/main@7a64424d109a`。组合根：#4540 `7b54908c9e7194991403cdb8962186c17e0415ed`；
最终数据栈头：#4539 `c2e5d134f84cb5d131a0c1f855e81e187860f7ee`。
本台账记录实现和证据，不构成合并、UAT 或启用授权。

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
| Record-link | #4524 `72ecbbb35b` | 安全 record-link 字段、选择器与 DB 权限正控 | 已叠到 #4540 |
| FWB update | #4531 `510738c9e` | 更新受约束已有记录 | 已叠到 #4524 |
| FWB composition | #4539 `c2e5d134f` | 新建/更新 authoring 与生产组合 | 已叠到 #4531；最终审阅头 |
| Canvas root | #4433 `fc5477d7e4` | 分支编排与纵向画布 | 被 #4540 吸收 |
| Canvas all-path | #4532 `762dc0fd5` | 条件内并行路径全部汇合 | 被 #4540 吸收 |
| Canvas inspector | #4533 `babc6d975` | 共享检查器、键盘和响应式 | 被 #4540 吸收 |
| Version restore | #4536 `3bb327a93` | diff/restore 与当前校验 | 被 #4540 吸收 |
| Navigation | #4537 `b2f69116b` | zoom/pan/minimap/overlay | 被 #4540 吸收 |
| Reorder | #4538 `a3562083af` | 同区域语义重排 | 被 #4540 吸收 |
| Integration | #4540 `7b54908c9e` | 两条线的唯一联合解析与测试面 | Draft，owner review |

## 3. 组合审阅发现与修复

1. `graphTopologyEdit.ts` 自动合并产生重复 helper；去重并由 web typecheck/35 项拓扑测试钉住。
2. 数据线默认关闭 `approvalCanvasV2` 后，Canvas 规格没有显式开 flag；改为响应式 feature mock，并保留 flag-OFF 正控。
3. 共享检查器重新显示 raw user/role/field id 和 per-branch JSON 样例；改为 typed picker、业务标签和测试发布样例。
4. 字段权限行和 form-field-user 选项回退到 field id；改为“未命名字段”，不再泄露内部标识。
5. 前后端并行路径遍历冲突；保留运行时配置边/default/fallback 的镜像语义，忽略 stray edge。
6. 5 个 Canvas 源码和 3 个规格不触发 `approval-web-guard`；补齐 pull_request/push 两套路径，required 常驻门不变。
7. record-link 的事务内 DB 权限复查使旧 authoring UAT 只凭 JWT wildcard 的正控返回 403；不降级产品门，改为在
   fixture 中建立并清理真实 `approvals:write` DB 授权，最终 record-link + authoring UAT 45/45。

## 4. 多模型使用与最终责任

| 模型/角色 | 本轮用途 | 结论边界 |
|---|---|---|
| Kimi K3 | 只读 UI 冲突审阅 | 找到共享 editor 的 raw-id 回退和合并重复；Codex 独立修复并复测 |
| Grok | 只读后端冲突审阅 | 建议后端冲突保留 Canvas runtime-path 校验及数据线附件/FWB 非冲突内容 |
| ReClaude | 尝试关键审阅 | 多次返回 `Execution error`，不记录 verdict |
| Codex | 冲突解析、代码修复、真库与全量 gate、最终台账 | 对 #4540 的工程结论负责 |

代理结论只绑定其读取的 exact head；不能跨 rebase 或替代测试、CI 和 owner 决策。

## 5. 推荐落地顺序

1. 审阅并串行合入 #4540 -> #4524 -> #4531 -> #4539；不要再合入 #4540 已吸收的 #4510/#4433-#4538 完整内容。
2. 每个 child 落地后把下一 PR retarget 到 main，并确认产品提交 range-diff 不漂移、required checks 重新过绿。
3. 最终 child 落 main 后，在 merged main 重跑新库迁移、FWB activation、S1-S8、附件、版本恢复、required web 和生产构建。
4. 更新本三件套为 merged-main exact heads 后，才进入真实租户 UAT。
5. flags 按 durable -> Class A -> Class B -> FWB -> attachments/Canvas staged rollout 分级开启。

## 6. 当前 owner 门

- #4540 与后续 FWB child 栈的审阅/合入；
- 来源 PR 的 supersede/关闭处置，避免重复落地；
- 真实企业、真实模板、真实附件和真实多维表 UAT；
- 分级 flag 与观察窗口；
- 任意精度 decimal、自由重连、大图虚拟化、移动 bottom sheet 等下一轮 opt-in。
