# 钉钉互动审批卡片配置帮助文档

> 版本：2026-08-15
> 适用模板：`MetaSheetCanaryUAT3` 及同结构审批互动卡
> 目标：新卡显示「同意」「拒绝」，审批终态后隐藏操作区
> 边界：完成模板配置不等于 Stream 已启用，也不等于真实 UAT 已通过

## 1. 配置前准备

准备以下信息，但不要把凭据写入截图、文档或聊天记录：

| 项目 | 用途 |
| --- | --- |
| 钉钉组织管理员账号 | 进入开发者后台并管理企业内部应用 |
| 对应的钉钉应用 | 本环境使用的应用必须与 Stream 凭据属于同一应用、同一组织 |
| 卡片模板名称与模板 ID | 防止修改到同名测试模板或其他组织模板 |
| 已发布代码的精确 SHA | 真实 UAT 时确认模板和运行代码是一组 |
| 两个已绑定本地用户的钉钉账号 | 一个作为受理人，一个用于权限负控 |

当前 staging 模板：

- 模板名称：`MetaSheetCanaryUAT3`
- 模板 ID：`f8b8345f-485f-431c-9981-27f010bb9d2e.schema`
- 前一替代模板：`MetaSheetCanaryUAT2`（不再用于下一次窗口）
- 历史失败模板：`MetaSheetCanaryUAT`（仅保留作失败证据，不用于下一次 UAT）

## 2. 打开正确的模板

