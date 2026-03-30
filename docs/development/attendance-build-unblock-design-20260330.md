# Attendance Build Unblock Design

日期：2026-03-30

## 背景

前端构建被 [AttendanceView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/AttendanceView.vue) 的时区工具依赖阻塞：

```ts
import { buildTimezoneOptions, formatTimezoneLabel } from '../utils/timezones'
```

仓库里缺失 `apps/web/src/utils/timezones.ts` 时，会直接导致：

```text
pnpm --filter @metasheet/web build
```

失败，进而影响 DingTalk、directory 和其他前端 slice 的统一验收。

## 目标

1. 恢复 `AttendanceView` 所需的时区工具模块。
2. 不把修复停留在“临时补文件”，而是补足最小测试和文档。
3. 让 `pnpm --filter @metasheet/web build` 回到稳定全绿。

## 方案

### 1. 恢复时区工具

保留 `apps/web/src/utils/timezones.ts` 作为统一时区工具入口，提供：

- `formatUtcOffset`
- `formatTimezoneLabel`
- `buildTimezoneOptions`

当前工作树中的 `timezones.ts` 已通过部署收口分支引入；这轮的重点不是再次“补文件”，而是把它补成正式基线能力。

### 2. 加固无效时区输入

`AttendanceView` 虽然主要消费浏览器与配置生成的合法时区，但时区工具本身应避免在遇到非法值时把整个页面初始化打崩。

因此在 `buildTimezoneOptions()` 中新增合法性过滤：

- 空值跳过
- 重复值去重
- 非法时区直接忽略

### 3. 补足最小单测

新增 `apps/web/tests/timezones.spec.ts`，锁定三类行为：

1. UTC offset 格式化
2. 时区标签格式化
3. `buildTimezoneOptions()` 对无效时区的容错与去重

## 非目标

本轮不处理：

- Attendance 页面更大范围的性能或交互重构
- 时区下拉的文案优化
- 大 bundle 拆分或 chunk 告警优化

## 验收标准

1. `pnpm --filter @metasheet/web exec vitest run tests/timezones.spec.ts` 通过
2. `pnpm --filter @metasheet/web build` 通过
3. 不引入新的 Attendance runtime 行为回归
