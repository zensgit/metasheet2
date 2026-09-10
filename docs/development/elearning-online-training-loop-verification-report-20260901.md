# MetaSheet 云课堂最小线上培训闭环验证报告（更新于 2026-09-07）

> 结论：**PASS FOR MERGED SOURCE CLOSEOUT**。
>
> 非结论：不是 feature flag、staging、deploy、production 或真实用户 UAT 证明。
>
> 当前核对基线：`origin/main@2ba43e2d28fbe0fdb8961fa5af54abadb81ef608`。

## 1. 已合入证据

| 切片 | PR head | merge commit | 结果 |
|---|---|---|---|
| 最小线上闭环 | `f6082221e2e1a46824f4f82b850f2550e8d21011` | `98f2ee8a2850617f6bcf6785ccdc09ccd270b270` | MERGED |
| 观看挑战发布接线 | `0c48cc891e0daf1c8984166927e1d5b31f7c5bf2` | `605b08af567b5cf121a485579871bcf49186446f` | MERGED |
| 多维表统计投影 | `00e4d7d31f5379821b6dece9bda12c814cb1925c` | `5958b3cdb2d2f0505d5a9ca8a2c932a4dedafe90` | MERGED |

#5520 合并前 exact-head 矩阵为 `27 SUCCESS / 1 intentional SKIPPED / 0 failure / 0 pending`，PR 状态为 CLEAN/MERGEABLE；独立 Grok 4.6 exact-head 复审结论为 `P1=0 / P2=0 / P3=0`。Codex 随后复核 exact head、工作树、main 零交集漂移和完整 check rollup，再按 owner 授权合并。

## 2. 线上培训真实 PostgreSQL 闭环门

`elearning-online-training-loop.db.test.ts` 在同一数据库串联：

`可见课程 → 在线报名 → 无指派确认 → 开始观看 → 服务端完成证据 → 开考 → 提交客观题 → 自动判分 → 成绩回读`

| 验证 | 结果 |
|---|---|
| fresh 全量 migration | PASS |
| 第二次 migration replay | PASS |
| 闭环文件 | 1 file / 2 tests PASS |
| 缺少服务端完成证据时开考 | `prerequisite_incomplete`，attempt 数保持 0 |
| 结束前 active backends | 0 |
| DROP 后 exact/prefix database residue | 0 / 0 |

该门只接受服务端 completion evidence 和服务端判分结果，不接受客户端声称 `completed` 或客户端上传分数。

## 3. 观看验证门

- 发布时把挑战策略与课程版本绑定；
- 服务端按观看进度下发随机候选位置挑战；
- 挑战未正确确认时暂停后续有效时长累计；
- DTO/DOM 不提供目标文本到答案 ID 的结构化映射；
- 能力受 master、CONTENT、MEDIA 与 WATCH_CHALLENGE exact-true 多重门控制，默认关闭。

## 4. 多维表统计投影门

- 专用学习表保持 SoR，多维表只作单向、只读、可重建的聚合投影；
- 小样本阈值固定下限为 5，被抑制行不含数值；
- 个人答案、原始轨迹及个人成绩不进入系统 base；
- 稳定 base/sheet ID 的抢占、改名、删除、恢复与同 base 新建 sibling sheet 均被阻断；
- 正常视图、图表和导出仍可使用；
- reconcile 失败行公平轮转，相关真实数据库套件 8/8 PASS；去除 defer 逻辑的 mutation 精确变红；
- 相关单元测试 131/131 PASS，三项投影身份保护 mutation 均精确变红。

## 5. CI 与合并后状态

- #5520 的 Node 18、Node 20、coverage、Web、migration、multitable real-DB 及相邻跨域 required checks 全部成功；
- merge commit `5958b3cd...` 的 main-push workflows 全部 terminal SUCCESS；
- 名为 `Deploy to Production` 的 workflow 只执行 test job，`build-and-push` 与 `deploy` 均 SKIPPED；
- Docker workflow 的 build job 成功，实际 `deploy` job SKIPPED；
- 没有 dispatch、没有启用云课堂 flag、没有 staging/production 部署。

## 6. 结构与安全复核

- 在线报名不会创建 assignment member，也不会绕过当前可见性；
- 考试前置条件依赖服务端完成证据；
- 成绩读取使用封闭公开 DTO，不返回答案键、私有解析或 raw snapshot；
- 多维表投影不成为第二学习真相，也不能反向修改 SoR；
- selectors 在 no-DB、post-migrate 和 Web required lanes 中闭合，避免 skip-shaped green；
- workflow 变化后的 provenance 使用官方 helper 重算并保持 frozen/live `differenceCount=0`。

## 7. 尚未证明的运行门

1. 测试环境独立启用所需云课堂 flags；
2. 登录后的浏览器验收：上传、发布、报名、挑战、完成、考试、分数和统计视图；
3. 部署版本与预期 commit 的运行时一致性；
4. 真实租户的数据隔离与操作验收；
5. 任何生产启用或真实外部服务访问。

因此准确结论是“最小线上培训闭环源码及统计投影已合并并通过自动化门”，而不是“生产已经可用”。

## 8. 模型与验证来源

- Codex：合同核对、唯一 writer、定向测试/判别 mutation、exact-head/CI/合并后复核；
- Grok 4.6：#5520 exact-head 独立只读 refute-first 复审，结论 `0/0/0`；
- PostgreSQL 15：闭环、投影、迁移 replay、并发及 residue 证明；
- GitHub Actions：PR exact-head required matrix 与 merge commit 的 post-main workflow 证明。

未获得 terminal verdict 的模型不计入验证来源；本报告不以模型意见替代数据库或 CI 证据。
