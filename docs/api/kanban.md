Kanban API (MVP)

Base: `/api/kanban/:viewId`

Auth
- Default dev/test: JWT optional；可通过 `x-user-id` 标识用户。
- Strict: 设置 `KANBAN_AUTH_REQUIRED=true` 后，JWT 必填（全局中间件校验，插件端不再接受回退）。

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
