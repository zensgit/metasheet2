# metasheet AI 战略与边界设计(2026-09-01)

> **地位**:RATIFIED——owner 战略裁决(2026-09-01),本稿把裁决落成文档。三条铁律(§1)与 AI 边界架构(§3)是硬约束,后续任何 AI 相关设计/PR 须与本稿一致,冲突以本稿为准;部署分档(§4)、四个押注(§5)、开源姿态(§6)是本稿给出的执行方向,具体落地细节留给各自的实现分支/设计稿裁定。基线 `origin/main`。
> **本稿是"上位文档"**:两份并行子设计已把本稿当作上位引用——`docs/development/platform-overall-design/stock-prep-change-adjudication-20260901.md`(§3.6"AI 摘要助手",押注②的落地设计)与 `docs/development/platform-overall-design/self-hosted-model-selection-spike-20260901.md`(部署分档一的选型/硬件/RAG 展开)。本稿写作时二者均在未合入 main 的并行分支上;若合并顺序有出入,以三份文档互相 review 后的最终版本为准。AI 边界骨架本身在另一并行分支 `feat/metasheet-ai-service-boundary` 上实现,本稿是其设计依据,不是其实现记录。
> **本稿不是从零设计**:平台已经有一段 AI 能力在生产运行——多维表 AI 批量填充(bulk-fill)/字段 AI 捷径,受一套声明式 provider 就绪门(`MULTITABLE_AI_*` 环境契约)与人工确认后写入网关约束,详见 §2。本稿是在这套既有实践之上做的**平台级战略与边界扩展**,不是推倒重来。
> values-free:本稿不含主机名 / IP / 口令 / 凭据 / 客户身份信息;金额与硬件规格一律不在本稿展开(见 §4 对子文档的引用)。

---

## 0. 一句话结论

**模型是租来的商品,不是我们的护城河;护城河是喂给模型的客户专属数据(schema/字典/裁决历史)与一套确定性的治理规则层。** 三条铁律锁死了三件事不能做(§1);一个 AI 边界把"数据分类怎么路由 / AI 输出怎么标注 / 人工确认怎么兜底"收敛到一处强制点(§3);默认给中国制造业内网客户的答案是**在客户内网 GPU 上自托管一个开放权重模型**(Qwen/DeepSeek/GLM 量级,14B~32B),这是部署一个已有模型,不是训练模型(§4);四个 AI 押注全部是"副驾"形态——建议、解释、摘要、草拟,人工确认后才产生任何权威后果(§5);AI 边界本身的代码值得未来考虑开源以换取内网客户的信任,但护城河数据永不开源,而且现在的正确姿态是"签约客户可审计源码",不是公开开源(§6)。

---

## 1. 三条铁律(不可谈判)

### 1.1 绝不训练、绝不微调自有模型

我们打不过主流模型(GPT / Claude / Qwen / DeepSeek),而且训练是一个吞钱吞人的无底洞。模型是商品——租用云端 API,或者自托管一个开放权重模型,两者都是"部署",不是"训练"。

微调不是被永久禁止,而是被放到**遥远的、狭窄的最后手段**位置:只有当某个具体任务同时满足**高频、稳定、成本敏感、且已经把 prompt 工程/RAG 用到头仍不够**这四个条件时,才值得考虑针对性的小模型微调——今天平台没有任何一个 AI 任务处在这个位置(§5 的四个押注全部是低频咨询型任务),所以这不是现在要做的事。

护城河不是模型本身,是喂给模型的**专属上下文**——客户的 schema、`Bom_ExAttr1` 这类厂商字典(见 `#5385` 的 preset 目录设计)、metasheet 侧积累的人工裁决历史——通过检索增强(RAG)喂给一个租来的或自托管的顶级模型,再加上一层确定性的治理规则(§3 的边界)。这两样东西合在一起才是护城河;模型本身谁都能调用。

### 1.2 副驾不船长(copilot, not captain)

AI 只能**建议 / 解释 / 起草 / 摘要**;人 + 确定性规则做决定。AI 在任何场景下都不能做出权威性决定——不能决定什么数据进入正式主表(canonical `plm_stock_preparation_main` 一类),不能做采购数量的算术决策,不能替代审批。

