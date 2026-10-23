# 考勤报表日期入口与局部响应归属（#5964）

Base main: `4c78e75a0d1a96743c0b5b0ee9c8e8f059e99e3d`. Stacked dependency: unmerged #6493, parent `1aa419c03d6c8febaed248f072c40e1557be502a`. Branch: `codex/dingtalk-report-range-20261022`. Keep Draft; do not merge.

## 日期与入口契约

报表 UI 两端必填；原始输入必须为严格 YYYY-MM-DD 且为真实公历日，不接受空白、日期时间、宽松补零或月日溢出；起日 <= 止日，同日允许。缺失、无效日、倒序分别反馈。非法日期摘要复用“区间未设置”，不通过 Date 溢出归一化展示虚构日期。backend 可选日期兼容契约不变。

顶部报表刷新、申请报告卡重载、记录翻页、CSV、XLSX、reports mode 的组织变化 refreshAll 都在清数据、重置/递增 page、HTTP 之前校验。入口直接调用也受保护，不以按钮 disabled 作为唯一 guard；被拒绝不得显示重载/导出成功。现有有效记录时区可用时，预设必须能修复当前非法输入，不增加 invalid-range 禁用条件。

## 响应归属契约

局部 summary/records/request-report 请求捕获查询范围、输入代际和该 loader 的序号；输入经历 A→B→A 也使 B 失效；同范围分页以最后发起的请求为准；局部翻页在 A→B→A 后被取消时，恢复实际已显示页与其 loadedHistoryScope，完整原快照仍可导出，不将正常分页永久判 stale。旧失败不得清除新成功或覆盖其状态/loading。

保留 #6493 整批捕获的 query key、pristine 记录时区对齐与手动编辑正控：活动整批的旧范围数据允许作为明确 stale 的完整快照与时区上下文，不能被标成手动编辑后的新范围。整批自身另有序号及开始时的局部读取代际，新批次或较新的局部读取优先；失败或被取代的子请求不能被外层静默包装成成功。旧批次已完成两个子请求、剩余 summary 迟到失败，也不得清除其后成功的局部卡片或覆盖状态。refreshAll 的三个报表子请求已全部成功、但 requests/holidays 等辅助 promise 尚未结算时，较新的局部读取同样使旧整批外层失去发布/清数据/错误状态归属；只给 reports 批次的 holidays 吞错状态增加相同保护，不改非报表业务加载行为。跨范围局部读取使完整数据集失去导出资格，只有完整成功刷新才能恢复 fresh；不得回到旧输入就把混合/已清空数据判 fresh。

只修改报表 loaders/校验/调用入口和归属，不扩大共享业务写入器。不改权限、backend、scheduler、#6493 日历算法、时区推断或外部协议。

## 验收 gates

| Gate | 必需证据 |
|---|---|
| 严格日期 | 空/半空/空白/格式/闰日/月末/顺序负向，同日与正序正控 |
| 所有入口 | mounted 顶部/申请卡/翻页/两导出/组织自动刷新，拒绝前无 HTTP、不清旧数据、不跳页、无假成功 |
| 预设修复 | 非法手动范围仍可由有效记录时区预设修复 |
| 局部归属 | A→B 请求→A、旧失败晚于新成功、同范围分页竞争 mounted deferred-response |
| 整批兼容 | #6493 calendar-view 手动编辑/时区对齐正控保留，旧批次不得覆盖新成功 |
| 有效行为 | 刷新/分页/CSV/XLSX mounted 正控 |
| Mutation | 逐个关键入口/归属 guard 产生对应 named assertion RED，再恢复 |
| 邻居与门禁 | calendar/analytics/locale/XLSX；新 spec 同时加入 attendance workflow 与 required script/tokens，UNION 保留原项 |
| UI | 文案变化用真实组件合成截图，全部 API mock、零外部 IO，记录 style 来源 |

## Verification evidence

| Gate | Result |
| --- | --- |
| Original contract reproduction | 23 assertion failures with 9 controls; failed setup attempts are excluded |
| Explicit owner interleavings | Three named failures for cancelled pagination ABA and old completed children followed by newer local success; outer auxiliary-request review reproduced five named failures with one control |
| Final mounted/helper/neighbors | Seven files, 131/131 passed, zero skipped, after all mutations and the erased test-only typing correction |
| Guard mutations | 13 control groups, 38 named assertion failures; filtered cases excluded; all source bytes restored |
| Required wiring | 63/63 structural checks; preserves 514 prior exec selectors plus the new spec (515) and 617 prior union tokens plus the new spec (618) |
| Quality | pnpm validate:all exit 0; explicit new-helper/spec ESLint and strict focused Vue type check exit 0 |
| UI | Three actual-component synthetic screenshots, existing application styles, zero external IO |
| Full required web | Pending on the integrated head |
| Exact-head required CI | Pending; no queued/running/skipped check counts as success |

The issue's old `reloadRecordsWithStatus` entry no longer exists on current main.
The existing records card has paging; both actual paging directions are tested.
No missing button or obsolete function is recreated.

Root lint has a legacy explicit file list; the separate focused lint check covers
the new helper/spec. The first focused type attempt is retained: private Vue
setupState required a narrow documented test type, and the artifact-only config
needed ES2021.Intl for existing imported code. No strict check or unrelated
production file changed. The post-root test typing produces byte-identical JS;
all product and gate hashes remain those verified by root quality.

Evidence is retained under artifacts/report-range/: restored-final-focused,
controls, extra-controls, source-hashes, quality-source-coverage,
spec-type-erasure-proof, dependency-provenance and UI proof files. Earlier
controlled interruptions (exit143), fixture/setup and browser harness failures
are retained separately and are not claimed as successful verification.

Parent incorporation requires another structural/token check and exact-head CI;
full-web remains pending until terminal success. No backend API, optional-date
contract, permission, scheduler, dependency or flag change. No migration,
deployment or real UAT. Stream/lifecycle OFF; 50004 excluded. R71 candidate only.
