# MetaSheet 云课堂最小线上培训闭环开发报告（2026-09-06）

> 状态：DRAFT / HOLD — CODE COMPLETE, FLAGS OFF, NOT DEPLOYED。
>
> 产品基线：`origin/main@c02fef470271c2fbd6cd829d38a2bea1991875b9`。
>
> 本地闭环验证代码节点：`c45194efda7ccc67ca010651989a772edf4704ac`，
> tree `59f6e43a68a2aba2dda25f5c32befa2d8f1d6f13`。
>
> 本报告不授权 Ready、merge、启用 feature flag、dispatch、deploy 或 production。

## 1. 收尾范围

按“只做最简单需求”收敛为一条线上培训闭环：

1. 管理员上传并发布视频课程与客观题考试；
2. 员工在可见课程中在线报名，或由管理员指派；
3. 服务端累计有效观看进度；
4. 播放过程中由服务端下发随机位置验证，正确响应后才继续累计；
5. 视频达到完成策略后才能开始考试；
6. 服务端自动判分，员工可查看成绩与通过状态。

本次不再扩展新员工自动指派、讲师、学习地图、问卷、线下培训、混培、直播、AI 问答等 L5/L6 能力。

## 2. 已在 main 的产品能力

- 视频上传、MIME/魔数校验、配额、探测、受保护播放票据；
- 发布版本、可见范围、直接/批量指派、在线报名；
- 服务端 watch session、heartbeat、完成证据与考试前置条件；
- `raster-position-v2` 观看挑战：服务端生成 `360×260` PNG，候选位置每次随机；公开 DTO 和 DOM 不暴露目标文本到答案 ID 的结构化映射；
- 客观题考试快照、答卷提交、自动判分、成绩复盘；
- 管理端与员工端 Web 页面、OpenAPI、后端/Web/真实数据库 selector。

观看挑战只提高固定坐标脚本和简单 DOM 自动化的绕过成本；不宣称抵抗 OCR、视觉模型或所有 AI 自动化，也不采集人脸、摄像头、麦克风或生物特征。

## 3. 在线报名语义

报名是当前用户对可见自学课程的不可变审计意图，不等于指派：

- 不产生必修义务、截止时间、催学或容量占用；
- 不创建 assignment member；
- 可见范围收缩后不会凭报名恢复访问；
- 相同 requestId 与相同载荷重放原结果，异载荷返回 values-free 冲突；
- org、user 与时间由服务端权威上下文产生。

## 4. 本次新增的闭环证明

新增真实 PostgreSQL 集成测试 `elearning-online-training-loop.db.test.ts`，在同一数据库上串联：

`可见课程 → 在线报名 → 无指派确认 → 开始观看 → 服务端完成证据 → 开考 → 提交客观题 → 自动判分 → 成绩回读`

负控同时证明：缺少服务端视频完成证据时，开考以 `prerequisite_incomplete` 拒绝，且不会创建考试 attempt。

## 5. 发布边界

- 所有云课堂 flags 继续默认 OFF；
- 未执行 staging/production 启用或真实租户数据访问；
- 未执行真实浏览器人工 UAT；
- #5427 仍是 Draft/HOLD 收尾 PR，需 exact-head CI 全绿和 owner 单独授权后才可合并；
- 功能合并与生产可用是两件事：生产演示至少还需要一次登录后的浏览器验收与独立启旗/部署授权。