这不是一句口号,是平台已有代码在强制的一条纪律。`plugins/plugin-integration-core/lib/stock-preparation-conflict-planner.cjs` 的每一个决策构造函数(`ADD`/`UPDATE`/`INACTIVE`)都调用 `assertNoHumanFields`——机器**不可能**写入 `human_preserved` 列,这是运行时断言,不是文档约定;`stock-preparation-suggestion-operators.cjs` 的两个算子(`computeDemandDateCascade`/`crossProjectPrefillCandidates`)只产出建议(`applyMode: 'k2_confirm_required'`),从不直接落地。AI 押注只是把这条已经在生产验证过的纪律,延伸到模型生成的内容上——AI 产出的建议走的是与人工建议完全相同的确认写入路径,不新开一条更弱的通道。

### 1.3 业务数据默认不出内网

客户的 BOM、图纸、采购数据默认留在内网,只喂给一个**本地模型**。这条铁律直接决定了 §4 的部署分档:任何触碰真实业务数据(BOM 行、图纸、物料、采购数量)的 AI 任务,默认路由必须落在内网自托管模型上;云端 API 只对不涉及客户业务数据的任务开放,且要按部署配置显式选择(见 §3 的数据分类路由)。

---

## 2. 现状盘点:平台已经有的 AI 实践,本稿在其上扩展

平台的多维表(multitable)AI 批量填充 / AI 字段捷径功能已经在生产代码里落地了一套治理纪律,本稿的边界设计(§3)直接沿用、扩展这套纪律,而不是另起一套。

**声明式 provider 就绪门(`packages/core-backend/src/services/ai-provider-readiness.ts`)**——`MULTITABLE_AI_*` 环境契约:`AI_ENABLED`/`AI_PROVIDER`/`AI_API_KEY`/`AI_MODEL` 为必填四项(E-1~E-5,`AI_REQUIRED_ENV`),`AI_BASE_URL`、请求超时、租户日/周 token 上限、突发 RPM、账号日均 USD 上限均为可选声明(E-4、E-6~E-11);默认部署姿态是**关闭**——`AI_ENABLED` 不为 `'1'` 时状态是 `disabled`,消息原文"multitable AI readiness is disabled (default deployment posture)"(`:210-215`)。这正是 §3(e)"fail-open"原则今天已经在跑的具体实现:AI 默认关闭,关闭时多维表的其余功能(含人工手填)零依赖它。

**provider 允许表今天只有云端两家(`anthropic`/`openai`,`:56`)**——这是本稿要指出的一处明确缺口,不是要否定既有设计:今天的契约是"provider 无关"的通用声明,还没有"数据分类"这个维度。`AI_MODEL_ALLOWLISTS`(`:63-78`)与价格表(`ai-provider-client.ts` 的 `AiModelPrice`)目前只列了 GPT/Claude 系列型号名。§4 的自托管路线**不需要新造协议**——`ai-provider-client.ts:238` 对 `openai` provider 固定拼 `${baseUrl}/v1/chat/completions`,`baseUrl` 取自 `MULTITABLE_AI_BASE_URL`(`:40` 附近注释),而 vLLM 的 OpenAI 兼容端点实现的正是这套协议;把自托管模型接进来只需要扩展模型允许表(或新增一个独立的 `self-hosted` provider key,避免与云端 OpenAI 的成本/限流假设混淆)与价格表(自托管模型按资产折旧记账,不是按 token 计费,但价格表**不能留空**——`preflight()` 对不在价格表里的型号硬阻断,消息原文"refusing to spend unaccounted tokens",`:205`,这条"不静默 $0"的安全属性本身值得保留,自托管模型也要显式记一行价格,而不是绕开这条防护)。这两处扩展是 §3 边界骨架分支(`feat/metasheet-ai-service-boundary`)与 `docs/development/platform-overall-design/self-hosted-model-selection-spike-20260901.md` §5.2/§10 列出的后续实现工作,本稿不重复其细节。

**人工确认后写入的既有网关**——`docs/development/multitable-ai-bulk-fill-review-before-write-designlock-20260621.md` 锁定的模式:生成建议值 → 展示 diff → 人工确认 → 才写入。这是生产已验证的机制,不是为本稿新造的。

**"AI 输出是不可信写入源"的既有边界锁**——`docs/development/multitable-ai-output-untrusted-write-source-designlock-20260705.md` 明确:模型输出是**未受信任的数据,不是受信任的命令**,不携带任何权限,必须对目标域做 fail-closed 校验,并重新走一遍人工写入会走的同一条权限/no-oracle/写入膜(cross-base 写入建立的两段式鉴权先例),不允许给 AI 派生写入开一条更弱的平行通道。

