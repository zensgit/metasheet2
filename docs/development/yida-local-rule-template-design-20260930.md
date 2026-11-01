# SA-04D：宜搭本地规则草稿复用

日期2026-09-30；代码基线b35d4cd1叠本地SA01–05C2。目标是已有静态预演的真实用户操作，不是另建模板库、在线保存/审批或发送授权。本地实施；不提交/发布、访问客户或发外部请求。

## 1. 实读缺口与范围

当前StockPreparationYidaPreviewPanel所有配置都是组件内存，只有合成样例加载；看板scope/project变化卸载。无配置导出再载入入口。复用同一面板与实际validateYidaStaticConfig，不复制v1/v2验证器。分配module已有规则校验但与projects捆绑；提取实际公共规则校验并让原预演调用同一实现，不拿假rows/projects冒充规则验证。

只增加显式“生成规则草稿JSON”和“加载粘贴的规则草稿JSON”；本轮不新增文件异步读取、浏览器剪贴板写入、自动下载、Storage/IndexedDB或网络。用户可以自行保存文本并在下次打开时粘贴；不能说服务器已保存或配置已发布。

## 2. 精确合同

新增浏览器可用无I/O ESM及.d.mts：`lib/yida-rule-template.mjs`。

```text
exportYidaRuleTemplate({rules, allocation}) -> string
parseYidaRuleTemplate(text) -> owned frozen envelope

envelope = {
  formatVersion: 1,
  kind: 'stock-preparation-yida-rule-template',
  status: 'local-unverified',
  rules: <实际v1/v2配置除target之外的字段>,
  allocation: {mode:'original'}
    | {mode:'equal_integer'|'equal_decimal_exact', projectField, quantityField}
}
```

rules保留version/kind/intent/fieldMap/businessKey/可选instanceIdField，以及v2的fieldCatalog/emptyKeyFields。这里instanceIdField是字段角色名，不是实例值。未知root/规则/目录/映射/分配字段、额外批准或执行声明全部拒绝；不静默剥除后宣称有效。

**不包含target（appType/formUuid）、projects具体清单、rows/payload/DTO、实例值、连接/tenant/workspace/owner/principal、token/凭据/代次、URL/header、账本/观察/批准/运行状态。** 字段标识和目录选项仍可能包含敏感业务配置或被用户误贴秘密；只承诺不采集/自动复制凭据字段，不冒称通用秘密清洗器。UI明确提醒保存位置和人工核对。

复用实际配置验证：规则先严格own-data/预算检查，显式拒target后，临时补固定`LOCAL_SCHEMA_ONLY_APP`/`LOCAL_SCHEMA_ONLY_FORM`作为**仅本地结构校验**参数，调用实际validateYidaStaticConfig；立即丢弃target，只返回规范规则。不用于planner、网络、界面运行目标或任何授权。由目标字段排除实现跨用户复用，不复制连接和权限。

分配公共函数：`validateYidaProjectAllocationRules(config:unknown,rules:unknown):YidaAllocationRules`，规则精确三字段；实际配置校验、create-only、模式/映射/至少两个业务键等均沿用原合同。YidaAllocationSettings扩展规则并加projects。原完整预演仍单独校验项目清单和行，保留mode→projects→fields的既有错误优先级；无新增运行路径。original不带字段角色，不触发分配。

## 3. 解析与表示保真

- artifact文字最大**2MiB UTF-8**，不是沿用128KiB行预算：实际合法大目录配置已可超过272KiB。限制深度10/总节点4096，每字符串先受总预算约束再由实际schema做字段上限，导出同预算。
- 严格JSON语法、拒重复键（包括Unicode转义等价）、拒危险原型属性与额外字段。数字仅出现在两个版本字段；词法只接受导出器生成的字面量`1`/`2`，拒`1.0000000000000001`舍入、`1.0`/`1e0`别名及负零；此格式不支持业务数字值。用有界线性扫描，不eval，不复制Node专属readback模块。
- 对象API只接受own enumerable data与普通对象/连续数组，拒getter/cycle/symbol/函数/exotic，固定values-free错误：YIDA_RULE_TEMPLATE_INPUT、TEXT、LIMIT、CONFIG、ALLOCATION。浏览器侧不声称能识别或隔离同进程恶意Proxy代码；外部输入边界是JSON文本。
- 导入/导出只用实际validator规范结果，深拷贝/冻结输出。导入失败不得部分改写表单，错误不回显原文/未知key/值。
- 已发现的两个实际往返问题须一起处理：v1允许一个source映射多个target，但业务键不能因此重复；回填时只给该source第一行打业务键选择。v2选项允许换行，不能join/split后改变其个数和值；目录编辑增加明确的JSON数组表示，保留原逐行编辑兼容，导入时使用保真表示。
- 导入的businessKey/emptyKeyFields顺序可以不同于映射行顺序；编辑器须保留已导入顺序，新增选择才按映射顺序追加。样例加载须重置这两个私有顺序状态，不因复用改变规则文本。

## 4. 页面合同与验证

在既有预演面板加规则复用区。生成时仅从currentConfig显式取规则（不带target），分配显式取三角色字段或original；不得spread整个组件状态。输出只读textarea。加载从独立textarea解析，全部验证后才一次性回填规则，目标/rows/项目列表清空；update实例角色保留，但实际实例值必须重新提供。成功提示“仅本地规则，目标和数据待填写”；不自动预演、不创建发布版本、不打开发送按钮。

任何表单/模式/输入/导入编辑及样例加载都使旧导出、预演、DTO/键/错误失效；点击失败加载也清旧结果但保留当前编辑配置和数据。不要复用会连带填入样例rows/目标的applyExample。看板scope/project变化的卸载清空保持不变。

真实链验收：

1. Node实际validate/planner/allocation：v1/v2两布局、create/update、空父项、重复source、带换行/Unicode/反斜杠选项；导出→解析→补新目标/本地行→真实预演等价。
2. 最大合法目录正例超过旧128KiB；2MiB/深度/节点预算、重复/转义重复key、版本舍入/未知字段/伪造authority、非法目录/分配分别拒绝。原始数据/target/projects/凭据字段不能进入产物。
3. 实际Vue点击生成→卸载重挂→粘贴加载→重新填合成目标/数据→预演，验证输出与安全旗标，不以mock纯函数替代接线；导入失败原子、任意编辑清旧输出。
4. 保留真实Board入口测试：不导入board行、不增加API调用、推送disabled、scope切换卸载；fetch/XHR/beacon/WebSocket/Storage/IndexedDB保持零。
5. 独立变异须先证明真路径，覆盖剥除target/rows边界、实际validator接线、导入原子性、v1键去重/v2多行选项保真及清旧结果；记录冗余守卫导致的未检出，不虚报每行皆独立。
6. Node/前端suite进入实际清单；定向lint/typecheck、相关回归、完整provenance、完整插件链及合成浏览器演示。无新被pin文件；如实际写集改变，先核清单。

风险L3。一人拥有纯module、allocation最小提取及Node测试；一人拥有既有Panel和Vue测试；独立审查，主审独占测试登记/guard和最终证据。撤掉局部规则区即可回滚；无DB/历史/授权迁移。SA02线上权限、SA04真实表单、SA05发送与SA06全范围均继续保留，不被这片替代。
