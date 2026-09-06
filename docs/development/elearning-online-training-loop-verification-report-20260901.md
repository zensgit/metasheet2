# MetaSheet 云课堂最小线上培训闭环验证报告（2026-09-06）

> 结论：PASS FOR LOCAL DRAFT / HOLD CLOSEOUT CANDIDATE。
>
> 非结论：不是 Ready、merge、feature flag、deploy、production 或真实用户验收证明。
>
> 被测代码：`c45194efda7ccc67ca010651989a772edf4704ac`，
> tree `59f6e43a68a2aba2dda25f5c32befa2d8f1d6f13`。

## 1. Exact topology 与文件边界

| 项目 | Exact 值 |
|---|---|
| first parent | #5427 旧 head `1d49c4a50ec371916585121baf213b24de3c32a6` |
| second parent / main | `c02fef470271c2fbd6cd829d38a2bea1991875b9` |
| merge head | `c45194efda7ccc67ca010651989a772edf4704ac` |
| merge tree | `59f6e43a68a2aba2dda25f5c32befa2d8f1d6f13` |

相对 main 恰 6 个文件：

- 新增真实数据库闭环测试；
- `plugin-tests.yml` 增加 post-migrate whole-file参数；
- `vitest.config.ts` 增加对应 no-DB exclude；
- provenance pin 只刷新 `evidenceFiles.pluginTestsWorkflow`；
- 新增本开发报告与验证报告；
- 产品源码、Web、OpenAPI、迁移与 feature flag 均 byte-unchanged。

## 2. 真实 PostgreSQL 闭环门

唯一临时库：`metasheet_ele_training_loop_20260906_01`，本机 PostgreSQL 15。

| 验证 | 结果 |
|---|---|
| fresh 全量 migration | PASS |
| 第二次 migration replay | PASS |
| `elearning-online-training-loop.db.test.ts` | 1 file / 2 tests PASS |
| 结束前 active backends | 0 |
| DROP 后 exact database residue | 0 |
| DROP 后 prefix residue | 0 |

正控串联报名、观看完成、开考、客观题提交、自动判分和成绩回读；负控证明没有服务端视频完成证据时拒绝开考且 attempt 数量保持 0。

## 3. 非数据库门

| 验证 | 结果 |
|---|---|
| e-learning 动态 wiring | 15/15 PASS |
| core-backend `tsc --noEmit` | PASS |
| sealed-export package provenance | 1/1 PASS |
| full sealed-export S5 chain | PASS |
| provenance frozen/live | `differenceCount=0` |
| `git diff --check` | PASS |

新 worktree 初次 typecheck 和 S5 分别因缺少本地 `tsc`、`mssql` 依赖链接中止；复用同仓已安装依赖后，原命令完整重跑并通过。两次均为环境姿态问题，不是测试断言失败，也没有安装或更改依赖版本。

## 4. 结构与安全复核

- 闭环测试仅调用服务端 service authority，不接受客户端 `completed` 或客户端分数；
- 在线报名不会产生 assignment member；
- 考试前置条件依赖服务端 completion evidence；
- 成绩读取使用公开复盘 DTO，不返回答案键、私有解析或 raw snapshot；
- selector 在 no-DB 与 post-migrate 两处闭合，避免 skip-shaped green；
- workflow 变化后 provenance 由官方 `computePackageProvenancePinSet` 重算，唯一漂移字段是 `evidenceFiles.pluginTestsWorkflow`。

本地 exact-range Codex 复核：`P1=0 / P2=0`。没有发现需要扩产品范围才能关闭的问题。

## 5. 仍需完成的发布门

1. 普通 push 更新现有 Draft #5427；
2. 等待新 exact-head 远端矩阵零失败、零 pending；
3. owner 单独授权后方可 Ready/merge；
4. 如需演示，再单独执行浏览器登录后的上传、报名、观看挑战、考试和成绩 UAT；
5. flag 启用、部署和生产数据仍需独立授权。

## 6. 明确不在本次最小收尾范围

新员工自动指派/周报、讲师、学习地图、问卷、线下培训、混培、直播适配器、AI 问答，以及对 OCR/视觉模型的强反自动化保证。
