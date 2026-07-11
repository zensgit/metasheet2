# 考勤导入列识别回显 design-lock — 2026-07-06

> **Status: RATIFIED（承 owner 2026-07-06 拍板链：排版切片"同意" + "客户不知道都有哪些列名可以导入"
> + 勾选生成方向确认；本切片 = 同主题第三刀，goal-pool 固定节奏项。）**
> 纯前端 display-only；后端零改动。选文件当场回显：绿=已识别会导入 / 灰=不识别将忽略（仍可用于规则）/
> 红=缺必填列——覆盖"钉钉导出客户"的真实动线（他们不手工造表，拿现成导出直接传）。

## 1. 机制（与后端逐字对齐）

- **表头解析**：客户端读所选 CSV 头部（≤128KB，`Blob.text()` + `FileReader` 兜底，同 xlsx 护栏模式）；
  quote-aware 按当前分隔符切首个非空行（尊重「CSV 表头行」高级设置）；剥 BOM（对齐后端 `normalizeCsvHeaderValue`）。
- **识别词汇**：绿判定 = 归一化后命中 `mapping.columns` 的 sourceField（词汇缺失时静默拉一次
  `/api/attendance/import/template` **只存 `mapping.columns`**——绝不触碰 payload/mode/profiles，
  区别于 `loadImportTemplate`；拉取失败降级为仅必填检查）∪ 日期族 ∪ 上下文键族。
- **必填检查**：镜像后端 `IMPORT_HEADER_DATE_KEYS`（日期/date/workdate）与
  `IMPORT_HEADER_CONTEXT_KEYS`（17 键）+ `normalizeImportHeaderLookupKey`（trim→lowercase→去空白/下划线/连字符）；
  **fixture-sync 测试直读后端源码断言两键族与归一化行为一致**（复用 #3708 P3-1 模式，防静默漂移）。
- 新共享纯模块 `apps/web/src/views/attendance/importHeaderRecognition.ts`；接线 live 旧壳
  `handleImportCsvChange`（xlsx 护栏放行后异步分析，不阻塞选择；文件清空/被拦时清空回显）。

## 2. UI

CSV 文件字段下方全宽面板（`data-testid="attendance-import-recognition"`）：红警示条（缺日期列/缺人员列，
文案给修复指引）→ 绿 chips（已识别，悬浮显示落点含义）→ 灰 chips（将忽略，提示"可用于规则匹配"）。
样式全 UF `--ms-*`（success/danger/text-3/border-light）。

## 2b. v1 已知限制（对抗审阅 2026-07-06 判定：display-only、偏"多报警"安全侧、不阻断）

- **显式表头行 + 前导空行**：前端按全部行计数，后端 `iterateCsvRows` 丢弃单字段空行——双重命中（手填表头行且文件有前导空行）时行号语义可能错位；后端自身三条 header 路径也互不一致，v1 不追求完美镜像。
- **绿 chip 语义 = 后端诊断（normalized）而非精确导入（exact）**：上下文键族里的英文 target 名（如 `firstInAt`）通过表头检测但不经 `applyFieldMappings` 落字段——chip 悬浮语义区分「将作为记录字段导入」vs「用于表头识别/人员匹配」以避免过度承诺；行标签为「已识别」而非「将导入」。
- 分隔符取首字符（镜像后端 `delimiter[0]`）。

## 3. 边界（OUT）

- composable/orphan Section 的面板渲染：共享模块已就绪，随 Section 挂载切片走（同 #3708 D3 决策）。
- 编码嗅探（GBK 等非 UTF-8）：v1 UTF-8-only（与既有导入读取一致）；错位乱码列自然落灰+缺必填红，不误绿。
- 服务端预检端点 / 大文件流式：不需要（头部 128KB 足够）。

## 4. 测试契约

1. 单测：解析（引号/BOM/自定义分隔符/表头行序号/前导空行）、分类（绿/灰/缺日期/缺人员）、
   **fixture-sync**（后端 DATE/CONTEXT 键族逐项相等 + 归一化样本行为一致）。
2. 真挂载：选含「姓名,日期,加班小时,自定义列」的 CSV → 面板出现、加班小时绿、自定义列灰、无红条；
   选缺「日期」的 CSV → 红警示；xlsx 被护栏拦截时**不**出面板。
3. Mutation：中和识别函数 → 挂载测试红；还原复绿。新 spec 进 web-guard run-list + 双 path-filter。

## 5. 完成口径

实现 → opus 对抗审阅 0 P1/P2 → 三红线 → 验证 MD。FE 串行车道。
