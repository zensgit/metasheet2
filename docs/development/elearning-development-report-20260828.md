# MetaSheet 云课堂集成开发报告（2026-08-29）

> 状态：DRAFT / HOLD — INTEGRATION CANDIDATE, NOT A RELEASE CLAIM
>
> 设计合同：docs/development/elearning-plugin-design-lock-20260810.md
>
> 已验证代码 checkpoint：15dccfbbecc79b90fc9dc4437f382377d936f71e
>（tree 4692dc234e6fe47bc32757b78ec9335e8ecb5c7e）
>
> 本报告不授权 Ready、merge、启用 feature flag、dispatch、deploy 或 production。

## 1. 本轮结果

本轮把散落的治理、V0.1、人工评分、学分 authority、考试通过奖励、内容策略和限时考试 UX 归并到一个本地候选树。已有用户可达的主链为：

1. 视频上传、服务端探测与受保护播放；
2. 服务端观看进度与 heartbeat 验证；
3. 客观题与简答题考试、保存答卷、限时到期；
4. 客观题自动判分，简答题进入独立人工评分队列；
5. 人工评分幂等重试、409 fail-closed 重拉详情和队列；
6. 仅在 graded + passed 时，于原评分事务内产生 pass_exam 学分 effect。

当前所有云课堂 flags 仍默认 OFF。没有 push、远端 replacement PR、Ready、merge、部署或生产启用。

## 2. 最终候选拓扑

| 层 | exact 输入/提交 | 归并结果 |
|---|---|---|
| 当前主线基线 | origin/main@c479e9b321fe772149e367b5d90cb01c21654766 | 本地 landing 分支父链 |
| 设计治理 | #5150 0985c9aafd... → #5167 cba0d93957... | merge 7ccf6643b6... |
| authority integration | 20ec53f9f15a6eec6376fdf5dd40247ae1552d48 | merge 89d13760fc... |
| C1 document runtime | 原提交 ba7b6d45... | replay 48fc540b0b... |
| C2 mixed content | 原提交 a921f492... | replay 74c3ca5665... |
| publish readiness | 原提交 338e0613... | replay b7c4931574... |
| publish lifecycle | 原提交 dae75a36... | replay f062925d50... |
| #5208 timed UX | 640a4b8c... 的三文件语义移植 | 5f7a24e46e... |
| C selector union | 12 个新增 whole-file unit canary | edd84be214... |
| fix-forward | publish 类型收窄、S3 lint、provenance pin | 24f1d49594...、1381cce7a0...、15dccfbbec... |

主线、治理 head cba0d93957... 和 authority head 20ec53f9f1... 均已机械确认是候选祖先。

authority merge 的两个冲突只涉及 .env.example 与 sealed-export provenance pins。最终保留当前主线 Approval Canvas 语义、云课堂七个默认 OFF flag，并由仓库提供的 computePackageProvenancePinSet 重新生成完整 pin 集。

## 3. 已接入的能力

### 3.1 V0.1 学习闭环

- 课程内容与考试 schema、发布请求、访问范围、指派和学习进度；
- 视频上传、配额、S3/local storage、探测、播放票据和 heartbeat；
- 课程发布事务、学员课程列表和学习中心；
- 客观题自动判分、简答题、答卷保存、考试超时与人工评分；
- 管理端内容/测评页面、学员端观看/考试页面、独立 elearning:grade 评分页面；
- OpenAPI、Web 双点 required selector、后端 whole-file unit/real-DB selector；
- 插件能力、jobs、通知 intent/worker、提醒 producer。

### 3.2 人工评分闭环

最终候选吸收 7854768677...：

- 相同评分 payload 在可重试失败后复用 request id；
- payload 改变或成功收敛后才轮换 request id；
- 409 必须重拉 attempt detail，并从第一页刷新队列；
- 任一刷新失败保留明确错误，不显示伪成功；
- DTO closed-shape，不返回答案键、解析、rubric 或 raw snapshot。

### 3.3 学分 authority 与考试通过奖励

最终候选包含 PostgreSQL 全局 effect identity
(org_id,user_id,behavior,effect_key)、同 payload replay、异 payload values-free conflict、daily-cap bucket 行锁，以及 pass_exam consumer。

只有通过的最终 graded 状态发放，effect key 固定为 attempt identity。这只证明 pass_exam 自动奖励，不等于完整 L4。

### 3.4 C 内容策略与发布事务

已接入 mixed-content publish readiness authority、draft/latest/active lifecycle pointer compare-and-set，以及失败时原事务回滚。

document session/progress、content revision、category、open completion、stats 等 pure/domain runtime 已保留，但 document/article/external-link 仍缺完整 production persistence、adapter、route 和 UI，不能把 C1/C2 称为用户可达的混合内容产品。

### 3.5 限时考试 UX

#5208 未直接 cherry-pick，而是按当前候选语义移植：

- 倒计时和服务端 deadline；
- attempt_expired 锁答卷并刷新权威状态；
- draft save、start、submit 的 epoch 竞态保护；
- 保留 awaiting_manual 禁止重复开考；
- 学员端 61 个测试全部通过。

## 4. Selector union

| 测试面 | 磁盘文件 | 未选择 |
|---|---:|---:|
| backend e-learning unit | 61 | 0 |
| backend e-learning real-DB | 28 | 0 |
| Web e-learning specs | 6 | 0（web guard 与 required-web 均为 0） |
| plugin e-learning tests | 10 | 0 |

