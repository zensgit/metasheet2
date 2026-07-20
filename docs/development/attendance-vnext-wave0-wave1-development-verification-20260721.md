# 考勤 vNext UX 线 Wave 0 + Wave 1 — 开发与验证记录（2026-07-21）

> Charter: `attendance-vnext-dingtalk-benchmark-ux-development-charter-20260720.md`（RATIFIED，#4488 + #4492 修订）。
> 本文是章程 §14 步骤 1-3 的执行与验证台账；证据均为本地真跑 + 真浏览器 + CI，合成 fixture，无客户数据。
> 模型分工按 owner 指示：机械门禁/实现=Sonnet 车道、三视口与编排=Fable 主循环、对抗复核与漂移深读=Opus 车道。

## 1. 已交付

| 波次 | PR | squash | 内容 |
|---|---|---|---|
| Wave 0 | #4371 | `426ea624c` | useAttendanceAdminRail.spec 加固（退役 all-sections 偏好被忽略、focused 常开）+ guard run-list/双 path-filter 接线 |
| Wave 1 | #4359 | `962fff55f` | issue #4354 组设置工作台：列表-详情 + 四阶段导航（basics/people/schedule/policies）+ rail focused-mode scroll-spy 抑制守卫（+2 行）+ 122→129 腿回归 spec + §8.1.4 接线修正 + observer 正控腿 |

Re-port 方法（两 PR 同法）：对 current main 端态 squash re-port，patch-id 与原分支贡献逐字节恒等（#4359 原 9 提交含 merge commits 中间态冲突，端态 merge-tree 干净，零静默合成）。step-1 只读刷新结论、step-2/3 门禁记录均落 PR comment（#4371 comment 5023716771；#4359 comment 5023726069 + 5024129639）。

## 2. 门禁与验证（章程 §8.1 十一项对照）

| 项 | 结果 |
|---|---|
| 1 受影响纯模块 spec | useAttendanceAdminRailNavigation 7/7（含新增正控腿）|
| 2 真实挂载回归 spec | attendance-admin-regressions 122/122（含 list-detail/四阶段新增断言）|
| 3 web-guard current-head | 完整 targeted run-list 命令本地实跑 26 文件 / 521 测试全绿；CI 于 head 复跑 |
| 4 §8.1.4 spec 接线硬门 | **发现即修**：Navigation spec 原对 guard 不可见（覆盖系 substring 偶然、双 filter 缺 tests/ 路径，三车道两道独立命中同一违门）→ run-list 显式声明 + 双 path-filter 补路径；修正后命令点名收集该 spec |
| 5 vue-tsc -b | 0 错 |
| 6 web build | 成功（仅存量 chunk-size 警告）|
| 7 承重 mutation ≥2 | 4 组全被杀且恰红预期腿：①删 focused 守卫 ⇒ 守卫腿红（1/7）；②neuter `selectAttendanceGroupStage` ⇒ list-detail 断言红（1/122）；③observer 回调整体废掉 ⇒ 正控腿红、守卫腿仍绿；④（Wave 0）loadAdminNavFocusedMode 尊重 legacy 存储 ⇒ 3 腿红（含 anchor-nav 两腿）。全部还原后树净 |
| 8 三视口浏览器验证 | 1440×900 / 1024×768 / 390×844，6 张截图存 `assets/w1-vnext-20260721/`，**每张拍摄前通过「真在场断言」**（元素几何盒 + elementFromPoint 命中测试，杜绝 v-show 隐藏 DOM 错标）；四阶段互斥切换实测（1440 与 1024 各一张 ② 考勤人员高亮 + 成员表）；390 下管理中心 tab 可见、控制台完整渲染 |
| 9 scrollWidth 断言 | **考勤 `<main>` 内容区三档全部收边**（max-right ≤ viewport+1），390 档页级断言亦成立（390=390）。已知项：页级 `documentElement.scrollWidth` 桌面档超 64px，元凶 100% 为全局壳层 dev 导航（`.nav-link` 排至 1581px），与本波 diff 零交集——壳层修复候选另立，不在本线 |
| 10 非零尺寸/换行/不溢出 | 三视口人工目检：people 阶段 3 位种子成员表格、批量添加输入、四阶段 pill 均正常呈现无重叠；1024 档一次探针 `hit=NAV` 报警经几何复测定性为**伪报**（面板 x∈[618,968] 与 rail x∈[58,274] 完全分离，系折叠线附近中心点 clamp 所致） |
| 11 selector/deep-link/API 兼容 | diff 负行审计：四个 `data-attendance-group-*` section 原样回加、成员计数 selector 保留、删除仅 CSS 内部类、无 API 调用/deep-link 移除 |

**真浏览器守卫端到端正控**（jsdom 之外）：干净加载无漂移；滚动到底再回顶，当前区块选择寸步不移（guardHolds=true）——+2 行守卫在真实浏览器成立。

## 3. 对抗复核（Opus，refute-first）

- Wave 1 判定 **APPROVE 0 P1/P2**（MD `/tmp/pr4359-reprort-review-claude-20260720.md`）。2 P3 均已在合入 head 修复（§8.1.4 接线、observer 正控）。
- 语义漂移车道（vs S7-5 #4481）：PASS——审批 authoring 面与组工作台无共享 UI 平面、S7-5 面可达且单次渲染、spec 无过期假设。

## 4. 已知项与 NIT（honest 台账，不阻断）

0. **取证方法教训（记录在案）**：首轮 headless 截图因英文 locale 下中文文本选择器落空而错标画面（数据断言读到的是 v-show 隐藏 DOM）——目检发现后全部重拍，并把「拍前真在场断言」固化为脚本硬门；PR 已留更正评论（comment 5024302917）。审计面证据必须目检 + 命中测试双重把关。
1. 壳层 dev 导航桌面档横向溢出 64px（先于本波存在；证据与元凶清单在 #4359 门禁 comment）。
1b. `desktopOnlyBlocked`（admin/import/workflow 的移动端阻断）在桌面 UA + 390 视口下不触发（isMobile 判定语义属既有平台行为）；390 下管理控制台实测可用且无溢出，故非违门——真机移动 UA 行为留待 vNext 移动专项覆盖。
2. 取消编辑/重选组回弹 basics 阶段（丢失用户所在阶段）——UX 微伤，候选并入 Wave 2/3 相邻切片。
3. 回归 spec 中一处对 v-show 隐藏元素的点击（jsdom 允许、真人不能）——断言真实性折扣，候选 spec 微调。
4. focused 常开使 scroll-spy 观察者成为永久空转工作（无害；若日后清理需同步删守卫腿与正控腿）。
5. `AttendanceView.vue` 净增 +226 行（章程 §6.3 减债方向相反）——下一个抽取点 = `AttendanceGroupWorkspace.vue`（§15 组件表 Wave 1 行的既定去向），随 Wave 2/3 波次执行。

## 5. 剩余（口径：只说这个）

- **Wave 2（issue #4355 employee workspace runtime）**：PREDECESSOR / DOC-SYNC-GATED——#4370 需对 post-#4359 main 刷新复核（复核结论 MD 已备）→ **owner RATIFY** → 合入 → 方可开 runtime PR（§14 步骤 4）。
- **Wave 3（issue #4353 / #4414 re-port）**：Wave 2 合后 reclaim 业务意图，禁直接合旧 stacked head（§14 步骤 5）。
- **Wave 4 onboarding / Wave 5 explainability**：DESIGN-LOCK-GATED / DATA-CONTRACT-GATED。
- 本线不动 S7 flag（默认 OFF，operator opt-in 与本线无关）。