**用量/成本可见性(metering)**——`multitable_ai_usage_ledger` 记录每条请求的 provider/model/token/预估成本/状态(`docs/development/multitable-ai-cost-visibility-s4-designlock-20260706.md`),reserve-then-settle 记账、按字段/按调用方聚合,§3(f)的"计量与限额"在多维表侧已经是生产实现,不是新概念。

**人工列高墙(human-column wall)**——备料线 `STOCK_PREPARATION_FIELD_OWNERSHIPS = ['plm_system', 'human_preserved']`(`stock-preparation-templates.cjs:12`),8 个 `human_preserved` 列(`materialType`/`demandDate`/`procurementReply`/`warehouseConfirmation` 等)在 PLM 刷新时强制 `preserveOnRefresh = true`,且如上文所述,机器写入路径被 `assertNoHumanFields` 断言禁止触碰这些列。这是"人工确认门"之外,平台已有的另一道结构性防线,§7 明确要求 AI 押注不得绕过或削弱它。

---

## 3. AI 边界架构:一处强制点

**"一个受治理的 AI 服务边界"**是本稿的核心裁决:一个数据分类模型路由(data-classification model router),把下面这六条规则收敛在**一处**强制,而不是分散在每个调用 AI 的功能里各自实现一遍。这套边界的骨架实现在并行分支 `feat/metasheet-ai-service-boundary` 上进行,本稿是它的设计依据。

**(a)数据分类路由**——业务数据(客户 BOM、图纸、采购数据、任何源自客户内网系统的行值)只能路由到本地 provider;非敏感任务(如平台自身的操作型元数据、公开的错误码/文档检索)可以按部署配置选择云端。这是对 §2 现状缺口的直接回应:今天的 `MULTITABLE_AI_*` 契约没有分类维度,新增一个数据分类任务(如 §5 押注①②这类直接触碰客户 BOM/schema 的场景)必须先过这道分类路由,再决定 provider,不能沿用今天"provider 由部署方随便配"的通用姿态。

**(b)溯源标注**——AI 产出的一切内容必须标注"AI 建议/生成·待确认",且这条标注不得与源数据混排,读者任何时候都能一眼分清哪些是系统事实、哪些是模型的话。

**(c)仅建议执行**——AI 绝不提交权威数据、绝不触发无人工确认闸的副作用;一切可撤销。这是 §1.2 铁律在架构层的落地,直接复用 §2 已有的人工确认后写入网关与"不可信写入源"边界锁,不新造一条平行通道。

**(d)溯源引用(grounding/citation)**——AI 的回答必须引用它所依据的源数据行,不允许在采购语境里出现编造出来的数字。这一条对应 §4/§6 描述的 RAG 架构:检索到的每条依据在 prompt 里都带来源标注(哪张字典表、哪条历史决策、是否人工确认过),使人工确认时能看到"模型是基于什么做的建议",而不是一段不可追溯的生成文本。

**(e)fail-open**——AI 不可用时,完整流程必须仍能纯人工走通。AI 是增强,永远不是依赖,永远不进热路径。§2 已经证明这条原则今天在跑:`AI_ENABLED` 默认关闭时,多维表照常人工填表;§5 的四个押注同样要求"AI 关闭时,对应功能仍完整可用,只是少了一条建议/摘要/解释"。

**(f)计量与限额**——每一次 AI 调用都要计量、要有上限。§2 描述的用量台账 + reserve-then-settle 记账 + 声明式 caps 是这一条的既有实现,边界骨架把它作为跨所有 AI 消费方的统一底座,而不是每个功能各自维护一份配额逻辑。

以上六条不是六个独立开关,是**一处**强制点——任何新 AI 功能接入平台,都通过这一个边界,而不是自己实现一遍(a)-(f)。这正是本稿称之为"边界",而不是"若干条指导原则"的原因。

---

## 4. 部署与模型策略:第三方模型 + 内网可用的现实

诚实地说清楚一个现实:**闭源模型(GPT/Claude)不能跑在客户内网里**——它们只有 API,调用即意味着数据出网,这对要求数据留在内网的中国制造业客户不成立(数据驻留 + 境内合规/可达性)。合同层面的"零留存 / 不用于训练"承诺是**信任**,不是**物理隔离**——它约束的是供应商愿不愿意,不是数据物理上离不开客户网络这件事本身。

