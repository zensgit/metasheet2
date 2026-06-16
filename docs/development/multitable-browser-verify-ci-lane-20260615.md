# 多维表 浏览器验证 CI lane(修路) — 开发 & 验证 — 2026-06-15

> Status: **LANE BUILT,CI-VERIFIED-NOT-LOCALLY**(撰写方沙箱 SIGKILL Chrome,本机跑不了浏览器;CI 是首个真实运行环境)。把 #2683 的手动验证包升级为**长期 CI 能力**:真实浏览器渲染 + 断言 + 截图,作为 browser-gated UI 的门禁基础设施。
>
> owner 决策(2026-06-15):优先建 CI lane 而非只手动跑一次 —— "修路,不只是过河"。B1-b/c、A5 config dialog、后续多维表 UI 都需真实浏览器;这条 lane 把"浏览器可验证"变成可复用能力。

## 1. 范围(最小 lane,按 owner 规格)

- **只跑 Path A harness**:无后端、无 DB seed,先把浏览器能力打通。
- 渲染真实组件 `MetaGridTable`(data-bar / color-scale / icon-set)+ `MetaCommentReactions`(chips + picker),用 fixture 数据。
- **fail-loud**:console/pageerror、缺选择器、chip 不出现 → 全红。
- **CI 产物**:上传 `bv-grid.png` / `bv-reactions-picker.png` / `bv-reactions-after.png`。

## 2. 构成(文件)

| 文件 | 作用 |
|---|---|
| `apps/web/verification/cf-reactions-harness.html` + `.ts` | dev/CI-only harness;挂载真实组件 + fixture;reactions **reactive**(onReact/onUnreact 本地重算 → 点击 chip 变化可见)。**置于 src/ 外**,故 vue-tsc/vite build/lint **均不收录**(对既有 CI 门零影响,实测确认) |
| `apps/web/verification/cf-reactions.spec.ts` | Playwright 测:goto harness → 断言 data-bar 渐变 / color-scale 实底色 / icon-set 字形 / 反应 chips → 开 picker → 选 🚀 断言新 chip 出现 → 截图 → console/pageerror 必为空 |
| `apps/web/playwright.verification.config.ts` | testDir=verification;`webServer` 自启 `vite --port 5174 --strictPort`;chromium project;CI retain-trace-on-failure |
| `.github/workflows/multitable-browser-verify.yml` | on PR(多维表 UI 文件 + verification/ 变更)+ workflow_dispatch;install → `playwright install --with-deps chromium` → 跑 lane → 始终上传截图 |
| `apps/web/package.json` | `verify:browser` 脚本 |
| `.gitignore` | 忽略 `apps/web/verification-output/`(截图/trace 产物) |

## 3. 验证

| 项 | 结果 |
|---|---|
| Playwright config + spec 解析/收集(`playwright test --list`) | ✅ 1 test collected,无解析错 |
| Vite 服务 harness HTML | ✅ 200 |
| harness `.ts` transform + `../src/` import 解析 | ✅ 干净(vite 解析到 `/src/multitable/...`,日志无 resolve/transform 错) |
| 对既有 CI 门(vue-tsc / lint / vite build / vitest)影响 | ✅ 零(harness 在 src/ 外、lint 显式文件列表外、build input 外 —— 实测确认) |
| @playwright/test 依赖 | ✅ 已是 root devDep(`^1.57.0`),无 lockfile 改动 |
| **真实浏览器运行**(渲染断言 + 截图 + 交互) | ⏸ **本机跑不了(沙箱 SIGKILL Chrome);CI 为首个真实运行** —— 诚实边界 |

**诚实声明**:除"真实浏览器运行"外全部本地实测通过;那一步本机无法验证(无浏览器),**CI 是首个真实测试**,红则迭代。这正是建 lane 的意义:把验证放到有浏览器的地方(CI)。

## 4. 门禁

- **本 lane CI 绿** → 三项视觉残余(data-bar / color-scale·icon-set / B6 reactions)由真实浏览器确认 → 各 dev/verification MD 的"浏览器目检=残余"可改"已 CI 浏览器验证";**然后**方可开 B1-b/c、A5 config dialog。
- lane 红 → 可能是配置待调,也可能是**真发现视觉 bug**(验证在起作用)→ 按项开 focused fix PR。
- 在 lane 绿前:**不开 browser-gated UI**,不堆 jsdom-only 切片。

## 5. 后续(lane 绿后可选增强,均待具名 opt-in)

- Path B 全栈 e2e(seed + 真实工作台导航 + 反应 API 往返);
- 视觉回归快照对比(Playwright `toHaveScreenshot`);
- 把本 lane 设为 browser-gated UI PR 的 required check。
