# MetaSheet 跨域收口验证报告（2026-08-30）

> 状态：PASS WITH EXPLICIT RUNTIME BOUNDARIES。代码、PR exact-head 和 merged-main 证据均已终态；本报告不替代运行/UAT/部署授权。

## 1. 证据分层

1. LOCAL-EXACT：候选工作树、focused tests、mutation、DB scratch 与独立模型复审。
2. REMOTE-EXACT：PR head 对应全部 required/adjacent contexts。
3. MERGED-MAIN：merge SHA 后的 main push workflows。
4. RUNTIME/UAT：staging、真实租户、flags、deploy；本轮均未执行。

最终 PASS 只由可独立复核的 Git ancestry/tree、三个 PR exact-head check rollup 和 merged-main check rollup 承重。下面的 focused test、DB、mutation 和模型结果是 session-local 辅助证据：其摘要保存在 [#5328](https://github.com/zensgit/metasheet2/pull/5328)、[#5329](https://github.com/zensgit/metasheet2/pull/5329)、[#5327](https://github.com/zensgit/metasheet2/pull/5327) 的 PR body/协调记录中，但不是独立不可变 CI artifact，也不单独决定最终判定。

## 2. Time Machine

- #5328 exact head `a4cd6ad...`：26 SUCCESS + 1 intentional skip，Luna 0/0/0。
- merge `f5ef242f...` 已进入 main；post-main push workflows 成功。
- scheduled Attendance strict/prod 失败不是 #5328 代码 CI，也未被本轮修改。

## 3. 审批与流程自动化

- #5329 exact head `4e9145a...`：22 SUCCESS + 1 intentional skip。
- session-local：wiring 3/3；focused 301；Chromium 35/35；required-web 406 files / 5161 tests；typecheck/diff-check。
- mutation：Canvas snapshot、legacy PATCH stale response、cross-type props、stale attachment generation/context、browser API fail-loud。
- session-local review：Terra 0/0/0；最终 replay/race fix Luna 0/0/0。GitHub 的 [Codex review-completion comment](https://github.com/zensgit/metasheet2/pull/5329#issuecomment-5466459354) 是单独的远端流程锚点。
- merge `95527268...` 已进入 main；post-main push workflows 成功。

## 4. 云课堂 LOCAL-EXACT（辅助证据）

- replay head `7fb67e65ade5c2b8b1648f6230059c1dc1c653a8`，parents=`06de056a...` + `46828d5e...`，worktree clean。
- backend unit：14 files / 151 tests。
- Web：9 files / 176 tests。
- e-learning wiring：15/15。
- provenance positive 与完整 sealed-export S5：PASS。
- stock-prep permission matrix：PASS；source-discovery：25/25。
- OpenAPI focused/build/guard 在 first-parent replay 上 PASS；相对 Cloud parent `06de056a...`，最终 merge-resolution 没有改变七个 Cloud OpenAPI blobs。相对 main parent，七文件是 #5327 的预期产品增量。
- DB authority：fresh 376 migrations + replay；legacy 40/40 + content 6/6 + adjustment 11/11 = 57/57；scratch/backends/prefix residue=0。
- replay delta Luna read-only session `01a050ff-8c24-77f0-a055-5cf5b6469900`：P1=0 / P2=0 / P3=0。该 session ID 用于来源追踪；最终判定仍以第 5、6 节远端事实承重。

## 5. 云课堂 REMOTE-EXACT

- PR #5327 exact head `7fb67e65...`。
- checks：47 SUCCESS + 1 intentional skip，0 pending/failure。
- PR 在 `MERGEABLE/CLEAN` 且 main 未漂移时按 owner 授权合并。

## 6. MERGED-MAIN

- main/merge SHA：`1775686cb087bcb4ded8b8b1f3ca0f85ab4d6db4`。
- tree：`a5d3e8a8aafbb7e56017198041ec5f0a03072bc9`。
- 40 check-runs：36 SUCCESS + 4 expected SKIP，0 pending/failure。
- Plugin System Tests run `33294788916`：Node18/Node20、after-sales、K3、DingTalk、stock-prep 均 SUCCESS；coverage 为 expected SKIP。
- 远端锚点：[Plugin System Tests run 33294788916](https://github.com/zensgit/metasheet2/actions/runs/33294788916)。
- 其余 expected SKIP 为 deploy/build-and-push 路径；没有 dispatch 或 production deployment。

## 7. 未通过本报告验证的事项

- 任何 flag enablement、workflow dispatch、staging、deploy、production。
- 真实客户数据、真实租户 UAT、外部系统写回。
- Time Machine 对象存储/KMS 与真实进程重启。
- 审批 after-sign 等未 ratify 能力。
- 云课堂 L0-L6 全完成声明。

## 8. 独立 ops 边界

- Attendance Branch Policy Drift (Prod)、Attendance Branch Protection (Prod) 和相关 dashboard 的 scheduled/dispatch 失败保持独立 P1。
- 它们不等同于本轮 PR push CI 失败，但在 owner 未授权 branch-protection/production 操作时不得修复或宣称关闭。

## 9. 最终判定

`PASS WITH EXPLICIT RUNTIME BOUNDARIES`。

该判定由第 5、6 节远端 exact-head/merged-main 事实与 Git 拓扑支持，只覆盖本锁列明的代码、迁移和选择器；第 2–4 节 session-local 证据用于增强可解释性而非单独承重，第 7、8 节边界保持开放且未被本轮授权改变。
