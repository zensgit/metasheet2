# AttendanceView.vue 裸 hex → UF token 迁移 design-lock — 2026-07-07

> **Status: RATIFIED-plan（owner 队列第 3 项「机械 token 化批量」）。执行分批,默认由 attendance-impl
> (Sonnet) 跑量（owner 定「Sonnet 恢复后跑量最划算」;Sonnet 周限至 2026-07-12）。** 本文=映射表 + 批次边界 + 测试纪律。

## 1. 关键认知:这不是无脑 sed,是语义化局部改色

`AttendanceView.vue` 有 **317 处裸 hex**（~100 个不同值）。分两类:
- **精确匹配（视觉零变,安全）**:hex == 某 token 值 → 直接换。清单:
  `#111827`→`--ms-text-1`(7)、`#4b5563`→`--ms-text-2`(3)、`#e5e7eb`→`--ms-border-light`(4)、
  `#d1d5db`→`--ms-border`(2)、`#ffffff`/`#fff`→`--ms-bg-card`(仅当作背景时)、`#dc2626`→`--ms-color-danger`、
  `#d97706`→`--ms-color-warning`、`#f5f6f8`→`--ms-bg-page`。约 35–40 处。
- **近似收敛（视觉会变,设计系统收敛,需 owner 知情）**:随手色 → 最近 token。示例:
  蓝族 `#1976d2`/`#1d4ed8`/`#1565c0`→`--ms-color-primary`(#2563eb);
  灰族 `#6b7280`/`#64748b`/`#555`/`#666`/`#777`→`--ms-text-2`|`--ms-text-3`（按亮度）;
  红 `#c62828`→`--ms-color-danger`;蓝 tint `#eff6ff`/`#e3f2fd`/`#dbeafe`→primary-soft 背景。约 280 处。

## 2. 语义陷阱（为什么必须逐处读上下文,不能全局替换）

同一 hex 在不同 CSS 属性下语义不同 → 目标 token 不同:
- `#ffffff` 作 `background` → `--ms-bg-card`;作 `color`（深底白字）→ `--ms-text-inverse`/保留;作 `border-color` → 另论。
- 深灰 `#111827` 作 `color` → `--ms-text-1`;作 `background`（深卡）→ 不是 text token。
- **规则:按「属性 + 语义角色」映射,非按 hex 值全局替换。** 每处替换前读所在选择器/属性。

## 3. 批次边界（每批一个内聚 CSS 区,独立 PR,可被 mutation-审）

按 CSS 区域切批,便于 review + 目视验收:
- B1 filters / summary / stat 卡（含 UI-P1 768 区）
- B2 hero / 打卡卡 / timeline
- B3 self-service focus / callout / calendars
- B4 import 面板（含格式表/勾选卡）
- B5 admin/reports 表格与表单
- B6 剩余零散
每批:精确匹配优先（零变）;近似收敛的每处在 PR 描述列「旧 hex → token（Δ色差说明）」供 owner 目视。

## 4. 测试纪律（CSS 无法在 jsdom 断言计算色）

- **零回归护栏**:每批后跑该区既有 web-guard spec（DOM/testid/类保全,不因改色而变）。
- **无新裸 hex 护栏**（建议加）：一个 lint/测试断言 `AttendanceView.vue` 的裸 hex 计数**单调不增**（防新增），
  批次推进时下调阈值 → 形成"棘轮"。首批引入该计数守卫。
- 精确匹配子集=视觉零变（值相同);近似收敛子集=owner PR 目视验收 + E4 真机顺带核。
- 每批 opus 审:确认无语义错配（text token 用到 background 等）。

## 5. 完成口径

规划已 ratify。执行:Sonnet 恢复（2026-07-12）后按 B1→B6 跑量,每批 design-scope 内、opus 审 0 P1/P2、
三红线、区 spec 绿 + hex 计数棘轮下降。若 owner 要提前起批,可先做 B1 精确匹配子集（零变,安全）证明棘轮护栏。
