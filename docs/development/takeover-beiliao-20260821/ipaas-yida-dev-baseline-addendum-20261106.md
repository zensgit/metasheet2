> **入库说明（2026-11-06，不属于附录正文）**：本文件第 4 行起是「设计基线 v2.3 附录一：owner 冻结后裁定」的逐字节副本，**已冻结，不再修改**；原文件 sha256 `319fabd9039c146e96dc3d3e0ea3890b9342bf0ccd2f5c4969c9988e4d28336f`。校验：`git show HEAD:docs/development/takeover-beiliao-20260821/ipaas-yida-dev-baseline-addendum-20261106.md | tail -n +4 | sha256sum`。
> 冻结基线入库为同目录 `ipaas-yida-dev-baseline-v2.3-20261106.md`。正文提到的 `dev-doc/frozen-20261106/` 与 `autocode/verdict.json` 是起草会话的本机草稿目录，没有随本文件入库。**本附录对 `transformDependencies` 的切片归属（「Y3 导出」）已由开发协调者在 2026-11-06 改为 Y4 所有、Y6a 只导出 `generatedTemplateDependencies`、Y6 再登记进 Y4 的表；见各切片 PR 说明。**

# 设计基线 v2.3 附录一：owner 冻结后裁定（2026-11-06）

冻结基线（`dev-doc/frozen-20261106/ipaas-yida-dev-doc-v2.3-frozen.md`，sha256 `5657c16a…31ec1`）不改。凡与本附录冲突之处，以本附录为准。

依据：「自定义自动合成 / 自动编码」调研工作流 `wf_951b7f39-29a`。评审结论见同目录 `autocode/verdict.json`，其中 `designSketch` 的 Layer 0/1/2 和 `planChangesForInFlight` 是实施细节。

## 裁定
1. **Y6（⑦.4 PR-2）改为「封闭部件拼成的模板」**（owner 选推荐项）。
   - **条目形状**：`{ transform: 'generated', template: [parts], target, type, required }`。target 是文本控件，type 是 string。
   - **部件种类**（封闭、每种的键精确列出）：
     - `{ literal }`：规则与 concat 的字面量相同，长度 ≤128；
     - `{ field: <direct target> }`：字符串原样；数字转 `String(n)`；布尔报 `FIELD_TYPE`；
     - `{ hash: [direct targets 1..16], form: 'uuid-36' | 'uuid-32' }`：值为 UUIDv5（规划器内的命名空间常量，标签 `metasheet.stock-prep.yida-generated-hash` / `v1`）。复用 Y2 导出的 UUIDv5 基础函数，与 WLBH 做域隔离；
     - `{ preset: 'material-code-v1', rowIdOf, projectOf }`：与 Y2 生成器逐字节相同；`projectOf` 必须是业务键目标。
   - **规则**：
     - 部件 ≤8 个，至少一个不是字面量；
     - 空部件一律拒绝（`FIELD_PART_MISSING`）；`emptyKeyFields` 里列出的可空键，在哈希中按 `''` 计；
     - 输出 ≤4096；
     - **G1**：恰好一个身份部件，即覆盖全部业务键目标的 hash，或 preset；
     - generated 的目标永远不能是键。
   - **求值时机**：在分配（拆分）之后、`planTransformFields` 里求值，所以每个拆分行得到不同的编码。分配的校验器还要断言：每个 generated 模板都依赖项目目标。
   - **重复检查**：键分组之后再过一遍批量检查，编码相同的标 `DUPLICATE_GENERATED_VALUE`（行无效，丢弃 payload）。
   - **共享依赖函数**：从 `yida-static-plan.mjs` 导出 `transformDependencies(entry)`，按种类返回依赖的来源列，供 Y3（v3 行投影）、Y4（`fieldDependencies`）、Y5（RA2）共用。
   - **持久化编译**：遇到无绑定行上的 generated 一律拒绝（`SOURCE_UNBOUND`），与模板内容无关。
   - **规划器的导入钉子**改为只放行 `./yida-material-code.mjs`，并对这个文件做递归的无导入、无网络扫描。`Dockerfile.frontend`、浏览器车道清单和闭包测试都要加上它。
   - **本片不提供日期部件**：宜搭发送时没有稳定的日期来源。
   - **默认物料模板**：一个 preset 部件，放在一个文本目标上，目标不能叫 `materialCode`。
   - **规模**：约 550 行。Opus high 实现，Fable 5.1 max 核验（唯一性与身份属保证类）。
2. **多维表「自动编码」存储字段（方案 A）先排队，不开工。** 等客户提出要在表上看到的编码需求再定。开工时，它的哈希部件必须复用 Y2 的基础函数和 `material-code-v1` 的名字布局，流水号部件永远不进宜搭身份。
3. **用自动化动作生成编码（方案 C）不做**，按 T 层默认前进，owner 24 小时内可否决。
4. **唯一性规则采用 G1**。
5. **不变的事项**：
   - Y2 保持逐字节不变：`NAMESPACE_V1`、名字布局、41 字符的 WLBH 形状；D2 仍待对照旧代码确认；
   - `creation_identity_digest` 仍只由 `(keyValue, projectNo)` 算出，编码永远不进身份摘要；
   - Y7、Y8、Y9、Y10 和 I 系列不受影响；
   - Y8 现在不加编码列。

## 对各切片的要求
- **Y3**：导出 `transformDependencies(entry)`，v3 行投影建在它之上。映射：direct 对应来源；copy 对应主来源；concat 对应各部件来源；constant 为空。v2 金标不变。若 Y3 已交付，就由 Y4 补这个导出。
- **Y4**：`fieldDependencies` 通过 `transformDependencies` 收进 generated 的输入（field、hash 的列、preset 的 `rowIdOf`/`projectOf`）。持久化编译对无绑定行上的 generated 报 `SOURCE_UNBOUND`。
- **Y5**：RA2 (ii) 通过同一函数覆盖 generated 的依赖列。
- **Y6**：按裁定 1 实现，验收为评审方案 B 的 A1–A8、A12（无日期部件），外加真库用例 A9/A10。A9/A10 放进 `stock-preparation-yida-create-fence-realdb.test.ts`，文件数不变。
