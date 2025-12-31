# Yuantus PLM 联测验证记录 (2025-12-30)

验证目标：确认 MetaSheet2 对 Yuantus PLM 的核心联测路径与真实接口一致。

## 环境
- PLM_BASE_URL: http://127.0.0.1:7910
- Tenant/Org: tenant-1 / org-1
- 登录用户: admin / admin
- Header: `x-tenant-id`, `x-org-id`

## 验证结果

### 1) Health
- `GET /api/v1/health` → ✅ `ok: true`

### 2) Search (产品列表)
- `GET /api/v1/search/?q=&limit=2&item_type=Part` → ✅ 返回 `{ hits, total }`
- `POST /api/v1/search/` → 返回 `detail`（不支持 POST）

结论：**Yuantus 搜索必须使用 GET + query params**。

### 3) AML Item 详情
- `POST /api/v1/aml/apply` (type=Part, action=get, id=ITEM_ID)
- 返回 `{ count, items }`，items[0] 包含 `id/type/state/properties`

结论：**adapter 的 `getProductById` 解析逻辑匹配**。

### 4) BOM Tree
- `GET /api/v1/bom/{id}/tree?depth=2` → ✅ 返回含 `children` 的树

结论：**BOM 树解析路径正确**。

## 适配器状态

已确认 `PLMAdapter` 的 Yuantus 模式实现与实际接口一致：
- Health: `/api/v1/health`
- Search: `/api/v1/search/`（GET）
- Item: `/api/v1/aml/apply`
- BOM: `/api/v1/bom/{id}/tree`

为避免误改，已在 adapter 增加提示：若 search 返回 `detail`，提示需使用 GET。
Federation 侧 `GET /api/federation/plm/products/:id` 支持 `?itemType=` 覆盖默认类型。

示例：
```bash
curl "http://localhost:7778/api/federation/plm/products/de7471da-0a5c-4436-971c-65ed64418df0?itemType=Part"
```

## 本地回归脚本

运行命令：
```bash
PLM_BASE_URL="http://127.0.0.1:7910" \
PLM_TENANT_ID="tenant-1" \
PLM_ORG_ID="org-1" \
PLM_USERNAME="admin" \
PLM_PASSWORD="admin" \
PLM_ITEM_ID="de7471da-0a5c-4436-971c-65ed64418df0" \
PLM_BOM_ITEM_ID="fc5ff0f7-3dc2-42ac-b95f-347fcbe476f1" \
bash scripts/verify-yuantus-plm.sh
```

可选验证项：
```bash
PLM_ITEM_TYPE="Part" \
PLM_BOM_DEPTH=2 \
PLM_WHERE_USED_ITEM_ID="<item-id>" \
PLM_BOM_COMPARE_LEFT_ID="<left-id>" \
PLM_BOM_COMPARE_RIGHT_ID="<right-id>" \
PLM_BOM_LINE_ID="<bom-line-id>"
```

说明：
- 若未提供 `PLM_BOM_LINE_ID`，脚本会从 BOM tree 中自动尝试提取 relationship id。
- 也可使用 `pnpm verify:yuantus` 运行脚本。
- `PLM_ITEM_TYPE` 会影响 Yuantus search/AML 查询的 item 类型（默认 Part）。

输出摘要（2025-12-31 复跑）：
- Token OK (len=195)
- Health: ok=true
- Search(GET): keys=[hits,total], hits_len=2
- AML Apply: items_len=1, item_keys=[id,properties,state,type]
- BOM Tree: children_len=1
- Where Used: count=1, parents_len=1
- BOM Compare: summary added=1, removed=2, changed=0
- BOM Substitutes: bom_line_id=e86b60cb-7c09-4db4-b67b-a19f451c9092 (auto-detected), subs_len=0

## 单元测试

专项命令：
```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/federation-plm-yuantus.test.ts --reporter=dot
```

专项结果：
- 通过：1 file / 1 test
- 备注：Vite CJS deprecation warning + RBAC 日志为测试输出（不影响结果）

全量命令：
```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit --reporter=basic --silent
```

全量结果：
- 通过：25 files / 265 tests

## 集成测试（当前状态）

命令：
```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run --reporter=basic --silent
```

结果：
- 通过：`comments.api`, `kanban.mvp.api`, `rooms.basic`, `snapshot-protection`（共 27 tests）
- 跳过：插件集成相关用例（`SKIP_PLUGINS=true`，共 9 tests）
- 备注：Vitest 输出完成但进程未自动退出，需手动结束（疑似 open handles）。

## 替代件联测

为验证 substitutes 非空返回，创建了一个测试替代件：
- BOM line: `e86b60cb-7c09-4db4-b67b-a19f451c9092`
- Substitute item: `d636810c-ceb4-41e9-b536-6c87722478d0` (item_number: `SUB-ALT-1767103843`)
- Substitute relation: `59799b71-9231-4ddb-a036-5b7d2060eb54`

脚本验证结果：
- `count=1`, `subs_len=1`

清理结果：
- 已删除 substitute 关系与测试 item
- 当前 substitutes: `count=0`, `subs_len=0`
