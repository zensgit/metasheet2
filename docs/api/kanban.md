Kanban API (MVP)

Base: `/api/kanban/:viewId`

Auth
- JWT 必填，无条件：`/api/kanban` 挂在全局会话 JWT 门之后，且不在豁免表（`packages/core-backend/src/auth/api-path-policy.ts` 的 `GLOBAL_GATE_EXCEPTIONS`）里，缺 token 一律 401。
- `KANBAN_AUTH_REQUIRED` 环境变量目前只在 `packages/core-backend/src/config/index.ts:30,67` 与 `src/config.ts:71,107` 被解析进 config，没有任何路由读取它——设不设、真不真都不影响鉴权行为。
- `x-user-id` 请求头只是 `getUserId()`（`packages/core-backend/src/routes/kanban.ts:23-33`）里 `req.user?.id` 的死回退：能走到这一步说明已经过全局 JWT 门、`req.user` 必然已存在，该头从未被真正采用。
- 本地开发拿 token：`GET /api/auth/dev-token`（仅非生产环境可用，`packages/core-backend/src/routes/auth.ts:63`），返回体里的 `token` 放进 `Authorization: Bearer <token>`。

GET `/api/kanban/:viewId`
- 200: `{ success: true, data: { ...config, state }, etag }`
- 304: 命中 `If-None-Match` 返回空体
- 404: 视图不存在

POST `/api/kanban/:viewId/state`
- Body: `{ state: { columns: [{ id, order, cards: string[] }] } }`
- 204: 更新成功（幂等 upsert by (view_id,user_id)）
- 400: 无效 state 结构（zod 校验失败）
- 413: 载荷过大（state > 256KB）
- Side effects: 广播 `kanban:stateUpdated`

Example (GET with ETag)
```
curl -H "Authorization: Bearer $TOKEN" -H "If-None-Match: $ETAG" $API/api/kanban/board1 -i
```
