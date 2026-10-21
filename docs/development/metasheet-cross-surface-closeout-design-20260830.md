# MetaSheet 跨域收口设计锁（2026-08-30）

> 状态：RATIFIED FOR THIS CLOSEOUT。三个实现 PR 已按顺序合入，最终 merged-main Node18/20 与全部提交级检查终态通过。

## 1. 目标

本锁把 Time Machine、云课堂和审批/流程自动化三个分离开发窗口收束为一个可机械验证的落地主序列，同时保留各域未完成能力和运行权限边界。

## 2. 落地顺序

1. Time Machine `#5328`：关闭恢复归档残留并验证 merged main。
2. 审批整合 `#5329`：在 then-current main 上 replay、exact-head CI、独立复审后合并。
3. 云课堂整合 `#5327`：在 then-current main 上 true merge，保留共享 selector/provenance 并集，exact-head CI 与独立复审后合并。
4. 最终 merged main：验证三域共同树，再提交本锁、开发报告和验证报告。

## 3. Time Machine 边界

- 关闭 D2-D7 中恢复归档、索引、生命周期和 owner UI 的已登记残留。
- 保持 recovery worker、e-learning media worker 和共享连接池的关闭顺序。
- 不把本地/CI 证据扩写为生产对象存储、KMS、真实进程重启或真实故障窗口验收。

## 4. 审批与流程自动化边界

- 保留 #5197 mounted browser、#5202 member-action browser required gate。
- 整合 Canvas clean promotion、pre-flow dirty、legacy PATCH fidelity、Lock-8 字段检查器/serializer ownership、Lock-9 C1 附件异步清理。
- Canvas 当前仓库语义为 unset/true 默认 ON、exact false 回滚；不得误写为默认 OFF。
- after-sign `#5183`、detail x multitable `#5174`、contact compatibility `#5182` 仍属未 ratify 设计；`auto_reject`、`signaturePolicy`、sequential mode 未在本轮交付。

## 5. 云课堂边界

- 本轮整合交付 credit adjustment、rules/wallet、pass_exam authority、article/external-link content course、learner/admin Web、OpenAPI 与 required selectors。
- 所有 org/actor 身份由服务端注入；写路径 exact flag gated、事务内 authority、values-free error。
- 学分人工调整使用独立 immutable adjustment SoR，不放宽 automatic ledger 形状。
- 内容课程仅支持 exact legacy video+exam 或 content-only article/external-link；不宣称 mixed assessment+content。
- 不宣称 L0-L6 全完成。title/certificate 后续切片、排行/档案、L5/L6、直播/离线/AI 等继续独立开发。

## 6. 共享面合同

- workflow、Vitest exclude、required-web、domain guard 和 provenance 取严格 UNION，不得以 ours/theirs 覆盖任一父提交测试路径。
- provenance pin 必须在最终树上由官方 helper 重算并正控通过。
- exact-head CI、merge、merged-main CI 是三个不同证据层，不可相互替代。

## 7. 运行与权限红线

- 本轮不启 feature flag，不 dispatch，不 staging，不 deploy，不触碰 production。
- 不读取或写入真实客户数据，不执行外部系统写回。
- branch protection 只在 owner 单独授权下修改；本轮没有该授权。
- Attendance 定时生产策略/保护检查失败属于独立 ops P1，不得由本收口静默修改或宣称解决。

## 8. 完成定义

1. #5328、#5329、#5327 按授权顺序合并，且每步绑定 then-current main。
2. 每个最终 PR head exact-head CI 零 failure/零 pending，独立复审无 P1/P2。
3. 最终 merged-main push CI 零 failure/零 pending。
4. 三份最终 MD 绑定真实 PR head、merge SHA、main SHA 和远端检查；session-local 测试/模型来源必须标为辅助证据，不能单独承重最终 PASS。
5. 所有未实现、UAT、flag、部署和生产边界明确列出。
