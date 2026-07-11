# 考勤导入 section 体验（勾选生成模板 + 一键下载 + 常用/高级分组）验证报告 — 2026-07-06

> PR #3708（`claude/attendance-import-section-layout-20260706`）。design-lock:
> `attendance-import-section-ux-design-lock-20260706.md`（RATIFIED，owner 两次拍板：
> "同意"立切片 + "客户可以选择相应的字段来产生列名么"→ 勾选生成）。
> 状态：✅ MERGED（squash `138cd1632`，2026-07-06）。双审：opus 对抗审阅 v2 **APPROVE 0 P1/P2**（3 P3/6 NIT；P3-1+NIT 已硬化入 `3065f28bc`）。

## 1. 起因

客户 xlsx 报障同一导入页的三个体验缺口：支持列不可见（接口返回的 60+ 列词汇被前端丢弃，
客户被迫猜列名）、模板不可发现（下载按钮灰、需先点加载且无解释）、核心动线被 16 平铺字段淹没。

## 2. 落地内容

| 决策 | 内容 |
|---|---|
| D3 勾选生成模板 | 共享模块 `importTemplateColumns.ts`（语义分组/别名去重/中文优先）；勾选卡：7 组 checkbox（含义悬浮）+ 必填列锁定 + 实时表头预览 + 下载所选列/复制表头/全选/恢复默认 |
| D2 一键下载 | 旧壳补齐 composable 水位：未加载自动 load 再下载；**payload 保护护栏**（仅 ''/'{}' 才自动 load，手编内容分字节保留 + 可操作报错） |
| D1 常用/高级分组 | 常用 4 字段 + 高级折叠区（12 项含负载 JSON），已配置计数徽标，非默认自动展开；`v-show` 保 DOM 常驻 |
| D4 | 新样式全 UF `--ms-*` tokens；既有 id/label/copy/testid 零改动 |

## 3. 验证证据

- **闭环实证（G2）**：全选生成的 33 列表头喂回后端真实别名表——逐列全识别、表头检测（姓名+日期）满足、upload 严格检查命中；英文-only 近重复 target（leave_hours/overtime_duration）排除后生成表头**纯中文**（不变量测试锁死）。
- **词汇完整性（G1）**：对照后端 `IMPORT_MAPPING_COLUMNS` 全集，补 `resignTime`；其余缺席均有意（身份列=锁定基础列；同源重复去重）。
- **G4 行为变更护栏**：一键 auto-load 覆写 payload 的风险被护栏挡住，挂载测试锁（手编 payload → 零 template 请求 + 内容不变 + 报错）。
- 测试：单测 7（分组/去重/中文优先/表头组装/纯中文不变量）+ 真挂载 5（勾选驱动预览与下载/冷面板一键/payload 护栏/高级折叠切换）；双 mutation 证明（摘 auto-load → 红；短路表头组装 → 5 红）；web-guard 全家 14 spec / 329+ 测试绿；`vue-tsc -b` 干净。
- 对抗审阅（opus v2）：**APPROVE 0 P1/P2**。R1 勾选 wiring/`v-show` 经全套件真跑+新 mutation 验真锁；疑似回归 `attendance-import-batch-timezone-status.spec`（非 guard 内 5 红）base 对照证伪=既往失败；R5 两刀自选 mutation（toggle 中和/折叠默认翻转）均红后复绿。
- P3-1 硬化（`3065f28bc`）：fixture-sync 测试读真实后端源（`IMPORT_MAPPING_COLUMNS`+首 profile `templateColumns`），断言前端默认勾选集合 == 后端起步模板集合——后端改模板列即红，杜绝静默漂移；NIT：下载 DOM 清理入 `finally`。

## 4. 边界与 follow-up

- **列识别回显**（选文件当场绿/灰/红对照词汇表）= 下一独立 opt-in 切片（锁 §3 OUT）。
- 自定义映射 CRUD / 自定义字段落库进报表 = 另立锁。
- ~~R3 默认集漂移~~：已由 fixture-sync 测试锁死（见上）。P3-2（onMounted 自动展开无测试，UX-shaped 无害）/P3-3（两下载键列序差异=D3 明示设计）按审阅判定不追加。
- 后端零改动；orphan Section 的勾选卡接入随其挂载切片走（共享模块已就绪）。
