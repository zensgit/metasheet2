# BA-APPLY-3 — Bridge Agent 应用后自动复探测确认 · 开发与验证（2026-07-08）

> 上位设计锁：`docs/development/bridge-agent-controlled-apply-design-lock-20260708.md`（§7 Disposition 终态表）。
> 需求锚：#3746（保留 OPEN，最终口径已回贴）。这是 **Bridge Agent 受控 apply 线的最后一根 rung**，落地后该线终态定型。

## 1. 它是什么（一句话）

运维**手工**按导出的实施清单在受控后端/脚本应用变更后（form-A handoff，人类 runbook 步骤，**不经本平台**），
管理员在 Bridge Agent 页点“复探测确认是否生效”，页面用**既有的只读对象/schema 探测**重新读取连接器，
逐项核对**预期的只读对象/字段是否已出现**，给出 `已生效 / 部分生效 / 未生效` 的粗粒度确认。

## 2. 终态阶梯（BA 受控 apply 线，本 rung 收官）

```
看得见(BA-UI-1 #3824) → 查得清(BA-UI-2 探测 #3840) → 变更建议(BA-UI-3 #3858)
  → 可导出机读清单(BA-APPLY-1 #3894) → 后端审批门+审计+values-free 暂存(BA-APPLY-2a #3938)
  → 运维 handoff(人工执行只读 allowlist/config 变更 = 人类把关点)
  → 自动复探测确认(BA-APPLY-3 本 PR) ✅ 终态
```

**Agent 恒 `readonly:true`。** 全线无任何环节让本平台或页面向 Agent / 客户机器写入配置。
BA-APPLY-2b（给 Agent 加 config-write 端点）= **WONTFIX by design**（安全模型级决定，非缺功能；见 disposition #3936）。

## 3. 契约（confirm-card）

输入（全部来自已在页面上的只读状态，**零新 fetch**）：
- `implementationChecklist.checklist.operations` —— 与“导出实施清单”**同一份**经 safe-identifier 过滤的 operations（单一来源，不重复过滤）。每项 `{ op, objectName, fieldKeys }`。
- `objects` —— 挂载时自动加载的只读对象列表（复用既有 `loadObjects` 探测）。
- `schemaByObject` —— 展开对象时按需加载的只读字段列表（复用既有 `toggleSchema` 探测）。

派生（`reProbeConfirmation` computed）：
- 每个 operation 的 `objectPresent = 已探测对象名集合.has(objectName)`（**派生自探测，非假定**）。
- 每个字段 `present = objectPresent && 已探测字段名集合.has(key)`（字段只在其父对象在场**且**该对象 schema 复探已出该键时才确认）。
- 粗状态：`total===0 → empty`；`全present → applied`；`全absent → absent`；`否则 partial`。

渲染（**values-free**）：只输出**对象名 / 字段键名 + 已出现/未出现 布尔 + 粗状态 + present/total 计数**。
永不渲染业务行值 / host / 凭据 / 原始 config。

## 4. 硬锁与证明

| 锁 | 手段 | 结果 |
|---|---|---|
| **只读 / 零写**（无 apply、无 config write、无 start/stop、无凭据、无 raw-config 改、无新 fetch/route） | 结构性 grep 全 diff 的 `apps/**` SOURCE 面无 `apiFetch`/`POST`/`fetch(`/`.ps1`/`Set-Content`/`apply`/`start`/`stop`/`reload` 写原语（命中全在测试代码）；Test D 断言 toggle 复探测**不发任何路由**且 confirm 卡无 action 按钮 | ✅ 零写 |
| **Confirm 派生自探测，非硬编码** | M1：`objectPresent = probedObjectNames.has(...)` → `true` | ✅ KILLED（2 failed：ghost_object 应 absent、zh 未生效） |
| 同上（字段层） | M2：`present: objectPresent && probedFieldNames.has(key)` → `true` | ✅ KILLED（1 failed：ghost_field 应 未出现） |
| **Values-free** | Test C：SENTINEL（objectExtra/schemaExtra 敌意键）注入探测 payload → confirm 输出 `innerHTML` 不含任一 SENTINEL | ✅ 无泄漏 |
| **Consumer-面 非 browse-面**（owner 2026-07-08） | 本 PR **不新增** list/search/browse 路由或通用清单画廊；复探测只消费页面既有只读对象/schema 状态 + 单一份 operations | ✅ 无扩面 |
| kill-then-green sanity | M1/M2 restore 后全绿 | ✅ 45 passed |

## 5. 测试（+5，共 45 全绿；vue-tsc 0 error）

`apps/web/tests/IntegrationBridgeAgentSection.spec.ts`（扩展既有 spec，**无新文件** → 无 CI 过滤/yml 改动）：
1. 对象在探测中 → `已出现`；字段不在探测 schema → `未出现`；整体 `partial`，逐项 flag 正确。
2. 预期对象**不在**探测 → `未生效`（absent，派生非假定）。
3. SENTINEL 无泄漏（只名 + 布尔）。
4. toggle 复探测**零路由** + confirm 卡零 action 按钮。
5. zh-CN 中文标签（复探测确认 / 未生效 / 未出现）。

## 6. 边界（本 rung 不做）

不做：任何写路径 / apply 端点 / config 直改 / start-stop / 凭据处理 / 新 fetch 或后端 route /
list-browse 面 / 自动标记 checklist 为已应用（那是运维手工步骤或独立关注点）/ 递归。
2b（Agent config-write 端点）不复活，除非 owner 未来显式重新 ratify Agent 安全模型。

## 7. 收官声明

BA-APPLY-3 落地后，Bridge Agent 受控 apply 线**终态定型**：页面具备只读诊断、values-free 探测、变更建议、
可导出机读清单、后端审批暂存/审计、运维 handoff、自动复探测确认；**Agent 仍 readonly**。闭环靠“系统自动复确认生效”，
低频高后果的 allowlist/config 变更**刻意保留运维手工把关点**（不是缺功能）。
