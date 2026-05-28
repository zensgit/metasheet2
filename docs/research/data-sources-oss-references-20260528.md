# 外接数据源框架 — 开源对标研究笔记(内部 / bounded)

> 状态:**审阅修订稿**,已落 `docs/research/`。
> 性质:**内部研究**,可出现外部产品名;**不进正式设计文档**(正式文档只述 MetaSheet 自有原则)。
> 方法:**bounded patterns 研究**(基于公开资料/已知架构,不 clone、不逐行读源码——深度源码研究留到真要采用时)。
> 目的:把我们已落的 Lane A 四件事(A0.1/A-RO/A1/A4 已合并)与成熟开源系统对标,确认选择、找可借鉴模式、明确"我们规模下该/不该做什么"。

## 0. 候选系统与 license(借鉴边界)
| 系统 | 栈 | License | 借鉴边界 |
|---|---|---|---|
| n8n (`n8n-io/n8n`) | TS/Node | Sustainable-Use(源码可读,非 OSI) | **只学模式,别抄码** |
| Redash (`getredash/redash`) | Python/Flask | BSD-2 | 可借鉴实现 |
| Superset (`apache/superset`) | Python/Flask | Apache-2.0 | 可借鉴实现 |
| Metabase (`metabase/metabase`) | Clojure+TS | AGPL-3.0 | **只学模式,别抄码** |
| Knex (`knex/knex`) | JS | MIT | 可直接依赖 |
| Airbyte (`airbytehq/airbyte`) connectors | 多 | 根仓库 ELv2;具体 connector / artifact 需逐项核 license | connector 规格可借鉴 |

---

## 方向 1 — 凭据加密(对标我们 A1)
**我们现状**:secret 字段(password/apiKey/token)`encryptStoredSecretValue`(AES-256-GCM,`ENCRYPTION_KEY` 派生)per-field 加密落 JSONB,加载解密;username 明文;always-encrypt 不靠 `enc:` 前缀猜;decrypt 失败响亮跳过。

**对标**:
- **n8n**(同栈最像):凭据 AES 加密落库,key 取 `N8N_ENCRYPTION_KEY` env——**和我们 `ENCRYPTION_KEY` 同套路**,验证我方选择。差异:n8n 把整条凭据作为"凭据实体"加密;我们 per-field。**重要更新**:n8n 现已支持 encryption key rotation;`N8N_ENCRYPTION_KEY` 保护数据加密 key,旧数据可读,并在后续更新时惰性重加密。
- **Redash**:`EncryptedConfiguration` 把整个 DataSource `options`(JSON)在列级加密(Fernet/AES)。
- **Superset**:`encrypted_extra` 用 `EncryptedType`(SQLAlchemy-Utils,AES)。

**可借鉴 / 我们缺的**:
- **密钥轮换**:我们当前实现仍是"单一 env key 派生 + 解不开就响亮跳过"。但 **n8n 已经证明 rotation 可以做成产品能力**,所以这不该再被写成"行业没人优雅解决"。若未来要补 A1+ 轮换,可参考"key-encrypting-key / data-encryption-key 分层 + 惰性重加密"路线。
- **结论**:A1 的 per-field + env-key-AES 选择被三家验证为主流;无需返工。轮换不再只是抽象增量,已有 n8n 式可借鉴路径。

---

## 方向 2 — 只读保障(对标我们 A-RO)
**我们现状**:per-source `options.readOnly`(默认 true);raw `/query` 闸:SQL 源走 SELECT-only 正则分类器(SELECT/WITH/EXPLAIN/SHOW + 拒多语句/INTO),非 SQL 源只读时直接禁 raw 路径;适配器层 `assertWritable` 防御纵深;明说"真保证靠只读 DB 账号"。

**对标**:
- **Superset**:per-Database 暴露 **"Allow DML" 开关**。**与我们 readOnly 直接对标**;它说明成熟 BI 系统也会把"是否允许写 SQL"做成数据源级开关。
- **Metabase**:native(raw SQL)查询由权限门控;structured 查询天然更受限——对应我们 raw `/query` vs `/select` 的分层。

**可借鉴 / 我们缺的**:
- 我们的**正则分类器是 best-effort**(漏 data-modifying CTE、误拒注释起手)。**升级路径 = 换成 AST / 真解析器**;但仅当正则被证明不够时再上。无论是否升级,**真保证仍靠 DB 只读账号**,这点与成熟系统的立场一致。
- **结论**:A-RO 的"开关 + 分层 + DB 账号才是铁壁"被 Superset/Metabase 双重验证;正则→解析器是按需升级项。

---

## 方向 3 — 归属 / 权限收口(对标我们 A0.1)
**我们现状**:per-source owner(`req.user.id`)收口,list/get/每个 `:id` 操作按 owner 校验(非 owner 404 不泄漏存在性);workspace 共享暂为 null(deferred)。

