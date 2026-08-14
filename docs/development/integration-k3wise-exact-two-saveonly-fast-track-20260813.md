# K3 WISE 精确两行 Save-only 快车道

日期：2026-08-13
范围：测试环境、物料、一次性 C6 dry-run token、Save-only
状态：开发与本地验证；不构成实体机 Apply 授权

## 目标

把 #4861 的最小写入验证固化为服务端可复算的验收策略，避免每次由操作者人工解释计数：

- 来源必须完整且未截断；
- 必须精确读取并计划两行；
- 两行的 K3 `FNumber`（trim + 大小写归一化后）必须互不相同；
- 两行必须全部判定为 `add`；
- `update`、`skip`、`held`、`failed` 必须全部为零；
- K3 目标仍使用既有 Save-only profile；
- Apply 仍使用一次性 token，并在服务端重新读取、重新分类和校验 revision；
- Apply 后必须交给已指定的 K3 管理员，通过 K3 原生控制台/工具清理精确两条测试物料。

## 持久策略

受信管理员在 K3 目标 external system 的私密 `config` 中加入固定策略：

```json
{
  "c6AcceptancePolicy": {
    "profile": "k3-test-only-exact-two-add-v1"
  }
}
```

该字段不会出现在 public create/get/list 回执中，普通 public config 更新在未提及它时会保留原值；任何设置或显式清空
`c6AcceptancePolicy` 的请求都必须具备 `integration:admin`，且普通 dry-run / Apply 请求不能注入或覆盖它。策略只有一个允许字段，行数和操作模式不能由请求调整。它不会启用 Apply、不会覆盖部署级
`INTEGRATION_C6_WRITE_APPLY_DISABLED`，也不会授予任何权限；它只会收紧 token 签发条件。

Apply 与私密 `c6AcceptancePolicy` 变更的 tenant 只来自已认证主体。无 tenant 的 `role:admin`、以及 body/query/params 上与认证 tenant 不一致的 carrier，都在 registry / token / adapter / source / write I/O 之前失败。与认证 tenant 相同的显式 tenantId 仅作兼容，不能改写范围。Apply-disable 仍在 body 解析之前生效。

SQL read-only 的 equality filter 与 lookup projection 继续使用已合并的服务端持久配置。lookup 对象、关联键、
字段标识和过滤值不进入浏览器证据或公开回执。普通 dry-run / Apply 请求不能注入或覆盖这些配置。

## 运行门禁

dry-run 仅在以下 values-free 形态同时成立时返回 `ready` 和一次性 token：

```text
sourceRows=2
planned=2
add=2
update=0
skip=0
held=0
failed=0
sourceRead.complete=true
sourceRead.truncated=false
acceptancePolicy.ready=true
```

任何不匹配都返回 `not_applyable`，不签发 token，并加入固定错误类型
`acceptance_policy_mismatch`。策略在 dry-run 与 Apply 之间被删除、替换或扩展字段时，revision 必须改变，
Apply 在任何目标写入前失败。

受控策略启用时，planner policy 会带上服务端派生的 `strictAbsence` 标志，请求不能开关它。此时泛化的
`K3_WISE_READ_BUSINESS_ERROR` 不得解释为“目标不存在”；dry-run / Apply 失败关闭，不签发 token，也不调用 Save。
未启用该策略时，仍保持既有“业务 miss → add”的预览语义。

Apply 在任何 `insertRows` Save 之前，会对全部 add 行再用同一严格 lookup 做一次整批预检：任一行已存在、键歧义、lookup 抛错或返回畸形结构，整批拒绝且 Save 次数为零。这不是原子 K3 insert-only。K3 Save 仍是 upsert；planner lookup 与预检 / Save 之间仍有 TOCTOU 窗口。真实实体执行在 owner 接受、或 K3 提供 create-only 之前仍未授权。

## 页面交互

工作台只展示状态、计数和固定策略信息，不展示 token、行值、目标 payload 或私密 lookup 配置。受控策略启用时：

1. 操作者先复核 dry-run 计数；
2. 页面显示“精确两行、全部新增”门禁结果；
3. 还必须单独确认已指定 K3 管理员并准备原生清理；
4. 两项确认都完成且用户具备 `integration:write` 时，Apply 按钮才可用。

第二个确认是操作交接提示，不替代服务端权限、部署级 Apply gate、owner 授权或 K3 管理员权限。

## 清理与停止条件

历史 rollback design 只批准单记录，不能由代码静默扩成两条。本快车道仅实现 #4861 的技术门禁；只有 owner
另行批准精确两条例外、并记录 K3 管理员和清理策略后，才沿用该 design 的 K3 原生边界处理同一 operation
创建的精确两条测试物料：

- 首选由 K3 管理员确认均未被引用后逐条删除/作废；
- 无法删除时按事先批准的禁用、标记测试或保留审计顺序处理；
- 不能确认精确身份、引用状态或权限时立即停止，不得搜索、通配或批量处理；
- Submit、Audit、BOM、普通 run、replay 和任何来源数据库写入均不在范围内；
- 只有两条目标均得到 K3 原生 readback 证明后，才可清理对应 SQL 测试行。

## 本地验证

```text
external-write-dry-run.test.cjs=PASS
IntegrationWorkbenchView.spec.ts=51/51 PASS
vue-tsc=PASS
realK3Calls=0
entityServerMutations=0
```

负控覆盖：非 K3 目标、未知策略字段、非两行、出现 update、重复 `FNumber`、普通写入用户设置/清空私密策略、策略在 token 后漂移、泛化 `K3_WISE_READ_BUSINESS_ERROR` 在受控策略下不得当缺席、planner lookup 之后目标变为已存在/歧义/lookup 失败则整批零 Save、无 tenant 的 `role:admin` 与跨 tenant carrier 在 Apply/私密策略变更上失败关闭，以及浏览器不渲染私密证据字段。