C replay 新增的 12 个 unit 文件已作为纯并集写入既有 elearning-v01-unit-canaries；没有删除当前主线、Time Machine 或既有云课堂 selector。

## 5. PR 与 supersede 边界

2026-08-29 已登记 census 包含 79 个云课堂相关 PR：39 个已经位于 authority candidate 祖先链，40 个不在其祖先链。这个数字只用于治理去重，不证明功能完成或 CI 合格。

- #5150 与 #5167 是独立治理合同，继续保留，落地顺序固定为 #5150 → #5167；
- #5208 的产品语义已移植，但 replacement 候选形成前不自动关闭；
- #5262/#5265 与本地 B test/B-AWARD 已被 authority integration 吸收；
- #5292–#5296 由 C1 replay 吸收；
- #5298–#5304 由 C2 → readiness → lifecycle replay 吸收；
- #5266–#5304 中未进入上述祖先/重放链的 pure-policy、L5、L6 PR 继续 Draft/HOLD；
- 旧 PR 状态在本轮未修改。

只有 replacement Draft PR 建立、exact tree/ancestry 与 CI 复核后，才可按映射逐项标注 superseded。

## 6. 明确未完成

### L4

- credit rule 管理与版本/退役 API/UI；
- 学员钱包、个人流水、管理范围内查询；
- 人工正负调整 authority；
- 头衔 SoR、阈值管理和个人展示；
- 证书模板、序列号、不可变颁发台账和渲染。

### L5

- 抑制后的统计投影、部门运营页和导出；
- portal 配置 SoR/UI；
- 讲师/等级/profile；
- 新员工自动指派与周报的真实 event/job consumer。

### L6

- 防挂机 challenge、学习地图、线下培训、问卷、混培、直播适配器和 AI grounding 的真实 SoR→API→UI；
- 独立扩展 flag 与端到端验收。

## 7. 模型贡献边界

- Codex：本轮 authority integration、B-AWARD/CI 归并、C replay、#5208 语义移植、exact-head 验证与报告；
- Kimi：此前 credit authority 和 test-only child 的 refute-first 审阅；其 P2 daily-cap race 缺口已由 B-test 关闭，P3 仍保留；
- Claude Fable 5：#5150 首个设计合同提交 e54121b5785b5696f0d39faf14acb45870a46eb3 的可核实 co-author，仅属于治理/设计贡献；
- 当前运行环境没有可调用的 Fable 入口，因此本轮实现没有虚构 Fable 执行记录。

## 8. 下一步落地顺序

1. 独立 refute-first 复核本地 final candidate；
2. 获得协调授权后 push 一个 Draft/HOLD integration PR，不新开 pure-policy 栈；
3. exact-head CI 复跑 unit、Web、plugin、OpenAPI、provenance 与 real-DB；
4. replacement ancestry 清晰后再处理旧 PR；
5. 下一实现只开纵向能力：优先 L4 rules + wallet，再做 adjustment/title/certificate；
6. flag、部署和 production 仍需单独 owner 授权。

---

## 9. 2026-09-05 successor addendum：在线报名与 raster-v2 观看验证

> 本节是后续实现的增量记录。上文绑定的 `15dccfbbecc79b90fc9dc4437f382377d936f71e`
> 历史 checkpoint、测试数字与当时边界保持原样，不由本节追溯改写。

### 9.1 产品增量

- 在线报名只为当前可见的自学课程追加不可变报名意图与范围快照；不产生指派、截止、催学、学分或完成状态。
- 观看验证仍由服务端调度与确认。挑战题升级为 `raster-position-v2`：服务端使用固定 `360×260` 画布生成 PNG，六个选项随每次挑战重新排列；客户端只接收 PNG、固定尺寸、opaque option id 与点击矩形。
- 目标、标签与正确顺序仅保存在服务端不可变事件快照中。公开 DTO、OpenAPI 和 DOM 不再包含可直接连接的“目标文本 → 答案 id”结构化映射。
- 前端以六个原生按钮覆盖点击区域，桌面与窄屏均完成真实图片与点击矩形对齐验证。
- 这只证明消除了公开的结构化答案连接，并提高固定坐标脚本的成本；不宣称抵抗 OCR、视觉模型或所有自动化，也不宣称本切片提供了非视觉等价挑战。
- `ELEARNING_ENROLLMENT_ENABLED` 与 `ELEARNING_WATCH_CHALLENGE_ENABLED` 继续默认 OFF。本节不授权 Ready、merge、启旗、dispatch 或部署。

### 9.2 Exact topology

| 项目 | Exact 值 |
|---|---|
| PR | `#5426`（Draft/HOLD） |
| code base | `70dc72d7671cad9cea1925ed93f90d3d9c746aeb` |
| code head | `408e61411688bfd8f994f5e50998e2566b78ef4f` |
| code tree | `7591090a91e6f28fc9de54bf54970513e53880c2` |
| true-merge parents | first `7e28ff30a449484522e536c319a1b7071a4eb749`；second `70dc72d7671cad9cea1925ed93f90d3d9c746aeb` |

first-parent 到 merge 的四个文件是主线新增的备料/required-web 增量；second-parent 到
merge 是完整的 53 文件云课堂候选。required-web 路径 token 对两个父提交均为严格并集，
`missing=0`；sealed-export provenance 的 frozen/live `differenceCount=0`。

本节随后以独立 report-only child 提交。该文档提交不改变上述 code head 的产品、测试、迁移、
OpenAPI 或 shared selector 字节；文档 child 的 CI 只验证“报告载体 + 同一代码树”，不能把其
SHA 冒称为新的产品实现 checkpoint。
