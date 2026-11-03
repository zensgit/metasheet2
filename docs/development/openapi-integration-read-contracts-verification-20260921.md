# Q4c PR-1 verification（短版）

2026-09-21

## 契约来源表（每条路径在 `src/paths/*.yml` 里的注释头也各自重复了这一行）

| 路径 | 处理器 path:line | registry/store 函数 path:line | 投影函数 path:line |
|---|---|---|---|
| GET /api/integration/provenance | `plugins/plugin-integration-core/lib/http-routes.cjs:10012` | `plugins/plugin-integration-core/lib/pipelines.cjs:761` (`listProvenanceByRow`) | `lib/pipelines.cjs:355` (`rowToProvenanceEntry`, 复用既有 `ProvenanceTimelineEntry` schema) |
| GET /api/integration/dead-letters | `lib/http-routes.cjs:10032` | `lib/dead-letter.cjs:121` (`listDeadLetters`) | `lib/dead-letter.cjs:69` (`rowToDeadLetter`) + `lib/http-routes.cjs:2920` (`redactDeadLetter`) |
| GET /api/integration/pipelines | `lib/http-routes.cjs:5429` | `lib/pipelines.cjs:605` (`listPipelines`) | `lib/pipelines.cjs:289` (`rowToPipeline`) |
| GET /api/integration/pipelines/{id} | `lib/http-routes.cjs:5451` | `lib/pipelines.cjs:588` (`getPipeline`) | `lib/pipelines.cjs:289`+`:315` (`rowToPipeline`/`rowToFieldMapping`) |
| GET /api/integration/external-systems | `lib/http-routes.cjs:4876` | `lib/external-systems.cjs:1446` (`listExternalSystems`) | `lib/external-systems.cjs:258` (`rowToPublicExternalSystem`) |
| GET /api/integration/external-systems/{id} | `lib/http-routes.cjs:4907` | `lib/external-systems.cjs:978` (`getExternalSystem`) | `lib/external-systems.cjs:258` (`rowToPublicExternalSystem`) |

错误码来源同样亲读确认（`inferErrorCode`, `lib/http-routes.cjs:848`：无显式 `.code` 时用
`error.name`）：`PipelineNotFoundError`/`PipelineValidationError`（`lib/pipelines.cjs:47`/`:39`）、
`ExternalSystemNotFoundError`/`ExternalSystemValidationError`（`lib/external-systems.cjs:101`/`:92`）、
`DeadLetterError`（`lib/dead-letter.cjs`, 状态枚举在同文件 `VALID_STATUSES`）。状态枚举逐一读源确认：
`VALID_STATUSES`（pipeline）= `lib/pipelines.cjs:26` = `draft/active/paused/disabled`；
`VALID_STATUSES`（external system）= `lib/external-systems.cjs:28` = `active/inactive/error`；
`VALID_STATUSES`（dead letter）= `lib/dead-letter.cjs:7` = `open/replayed/discarded`；
`VALID_ROLES` = `lib/external-systems.cjs:27` = `source/target/bidirectional`。

## 命令与结果

在 worktree `C:/Users/zhou/Downloads/dev/metasheet-wt-w8s` 下（`pnpm` 需要
`PATH+=/c/Users/zhou/AppData/Roaming/npm`；`packages/openapi` 与其 `dist-sdk` 子包首次在本
worktree 跑，先 `pnpm install --filter @metasheet/openapi... --prefer-offline` 与
`pnpm install --filter @metasheet/sdk... --prefer-offline`，10.5s / 4.4s，走本地 store 无需联网新装）：

```
pnpm run build            # packages/openapi — 合并 21 个 paths/*.yml（新增 3 个），OK
pnpm run validate         # tsx tools/validate.ts dist/openapi.yaml → "OpenAPI security validation passed"
pnpm run generate:sdk     # build + dist-sdk/scripts/build.mjs（openapi-typescript 7.13.0）→ OK
pnpm run guard:codegen    # tools/guard-codegen.mjs → "all checks passed"（含既有 FormField/record-link 等既有断言，未受影响）
```

`build.mjs`（`tools/build.ts`）本身零改动，之前记录的 Windows 修复已在 main 上；此次是纯新增
paths 文件被自动 glob 进合并，不需要额外登记。

## Diff 摘要

```
 M packages/openapi/dist-sdk/index.d.ts        (+519 行，新 6 条路径 + 4 个新 schema 类型)
 M packages/openapi/dist/combined.openapi.yml
 M packages/openapi/dist/openapi.json
 M packages/openapi/dist/openapi.yaml
 M packages/openapi/src/base.yml               (+4 个 schema)
?? packages/openapi/src/paths/integration-external-systems.yml
?? packages/openapi/src/paths/integration-pipelines.yml
?? packages/openapi/src/paths/integration-provenance-and-dead-letters.yml
```

`dist-sdk/client.js` / `client.d.ts` / `index.js` 被 `pnpm run generate:sdk` 重新写出，
`git diff` 内容为空（无实际字节变化，仅 git 的 CRLF 归一化提示），未纳入本次 commit 的实质变更。

## 未跑 / 不适用

- 本 PR 不改后端路由或前端代码，因此不适用 `stock-prep-web-ci-coverage-enumeration.test.ts`
  的枚举核验（该文件枚举的是 web spec 登记，本 PR 未新增/改动任何 web spec）、不适用
  `run-required-web-tests.sh` / `integration-guard-run-web-specs.sh` 的 token 登记（无新 spec）、
  不适用 `vue-tsc -b`（无前端代码改动）。
- `git diff origin/main | grep -P '\x08'` 结果为空，无反斜杠/退格损坏。
