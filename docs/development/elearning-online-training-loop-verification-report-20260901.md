# MetaSheet 云课堂线上培训闭环验证报告（2026-09-01）

> 结论：PASS FOR LOCAL DRAFT / HOLD CANDIDATE。
>
> 非结论：不是 Ready、merge、feature flag、deploy、production 或真实用户验收证明。
>
> 被测代码：`60fb5887543dc7302642b5c716e1bd969304ef2c`，tree `7028eda069cf545fe6717b44d1ee2d393f6b619a`。

## 1. Exact-head 文件边界

相对父节点 `65efb1cc26637ec493bd2fa2fe45d571dc8a5290`：

- 新增 1 个真实数据库闭环测试；
- `plugin-tests.yml` 新增 1 个 post-migrate whole-file 参数；
- `vitest.config.ts` 新增对应 no-DB exclude；
- provenance pin 只刷新 `evidenceFiles.pluginTestsWorkflow`；
- 产品源码、Web、OpenAPI、迁移与 feature flag 均为 byte-unchanged。

## 2. 真实数据库门

独立 PostgreSQL 15 scratch 实例：

- fresh 全量 migration：PASS；
- 第二次 migration replay：PASS；
- `elearning-online-training-loop.db.test.ts`：1 file / 2 tests PASS；
- 报名后 assignment member 数量：0；
- 视频完成证据：1；
- 自动评分记录：1；
- 课程结果：completed=true、score=10/10、passed=true；
- 无答案键、解析或私有 explanation 泄漏；
- 缺视频完成证据时，开考拒绝且 attempt 数量为 0。

数据库退出检查：active backends=0、fixture user residue=0、database prefix residue=0；实例停止后目录移入 Trash，DB window 已释放。

## 3. 判别 mutation

- 临时移除 `startElearningExam` 的前置视频完成守卫：负控精确变红；
- 恢复后生产文件 SHA-256 byte-identical，闭环测试 2/2 恢复绿色；
- 移除 no-DB exclude：CI wiring 精确变红；
- 移除 post-migrate whole-file 参数：CI wiring 精确变红；
- 使用旧 provenance pin：provenance 正控精确变红；
- 恢复官方生成 pin 后 frozen/live differenceCount=0。

## 4. 非数据库门

| 验证 | 结果 |
|---|---|
| e-learning 动态 wiring | 15/15 PASS |
| core-backend type-check | PASS |
| sealed-export package provenance | PASS |
| full sealed-export S5 chain | PASS |
| git diff --check | PASS |
| exact-head 四文件反证式审阅 | P1=0 / P2=0 |

## 5. 父产品 PR 状态

父 PR #5426 保持 OPEN、Draft/HOLD、MERGEABLE；本报告形成时 exact head 为 `65efb1cc...`。上一节点的 Node 20 长门暴露了一条旧 scope rollback 测试未逆序卸载新增报名表的问题；一文件 test-only 修复已用相同 FK 错误 mutation 判红并在 fresh/replay 真库恢复绿色。新 exact-head 远端矩阵仍在运行，因此本文不把本地闭环证明扩大为父 PR 的终态远端结论。

## 6. 未验证边界

- 未执行浏览器端真实人工观看、随机挑战点击与考试 UAT；
- 未在 staging 或 production 启用任何云课堂 flag；
- 未验证高级视觉/DOM 自动化对挑战的绕过能力；
- 未验证线下培训、直播、问卷、容量、候补或报名审批；
- 不构成完整 L0–L6 发布验收。
