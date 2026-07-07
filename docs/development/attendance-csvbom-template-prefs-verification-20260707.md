# CSV 乱码修复 + 勾选记忆（PR-A/B）验证报告 — 2026-07-07

> 三单全 MERGED：#3776 BOM（`64f1b462d`）/ #3778 记忆后端（`068c2d18d`）/ #3782 记忆前端（`10a223e39`）。
> 锁：import-section-ux lock §6 修正案（BOM）+ attendance-import-template-prefs lock（记忆，RATIFIED）。

## 1. #3776 CSV 下载乱码（客户报障）

Excel 对 BOM-less UTF-8 CSV 按 ANSI/GBK 猜编码（WPS 自动探测故正常）。共享 `withCsvBom`
（FE `csvExport.ts` + 插件后端同名）覆盖 **FE 4 + import composable 2 + batches composable 2 +
后端 5** 共 13 个下载出口；导入/上传 payload 不动（解析侧四道剥 BOM，往返安全）；幂等。
审阅（opus）CHANGES-REQUESTED 双 P2 修毕：**P2-1 `Response.text()` 按规范剥 BOM**——批次导出
server 分支后端加的 BOM 到不了文件，前端必须重加（可注入边界内，spy 直接锁）；P2-2 后端零覆盖
→ 新路由级套件收**原始字节**断言 `EF BB BF`（template.csv 有直链消费方），挂 plugin-tests.yml，
新库实跑 + 后端 mutation 红绿。web-guard 16 spec / 375 绿。

## 2. #3778/#3782 勾选字段·用户级记忆（owner 拍板：跟用户走、换浏览器不丢）

- **后端**：`attendance_import_template_prefs (PK org+user)` 只存 targetField 键；GET/PUT 导入权限门内；
  **actor 恒 token `req.user`**（有意绕开带 x-user-id 回退的旧 helper——personal-views §7 Q1 反模式）；
  校验 64 键/单键 128 字符/trim 去重；`[]`=清档。审阅 APPROVE 0 P1/P2（G1 actor 语义逐层实证 +
  六刀 mutation；金测试：**A 带伪造 body.userId=B 保存 → 行仍落 A**），真 DB 路由级 6/6。
- **前端**：加载模板即恢复（**选择集层面**与当前词汇交集，幽灵键不隐形残留——mutation 曾揭穿
  preview 层弱守卫后改 SET 层断言）；勾选静默保存；恢复默认清档。审阅 APPROVE 0 P1/P2；
  P3 双加固：generation token（迟到 restore 不覆盖手动勾选）+ last-write-wins PUT 队列
  （3 连点=恰 2 请求含最终集），均可控 resolve 测试 + mutation 锁死。

## 3. 过程教训（复发确认）

mutation 还原时误用 `git checkout --` 冲掉未提交加固代码（本会话第二次）——重放后**立即提交**。
纪律强化：mutation 前先 commit 承重代码，还原一律用精确字符串反向替换、绝不 checkout。

## 4. Follow-up（gated）

prefs 的 org 维度目前依赖 `getOrgId` 先例（web 侧未传 orgId 时两端收敛 DEFAULT_ORG_ID，审阅证实
当前无 bug）——多 org UI 真出现时补显式传参；localStorage 离线缓存不做（服务端已覆盖需求）。