**对标**:
- **n8n**:凭据有 **owner + 显式 share**(可共享给 user/project;新版按 project 做 RBAC)。**正是我们 deferred 的 workspace-shared 的参考形态**。
- **Redash**:DataSource 绑 group;按 group 授权(更偏"组可见"而非"个人 own")。

**可借鉴 / 我们缺的**:
- 我们现在是**纯 owner-only**(最安全默认)。要做"团队/workspace 共享",**n8n 的 owner+explicit-share 模型**是直接蓝本(owner 默认 + 显式授予,而非全 workspace 可见)。
- **结论**:A0.1 owner-only 是安全默认;workspace-shared 落地时照 n8n 的"显式 share"而非 Redash 的"组全可见",更贴合我们的最小泄漏原则。

---

## 方向 4 — 适配器注册表(对标我们 A4,**最有行动价值**)
**我们现状(A4 已合并)**:之前 zod enum 列了 7 种,registry 只注册 5 种,实际可用仅 postgresql/postgres+http——**enum↔registry↔驱动三方不一致**。A4 已把公开支持矩阵收敛到真正可用集。

**对标**:
- **Metabase**:**driver 插件注册表**——每个 DB driver 是注册进来的插件,"可用驱动列表"**就是**注册表本身;不存在"另维护一份 enum"。
- **Knex**:client 名 → dialect 实现的表;未知 client 直接清晰报错。

**可借鉴(直接改进 A4 的做法)**:
- **别手维护两份公共支持列表**。但对我们当前架构,更贴切的落法不是"从 live registry 直接派生 public enum",而是**抽一份显式的公共支持矩阵真相源**(如 `SUPPORTED_DATA_SOURCE_TYPES`),让路由契约和默认注册共同复用。这样既能**从根上消灭** A4 修的那类不一致,又不会因为未来注册了 internal / opt-in / plugin adapter,就把它们意外暴露成公共 API。
- **结论**:Metabase 的启发是"注册/能力表应成为真相源";但在我们这里应落成**单一公共支持矩阵常量**，而不是机械地从所有已注册 adapter 反推 public enum。

---

## 方向 5(附:回答"n8n 很多服务连接我们能否支持")
**n8n / Airbyte 的广度模型**:n8n 400+ 集成 = node + **可复用凭据类型**(凭据与消费方解耦);Airbyte 每连接器一个包 + `connectionSpecification`(声明字段/哪些是 secret)+ check/discover/read 生命周期。

**MetaSheet 的位置**:
- 框架**可扩**(已有 HTTP/PLM/Athena 超出 DB),但**产品方向是 ERP/DB 集成**(阶段二 Data Factory 源→multitable→目标),**不是通用 SaaS 集成平台**。
- 新增连接器 = **阶段二 connector 工作,当前冻结**,每个单独 gated opt-in(K3 lock + 阶段二 freeze)。
- **若广度成为目标**(战略决策,非当前 scope):借 **n8n 可复用凭据类型注册表**(我们现在凭据是 per-source 1:1)+ **Airbyte connector spec**(声明式连接器,降 onboarding 成本——与 #1874 记的"FaaS escape-hatch 简化 onboarding"方向一致)。
- **结论**:技术上可扩、产品上 gated;**不会自动支持一堆服务**,按阶段二一条条开。

---

## 总结:五条对标的净产出
1. **A1**:per-field + env-key-AES 是主流,选择无需返工;密钥轮换已有 n8n 式可借鉴路径。
2. **A-RO**:开关+分层+"DB 账号才是铁壁"被双重验证;正则→真解析器为按需升级。
3. **A0.1**:owner-only 是安全默认;workspace-shared 照 n8n 显式 share 模型。
4. **A4**:**最有价值——抽单一公共支持矩阵真相源**,让契约和默认注册共同复用,从根消灭三方不一致。
5. **广度**:技术可扩、产品 gated;广度真要做则借 n8n 凭据类型注册表 + Airbyte connector spec。但凡引用 Airbyte 具体 connector,**license 必须逐项核实**,别把根仓库 license 粗暴外推到所有 artifact。

## 公开参考入口
- n8n encryption key rotation: <https://docs.n8n.io/hosting/securing/encryption-key-rotation/>
- n8n custom encryption key: <https://docs.n8n.io/hosting/configuration/configuration-examples/encryption-key/>
- Airbyte root license: <https://github.com/airbytehq/airbyte/blob/master/LICENSE>
- Superset database API schema (`allow_dml`): <https://superset.apache.org/developer-docs/api/schemas/databaserestapi-post/>
- Metabase data permissions: <https://www.metabase.com/docs/latest/permissions/data>