1. 登录[钉钉开发者后台](https://open-dev.dingtalk.com/)。
2. 切换到部署 MetaSheet 的同一组织。
3. 打开对应企业内部应用，确认应用名称和 Client ID 与部署配置对应。
4. 进入卡片平台：`https://open-dev.dingtalk.com/fe/card`。
5. 打开「模板管理 → 模板列表」。
6. 同时核对模板名称和模板 ID，不能只凭模板名称判断。

本证据包未保留包含个人姓名且不承重的模板列表全景。实施时应截取或遮盖个人姓名后，只保留模板名称、模板 ID、状态和更新时间。

## 3. 配置模板变量

### 3.1 必需变量

MetaSheet 运行时代码使用以下核心变量：

| 变量 | 模板类型 | 用途 |
| --- | --- | --- |
| `title` | 沿用现有定义 | 审批标题 |
| `requestNo` | 沿用现有定义 | 申请单号 |
| `nodeName` | 沿用现有定义 | 当前审批节点 |
| `status` | 沿用现有定义 | 卡片状态与既有条件判断 |
| `statusText` | 沿用现有定义 | 服务端生成的展示文案 |
| `rejectUrl` | 沿用现有定义 | 「拒绝」按钮的驳回深链，打开要求填写意见的决策页 |
| `actionsVisible` | **公共布尔变量** | 控制整个操作区是否显示 |

不要顺手修改已有变量的类型、名称或可见性；本次只新增 `actionsVisible`。

### 3.2 新增 `actionsVisible`

1. 打开模板编辑器的「变量」面板。
2. 新增变量 `actionsVisible`。
3. 类型选择**布尔**。
4. 变量保持**公共**，不要开启“私有”。
5. Mock 默认值设为 `true`。

默认 `true` 的目的是兼容新卡初态和旧发送代码；终态隐藏必须由服务端明确更新为 `false`。

![修改前变量清单](assets/dingtalk-card-terminal-actions-20260815/03-template-variables-before.jpg)

上图是修改前证据：变量清单中尚无 `actionsVisible`。新增后应重新进入模板确认该变量仍存在。

## 4. 配置按钮与显示条件

### 4.1 按钮合同

| 按钮 | 配置要求 |
| --- | --- |
| 同意 | action id 必须是字面 `approve`，交给 Stream callback 处理 |
| 拒绝 | 保留现有 `rejectUrl` 深链，不改成无意见的直接驳回 |

不要更改 action id，也不要把「拒绝」改造成内联 callback；当前产品要求驳回时填写意见。

### 4.2 操作区条件

优先选中同时包含「同意」「拒绝」的共同 `横排按钮` 容器，在容器上配置 AND 条件：

1. `status != agree`
2. `status != reject`
3. `actionsVisible == true`

如果两个按钮没有共同容器，才分别给两个按钮配置完全相同的条件。不能只保护其中一个按钮。

![最终操作区显示条件](assets/dingtalk-card-terminal-actions-20260815/04-actions-visible-condition.jpg)

服务端传输合同是：

```text
新卡：actionsVisible = 'true'
terminal executed/stale：actionsVisible = 'false'
中性错误或仍可重试状态：不发送 false
```

`cardParamMap` 的 wire value 是字符串 `'true'` / `'false'`；模板变量本身仍必须定义为布尔类型。

## 5. 保存与发布

1. 修改前先保存模板列表、变量面板和条件面板截图。
2. 完成变量与条件后，离开编辑器再重新进入。
3. 核对 `actionsVisible`、Mock 默认值和三项 AND 条件仍存在。
4. 如果平台显示明确的“保存”或“发布”按钮，完成复核后再点击发布。
5. “重新进入后配置仍存在”和模板列表显示“已发布”不能单独证明修改已进入线上有效版本；还必须核对发布历史或模板更新时间已晚于本次修改。
6. 如果模板列表更新时间未变化，或编辑器“最近修改”仍早于本次操作，判为**未证明发布**，停止 UAT。

编辑器画布的 Mock 展示不是运行态验收。即使画布同时显示两个条件分支，也必须用真实新卡验证。

本证据包未保留包含个人姓名且不承重的模板编辑器全景；变量和条件两张局部截图是当前承重证据。

## 6. 部署与 UAT 顺序

严格按以下顺序执行：

1. 模板认识 `actionsVisible`，默认值为 `true`。
2. 合并并部署实现该变量的精确代码 SHA。
3. 保持 Stream OFF，执行 `prepare` 和只读 `status`。
4. 确认恰好一个 eligible integration、至少两个已绑定本地用户。
5. 使用具备审批管理权限的账号，证明存在已发布模板及规则：
   `approval.task_created → send_dingtalk_approval_card`。
6. 普通员工从该模板创建一条专用 UAT 审批。
7. 经 owner 明确批准后短时开启 Stream，执行真实卡片 UAT。
8. 无论通过或失败，最后都关闭 Stream 并证明 worker 为 `disabled`。

最低真实验收矩阵：

| 场景 | 期望 |
| --- | --- |
| 新卡 | 卡片送达正确受理人；同意、拒绝都显示；正文无业务表单值 |
| 正常同意 | 只产生一次审批写入；卡面显示服务端终态；两个按钮消失 |
| 重复点击 | 不产生第二次审批写入；仍显示真实终态 |
| 非受理人点击 | 无越权写入；显示无权处理 |
| 未绑定账号点击 | 不调用审批引擎；提示先绑定本地账号 |
| 拒绝 | 打开驳回决策页并强制填写意见 |
| 真实 callback | corp anchor 与投放台账所属 integration 匹配 |
| 窗口关闭 | Stream OFF，worker disabled，不再连接 |

完整 U1-U13 以 `approval-dingtalk-slice-b-uat-checklist-20260710.md` 为准。

## 7. 常见问题

### 7.1 新卡没有送达

按顺序检查：

1. 是否真的从已发布审批模板创建，而不是从一个未接审批引擎的业务表单入口创建。
2. 是否存在已启用规则 `approval.task_created → send_dingtalk_approval_card`。
3. 受理人是否为 active、linked 的本地用户，且属于正确 integration/corp。
4. Stream 的 Client ID、Client Secret、模板 ID 和 integration ID 是否已准备。
5. `DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED` 是否只在获批窗口内为 true。
6. 投放台账是否为 `delivery_kind='interactive_card'`、`send_status='sent'`。

没有证明步骤 1 和 2 时，“没收到卡”只能判为 U1 BLOCKED，不能直接判发送代码失败。

### 7.2 点击同意没有反应

检查：

- worker 是否真实启动；`started` 不等于 SDK 已连接；
- 点击账号是否已绑定 enabled local user；
- callback 是否带可用的 `eventCorpId` 或 body `corpId`；
- callback corp 是否与 delivery 的 integration corp 一致；
- 日志级别是否允许 values-free corp-anchor 探针输出。

### 7.3 审批完成后按钮仍存在

检查：

- `actionsVisible` 是否为公共布尔变量；
- 两个按钮是否共享同一个受保护容器；
- terminal update 是否发送字符串 `'false'`；
- 测试卡是否在模板修改和代码部署之后新建；
- 钉钉更新卡片 API 是否成功；不要用编辑器 Mock 代替真实卡面。

如果 `statusText` 已在同一张卡上变为 terminal 文案，但按钮仍在：

1. 先判定 callback 和卡片更新链已到达，不要重复点击。
2. 核对线上有效模板的发布/更新时间，而不是只看“已发布”标签。
3. 使用能看见该模板的创建人或应用管理员账号；看不到模板时不得推断配置已上线。
4. 钉钉 API 的 `cardParamMap` 是 `Map<String, String>`；官方文档规定布尔值以字符串 `"true"` / `"false"` 传递。因此先查模板版本和条件，不要把后端改成 JSON boolean。
5. 复测必须新建发布后的卡片，旧卡不作为模板版本切换后的验收证据。

### 7.4 `redirect_uri` 报错

这是 OAuth 应用的「登录与分享」回调域配置问题，与互动卡模板变量无关。必须在同一个钉钉应用中配置与部署完全一致的 HTTPS callback URL。

## 8. 回滚

出现投放失败、callback 无企业锚点、越权写入或按钮状态错误时：

1. 立即关闭 Stream flag 并重启 backend。
2. 确认 worker 为 `disabled`，生命周期开关保持 OFF。
3. 保留 values-free 日志、delivery 状态和脱敏截图。
4. 代码回滚到上一精确 SHA。
5. 只有确认模板变更本身导致投放失败时，才回滚模板。

不得在日志或文档中记录 Client Secret、token、完整 corp id、手机号、姓名或审批表单值。

## 9. 当前 staging 状态（2026-08-16）

- 已复制当前替代模板 `MetaSheetCanaryUAT3`，平台显示已发布，模板 ID 已写入 staging；签名 secret 只保存在 GitHub secret 和 staging env，不在本文记录值。由于当前证据包没有 UAT3 发布历史或晚于修改时间的模板列表截图，线上有效版本仍须在下一次窗口前复核。
- 代码 PR #4916 已部署到精确 merge SHA。
- 替代模板发布后的 prepare 与只读 status 已通过，四项运行配置存在；唯一 eligible anchor 和 2 个 linked local users 成立。
- 第二次真实 UAT 的新卡已送达，点击同意后审批和状态文案均进入 terminal，但两个按钮仍显示，因此操作区退场为 **FAILED**。
- 上述失败属于历史模板 `MetaSheetCanaryUAT`；当前替代模板尚未发送发布后新卡，因此其 terminal 操作区退场是 **NOT EXECUTED**，不是 PASS。
- Stream 已关闭；worker 为 `disabled`；三个 lifecycle flags 全部 OFF。prepare 没有开启 Stream。
- 最新只读 status [run 31937073799](https://github.com/zensgit/metasheet2/actions/runs/31937073799) 再次证明 exact deployed SHA、backend health、四项 Stream 配置、唯一 eligible anchor、2 个 linked local users 及上述 OFF 状态；`stream_connected=unknown`，不把只读快照写成连接或 callback 证据。
- 当前状态不能写成“真实卡片 UAT 已通过”；必须在另行批准的短窗口中用 `MetaSheetCanaryUAT3` 新卡复验并安全关闭。

详细执行证据见：

- `dingtalk-interactive-card-terminal-actions-runbook-20260815.md`
- `approval-dingtalk-slice-b-uat-checklist-20260710.md`
- `dingtalk-hardening-real-uat-evidence-pack-20260713.md`

## 10. 官方参考

- [钉钉开放平台：使用事件链实现卡片互动](https://open.dingtalk.com/document/dingstart/using-event-chains-for-card-interaction)
- [钉钉开放平台：API 卡片数据的填写说明](https://open.dingtalk.com/document/orgapp/instructions-for-filling-in-api-card-data)
- [钉钉开放平台：更新钉钉互动卡片](https://open.dingtalk.com/document/isvapp-server/update-dingtalk-interactive-cards)