**给中国制造业内网客户(主场景)的默认答案:在客户内网一台 GPU 机器上自托管一个开放权重模型(Qwen / DeepSeek / GLM,量级 14B~32B)——数据永不出网。这是部署一个已有模型,不是训练模型。** 平台的四类 AI 任务(schema 映射建议、变更摘要、自然语言转筛选、报错解释)都不是前沿难题——一个中等规模开源模型 + 对客户自己字典/历史的检索增强(RAG),绰绰有余。这条路线的选型、硬件分档、服务栈(vLLM 起 OpenAI 兼容端点)、RAG 方案(pgvector、BGE-M3 embedding、按客户隔离检索)、成本/延迟包络、以及"接入既有 AI provider 边界只需扩展模型允许表 + 价格表、协议层零改动"这一关键发现,详见 `docs/development/platform-overall-design/self-hosted-model-selection-spike-20260901.md`,本稿不重复其细节,只承接其结论。

三档部署,全部由同一个边界(§3)承载:

| 档位 | 形态 | 隔离依据 | 备注 |
|---|---|---|---|
| **① 内网自托管开源模型(默认)** | 客户内网 GPU 盒子,物理隔离 | 数据从不离开客户网络 | 中国制造业内网客户的默认路径;详见自托管选型 spike |
| **② 境内云专属实例 / VPC** | 合同 + 租户隔离 | 供应商承诺 + 网络/租户边界(Azure OpenAI / AWS Bedrock 模式的境内对应物——云端租户隔离,供应商看不到数据) | 适合可接受云端但要求租户级隔离的客户 |
| **③ 云端 API + 零留存合同** | 信任模型 | 合同承诺,业务数据仍然禁止喂入 | 仅用于非业务数据任务;不是业务数据的默认路径 |

竞品("用第三方模型,数据是安全的")今天实际怎么做:云端租户隔离(Azure OpenAI / Bedrock 模式)、或合同/零留存承诺、或数据脱敏、或传输加密——**没有一种能满足"数据完全不离开客户自己的网络"**。这正是"内网自托管开源模型"对内网客户构成差异化的原因:我们不是在做一个更好的信任承诺,是在做一个客户可以自己验证的物理事实。

机密计算 / TEE 推理值得作为未来的观察项记录在案,但不是现在的赌注——技术与生态成熟度都还不到可以拿来做产品决策的程度。

---

## 5. 四个 AI 押注(按杠杆排序)

四个押注全部满足同一组约束:**仅建议、有溯源、可撤销、带来源标注**——这四条不是四选一,是每个押注都要同时满足的门槛。

### 5.1 列映射副驾(schema-mapping copilot)—— 杠杆最高、最安全的第一个功能

客户源系统的列名对我们零语义(如 PLM 侧的 `Bom_ExAttr1`,`plugins/plugin-integration-core/lib/stock-preparation-bom-expansion.cjs:221`),含义散落在源系统自己的字典表里。AI 的角色是:检索客户字典表 + 同类历史映射,提出"这一列很可能是数量 / 这一列很可能是物料编码"的建议,并**给出推理依据**;人工确认后,输出**不是运行时 AI 调用,而是一份可复用的确定性 preset**——复用 `#5385` 已经合入 main 的 vendor preset 目录 schema(`plugins/plugin-integration-core/lib/source-vendor-presets/`)。

这是排第一的原因:产出物是一份**可审查的 preset**,不是运行时决策——一旦人工确认,后续每次接入同类客户走的都是确定性代码路径,AI 只在"第一次见到这套陌生 schema"时被咨询一次,不进入任何正式数据的写入热路径。在边界骨架(§3)落地之后实现。

### 5.2 变更影响摘要(change-impact summary)

BOM 变更 + 其对采购的影响,由 AI 摘要成一句人话(如"封头材料 S30408→S31603,3 件受影响,建议重新采购"),人工据此行动。这是 `docs/development/platform-overall-design/stock-prep-change-adjudication-20260901.md` 所设计的变更裁决五层智能化中的 AI 咨询层(该稿 §3.6"AI 摘要助手"):该稿的立场与本稿完全一致——"写入正式主表前的合并/采购/裁决动作绝不能由黑箱模型决定";裁决全部由确定性规则/签名匹配/决策记忆(§8)完成,AI 只在辅助位置起草摘要与建议措辞,落哪个裁决永远是人 + 已记录的规则说了算。该稿并给出了具体的输入范围收窄(仅诊断字段:变化类型/字段名/量级,不含未脱敏的业务原文任意拼接)与默认可关(`MULTITABLE_AI_ENABLED` 为假时系统提议仍完整可用)——是本押注在边界之下的一份具体落地设计。

