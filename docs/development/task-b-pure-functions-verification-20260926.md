# 任务 B(纯函数 + 单测)验证记录(2026-09-26)

- 分支:`claude/tasks-b-pure`,基于 `main` @ `f2d5331d60`。只推分支,不合并(owner 2026-09-26「起任务 B」)。
- 设计:`docs/development/task-b-pure-functions-design-20260926.md`。规格来源:任务功能线设计锁 @ `grok/tasks-m0` head `ce180c8850`(§4.2、§4.4、§6.1、§6.2、§7、门 3/5/8/10/19/20)。
- 范围:`packages/core-backend/src/tasks/` 五个无 I/O 模块 + `packages/core-backend/tests/unit/task-*.test.ts` 五个单测。无 DDL、路由、服务、前端、flag。

## 1. 过程与模型

| 步骤 | 执行者 | 结果 |
|---|---|---|
| 实现 | Sonnet 子代理 | 五模块 + 五单测 |
| 审阅第 1 轮 | Opus 子代理 | REJECT:2 P1 / 8 P2 / 7 P3 |
| 修复(部分) | Sonnet 子代理,中途 403 认证失败 | 两条 P1 与多数 P2 的修复已落盘 |
| 审阅第 2 轮 | Opus 子代理(独立,只读) | REJECT:两条 P1 CLOSED(含 Postgres 实跑证据);1 P2 + 若干 P3 未闭合 |
| 余项修复 | 编排者(Opus 主循环)亲自修 | 见 §3 |

说明:第 2 轮之后的余项由编排者直接修,未再起第 3 轮独立审——修复面见 §3,均配了新单测。「实现者不自批」在本件退化为「同一编排者下的不同代理」:实现为 Sonnet、两轮审阅为独立 Opus 代理、余项修复为编排者。M2 接入前建议再起一次独立审。

## 2. 第 2 轮审阅的独立核验(摘要)

- lock §6.1 视角网格 49 格:从锁内解析,名字与 i-m2 块逐一相同;`taskMatchesView` 0 不一致;SQL 侧在本机 PG 15.17 逐格隔离执行(另一 org 放诱饵行)0 不一致。
- pending 的 overdue / overdue_or_today SQL:9 个 `now` × 11 个查看者时区头 × 2 个 scope,共 198 条查询、343 个任务,与 TS 谓词 0 差异;含门 8 A 支夹具与跨时区全天格。
- 时区换算:418 个时区 × 365 天,0 差异;2010–2030 全部 DST 转换附近 19.5 万个钟面时刻,0 算法差异。
- ID 校验对 DDL CHECK:2,814 个字符串,四合取与一合取两种 CHECK 均 0 不一致。
- 门 8 数值:`viewerNextMidnight` 上海 `2026-09-15T16:00Z`、UTC `2026-09-16T00:00Z`;护栏成立。

## 3. 第 2 轮余项的修复(编排者)

| 项 | 修复 | 新增/改动的测试 |
|---|---|---|
| 查看者时区校验 | 规范化后的结果也必须是命名时区(以字母开头的 IANA 名),偏移形一律回退任务时区 | `task-dates.test.ts` review round 2 |
| 不存在的日期/时刻 | `2026-02-30`、`10:75`、`25:00` 等抛 `RangeError`,不再滚动 | 同上 |
| 每次调用新建格式器 | 原始拼写 → 规范名加有界缓存 | 现有用例覆盖 |
| 门 5 用例恒真 | 改为先断言两位查看者确在不同日期,再断言 due_at 字节相同 | 同文件 |
| docblock 引用他线文件与临时路径 | 重写模块抬头 | — |
| any 模式重复完成/重复重启发空事件 | 无变化即无事件 | `task-completion.test.ts` review round 2 |
| `completedAt: undefined` 被当作已完成 | `null` 与 `undefined` 都视为未完成 | 同上 |
| `generateTaskDomainId('toString')` 通过 | 只认自有键 | `task-ids.test.ts` review round 2 |
| `actorParam`/`orgParam` 类型为 `unknown` | 改为 `string` | 严格 tsc 通过 |
| delegated 探针恒真 | 改为 TS 孪生谓词的行为探针(`none\|delegated\|oa` 格) | `task-access.test.ts` |
| 自选项误用 `ASSUMPTION` 标签 | 改为 `NOTE(task-b)` | — |

## 4. 最终命令与结果(编排者亲跑,本工作树)

```
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/task-
 Test Files  5 passed (5)
      Tests  293 passed (293)

cd packages/core-backend && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "src/tasks|tests/unit/task-"
(无输出,grep exit 1)

npx tsc --noEmit --strict --skipLibCheck --target ES2022 --module commonjs --moduleResolution node --esModuleInterop --types node,vitest/globals src/tasks/*.ts tests/unit/task-*.test.ts
exit 0

/usr/bin/grep -R -E "from[[:space:]]+['\"](\.\./)+db/|\.query\(" packages/core-backend/src/tasks
exit 1(零命中,门 20 静态部分)
```

## 5. 未做 / 未验证

- 真库行为测试(门 19 SQL 侧、门 3 路由面、门 20 行为门):属 M2,NOT RUN。第 2 轮审阅在本机 PG 上的实跑只是审阅证据,不是本分支的测试。
- 第 3 轮独立审:未起(见 §1 说明)。
- 设计外的签名变更(待 owner 在 M2 审阅时确认):`buildTaskPendingCondition` 增加可选 `viewerTzParam`;`isOverdue` 增加可选 `viewerTz`;`validateViewerTimeZoneHeader` 新导出。