### 5.3 自然语言查数 / 建视图(NL → filter/view)

用户中文自然语言诉求转成结构化的筛选/视图定义,只读,结果可核验——用户看到的是筛选后的真实数据行,不是模型编出来的答案,幻觉空间被"结果必须是真实查询"这条结构性约束天然压缩。

### 5.4 错误 / 下一步解释(error/next-step explainer)

把不透明的错误码翻译成"做什么下一步"。平台已有一套设计到位的错误码人话化基建(`errorCodeLabels.ts`,design-lock IU-1,#3739),AI 押注是在检索不到既有人话映射时的补充解释层,不是替代它。

---

## 6. 开源策略(owner 裁决,2026-09-01)

"做开源 AI"这句话至少有三层不同的含义,必须分开裁决,不能笼统地问"我们要不要开源"。

### 6.1 三层含义,三个裁决

1. **训练/构建自己的模型 → 不做。** 已在铁律一(§1.1)裁定:训练是钱和人才的无底洞,打不过主流模型,不重复论证。
2. **使用开放权重模型 → 做,而且是差异化。** 在客户内网自托管 Qwen/DeepSeek/GLM(§4)——这不是"开源 AI 情怀",是解决"数据不出网"这条铁律(§1.3)唯一可行的路径,是我们对内网客户的差异化能力。
3. **把我们自己这层 AI 能力开源出去 → 分两半裁决,见下。**

### 6.2 永不开源的部分:护城河数据资产

**preset 内容库**(`#5385` 那类"某个厂商家族的列语义积累"——如"DN_PDM 家族:数量在 `Bom_ExAttr1`")、**决策记忆**(§8,客户历史是怎么裁决的)、**客户字典/映射历史**——这些永不开源,任何形式都不行(公开仓库、公开文档摘录、示例数据集均不行)。

理由是结构性的,不是保守:这些内容是**一个客户一个客户真实接入攒出来的**,不是写代码写出来的。代码是可复现的——任何人看了设计都能重写一遍;这份数据不是——它是我们花时间、花信任、一家一家客户接入换来的沉淀,开源出去等于把"接入能力"直接送给竞争对手,而竞争对手不需要付出我们付出过的那部分成本。§1.1 已经说过护城河是数据不是模型,这一条是它在开源姿态上的直接推论。

### 6.3 值得开源的部分:AI 边界本身——但不是现在

**AI 边界(§3)是唯一值得未来考虑开源的部分。** 理由:一个可审计、公开的 AI 服务边界,能把内网客户对我们的第一个疑虑——"我的 BOM 会不会泄露给 AI"——从一句口头承诺,变成一件可验证的事实("你自己读代码:业务数据只会被路由到本地模型")。这套边界本身是**通用管道**,不含任何护城河——路由逻辑、溯源标注格式、确认网关的形状,这些代码复现成本低,竞争对手抄走也拿不到我们的数据资产。开源它对安全敏感客户是纯粹的信任加分,对我们没有实质成本。

**但不是现在**,理由有三:AI 功能本身还没有正式上线(§5 四个押注都在实现路径上,不是既成产品);一个半成品的公开仓库比不公开更糟——公开等于承诺维护;团队规模小,没有余力应对公开开源带来的 issue / PR / 社区维护负担——每一分精力现阶段都要留给客户接入本身。

### 6.4 现在就能采纳的近零成本中间路径:签约客户源码可审计

不公开开源,而是**给已签约客户开放 AI 边界源码的只读审计权限**。这条路径能拿到公开开源约 80% 的信任收益(客户能自己验证"业务数据只路由到本地模型"这句话),但零维护负担(不面向陌生公众,不需要社区运营,不承诺向后兼容)。在 B2B 场景里,"我可以核实"比"全世界都能下载"更有说服力——对方要的是对自己这一份合同的确信,不是开源许可证本身。

### 6.5 一般化裁决规则

**开放不含数据资产的通用信任/生态型组件;守住一切被客户数据喂养过的东西。** 判据只有一条:这段代码/内容里有没有沉淀客户专属信息——preset 内容、决策记忆、字典映射历史,答案是"有",守住;AI 边界的路由/标注/网关逻辑本身,答案是"没有",可以考虑开放,但"可以考虑"不等于"现在就做"(§6.3)。

---

## 7. 非目标 / 必须保留

- **不做**:AI 做出权威性决定;AI 作为事实源(source-of-truth);AI 触发不可逆动作;把 AI 放进热路径(任何核心读写流程不得因 AI 不可用而失败或变慢)。
- **保留**:人工确认门(§2 的 review-before-write 网关)、人工列高墙(§2 的 `human_preserved` 断言)、确定性核心逻辑(裁决/采购数量计算/写入正式主表的判定,永远是规则代码,不是模型推理)。

---

## 8. 决策记忆:唯一合法的"学习",且它不是模型训练

有一种"学习"是合法的,必须与"训练/微调模型"(§1.1 禁止的那件事)严格区分开:**把客户的历史裁决积累成可审计的规则,而不是模型权重。**

平台已经有这个形状的生产实现——`stock-preparation-material-match.cjs` 的 `HISTORICAL_CONFIRMED` 匹配方法:按签名(图号+版本)查一份已确认的历史映射,命中就以置信度 1 直接复用,并带出 `confirmedBy`/`confirmedAt`;歧义时退化为多候选/版本冲突,**从不瞎猜**。`docs/development/platform-overall-design/stock-prep-change-adjudication-20260901.md` §3.4(该稿"层④决策记忆")把同一个形状搬到 BOM 变更裁决:确认台账里每一条 `CONFIRMED` 记录本身就是一条有日期、有操作人、可点开、可撤销的裁决;新出现的同类冲突按更粗粒度的签名去查历史台账,命中就把历史裁决作为**预填提议**摆在卡片上,人依然要走与今天完全相同的确认接口才能落地——从不自动生效。

这与模型训练的本质区别:模型训练是把大量样本压缩进一组不可读的权重,决策依据事后无法逐条追溯;决策记忆是**台账里一行行看得见、点得开、能撤销的记录**,每一条都是某个具体的人在某个具体日期做的具体判断。这条设计是本稿铁律一(§1.1)在"要不要让系统变聪明"这个问题上的唯一答案:变聪明的方式是让规则代码更懂客户的历史,不是让模型权重更懂客户的数据。

---

## 9. 关联文档

- 声明式 provider 就绪门:`packages/core-backend/src/services/ai-provider-readiness.ts`;设计出处 `docs/development/multitable-ai-provider-readiness-a1-design-20260610.md`。
- provider 调用客户端(baseUrl/协议/价格表):`packages/core-backend/src/services/ai-provider-client.ts`。
- 人工确认后写入网关:`docs/development/multitable-ai-bulk-fill-review-before-write-designlock-20260621.md`。
- AI 输出作为不可信写入源的边界锁:`docs/development/multitable-ai-output-untrusted-write-source-designlock-20260705.md`。
- 用量/成本可见性:`docs/development/multitable-ai-cost-visibility-s4-designlock-20260706.md`。
- 租户隔离先例:`docs/development/multitable-ai-l05-tenant-scoped-live-gate-designlock-20260707.md`。
- 厂商 preset 目录(押注①的产出物形状):PR `#5385`,`plugins/plugin-integration-core/lib/source-vendor-presets/`。
- 变更裁决五层智能化(押注②的落地设计,含决策记忆层④、AI 摘要助手层 3.6):`docs/development/platform-overall-design/stock-prep-change-adjudication-20260901.md`(并行分支,写作时未合入 main)。
- 自托管开源模型选型/硬件/RAG 展开(部署分档一的详细设计):`docs/development/platform-overall-design/self-hosted-model-selection-spike-20260901.md`(并行分支,写作时未合入 main)。
- AI 边界骨架实现:并行分支 `feat/metasheet-ai-service-boundary`(写作时未合入 main)。
- 人工列高墙 / human_preserved:`plugins/plugin-integration-core/lib/stock-preparation-templates.cjs`;裁决安全断言:`plugins/plugin-integration-core/lib/stock-preparation-conflict-planner.cjs`(`assertNoHumanFields`)。
- 决策记忆的既有生产先例:`plugins/plugin-integration-core/lib/stock-preparation-material-match.cjs`(`HISTORICAL_CONFIRMED`/`selectHistoricalMapping`)。
