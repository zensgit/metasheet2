# Multitable Final Audit Slice C Design — Formula Docs and Diagnostics

Date: 2026-05-22
Branch: `frontend/multitable-final-audit-formula-docs-design-20260522`
Base: `origin/main@149ec98e6` (`docs(attendance): close advanced scheduling read-only boundary (#1759)`)

## 1. Decision Summary

Slice C localizes the formula reference catalog and formula validation diagnostics that were intentionally deferred by final audit Slice A and Slice B.

Scope:

| Surface | File | Decision |
| --- | --- | --- |
| Formula catalog categories | `apps/web/src/multitable/utils/formula-docs.ts` | Localize the 8 category labels/descriptions used by the formula reference selector and section headers. |
| Formula function descriptions | `apps/web/src/multitable/utils/formula-docs.ts` | Localize descriptions for all 54 formula docs; keep function names, signatures, examples, and insertion snippets raw. |
| Formula diagnostics | `apps/web/src/multitable/utils/formula-docs.ts` | Localize static and dynamic frontend diagnostics emitted by `validateFormulaExpression(...)`; preserve raw function names, field refs, and token examples. |
| Formula panel rendering | `apps/web/src/multitable/components/MetaFieldManager.vue` | Pass `isZh.value` into formula catalog and diagnostic helpers; no template structure change beyond localized text. |
| Tests | `apps/web/tests/multitable-formula-editor.spec.ts` plus new formula label helper spec | Preserve English default contract and add zh render/helper coverage. |

Architecture:

| Decision | Outcome |
| --- | --- |
| New formula module | Add `apps/web/src/multitable/utils/meta-formula-labels.ts`. Formula catalog copy is large and formula-specific; it should not overload `meta-manager-labels.ts`. |
| Existing manager module | Keep existing manager keys (`field.formulaReference`, `field.formulaSearchPlaceholder`, `field.allCategories`, `field.noMatchingFunctions`, `field.expression`, `field.insertFieldToken`) in `meta-manager-labels.ts`; do not duplicate them. |
| Optional locale parameters | `searchFormulaFunctionDocs`, `getFormulaFunctionCatalog`, `getFormulaFunctionCategories`, and `validateFormulaExpression` receive optional `isZh = false` to preserve current English default tests and callers. |
| Search behavior | Formula search should match raw function name/signature, English description, and localized description. This preserves EN search terms in zh mode and enables zh description search. |
| Raw boundary | Formula names, signatures, examples, insert snippets, field IDs, field names, `{fld_xxx}`, formulas, backend-compatible tokens, and unknown enum/function values stay raw. |

Out of scope:

| Deferred Surface | Reason |
| --- | --- |
| API client static fallback errors | Final audit Slice D; separate architecture needed for client-level i18n. |
| Field manager non-formula chrome | Already handled by `meta-manager-labels.ts` and earlier T3C/T3E slices. |
| Formula runtime/backend contract | Slice C changes frontend docs/diagnostics only; no backend, contract, migration, attendance, K3. |
| Formula expression placeholder `=SUM({fld_price}, {fld_tax})` | Raw formula syntax example; not user-facing prose and should remain unchanged. |

## 2. Files In Scope

Implementation files:

```text
apps/web/src/multitable/utils/meta-formula-labels.ts
apps/web/src/multitable/utils/formula-docs.ts
apps/web/src/multitable/components/MetaFieldManager.vue
```

Tests:

```text
apps/web/tests/meta-formula-labels.spec.ts
apps/web/tests/multitable-formula-editor.spec.ts
```

Docs:

```text
docs/development/multitable-final-audit-formula-docs-design-20260522.md
docs/development/multitable-final-audit-formula-docs-verification-20260522.md
```

Out-of-scope examples that must remain untouched:

```text
apps/web/src/multitable/api/client.ts
apps/web/src/multitable/utils/workbench-labels.ts
apps/web/src/multitable/utils/meta-view-render-labels.ts
packages/core-backend/**
packages/openapi/**
plugins/**
```

## 3. Scout Evidence

Formula source:

| Source | Evidence |
| --- | --- |
| Category labels/descriptions | `formula-docs.ts:42-51`, 8 `FORMULA_FUNCTION_CATEGORIES` entries. |
| Formula function docs | `formula-docs.ts:53-487`, 54 `FORMULA_FUNCTION_DOCS` entries. |
| Catalog search and sections | `formula-docs.ts:543-566`, `searchFormulaFunctionDocs` and `getFormulaFunctionCatalog`. |
| Syntax diagnostics | `formula-docs.ts:604-692`, static syntax messages. |
| Argument diagnostics | `formula-docs.ts:881-912`, dynamic function arity / empty-argument messages. |
| Validation diagnostics | `formula-docs.ts:915-950`, empty expression, field-reference, undocumented-function messages. |
| Formula panel rendering | `MetaFieldManager.vue:161-229`, diagnostics, category select, section headers, doc descriptions/examples. |
| Formula panel data plumbing | `MetaFieldManager.vue:591-640`, categories, catalog sections, diagnostics. |

Existing localized manager chrome to reuse:

| Existing key/helper | Owner | Use |
| --- | --- | --- |
| `field.expression` | `meta-manager-labels.ts` | Formula expression label. |
| `field.insertFieldToken` | `meta-manager-labels.ts` | Field-token chip section. |
| `field.formulaReference` | `meta-manager-labels.ts` | Formula reference label. |
| `field.formulaSearchPlaceholder` | `meta-manager-labels.ts` | Search input placeholder. |
| `field.allCategories` | `meta-manager-labels.ts` | Category select all-option. |
| `field.noMatchingFunctions` | `meta-manager-labels.ts` | Empty catalog state. |
| `insertFieldTokenTitle(fieldId, isZh)` | `meta-manager-labels.ts` | Field-token chip title; field ID raw. |

No separate cell editor variants were found during Slice A; formula docs are owned by `formula-docs.ts` and consumed from `MetaFieldManager.vue`.

## 4. Label Module Contract

Add a formula-specific label module:

```ts
export type FormulaCategoryLabelKey =
  | 'category.aggregate'
  | 'category.math'
  | 'category.operator'
  | 'category.logic'
  | 'category.text'
  | 'category.date'
  | 'category.lookup'
  | 'category.statistical'

export type FormulaDiagnosticLabelKey =
  | 'diagnostic.unexpectedClosingParenthesis'
  | 'diagnostic.unexpectedClosingArrayBracket'
  | 'diagnostic.unexpectedClosingFieldReferenceBrace'
  | 'diagnostic.quotedStringNotClosed'
  | 'diagnostic.parenthesesNotBalanced'
  | 'diagnostic.arrayBracketsNotBalanced'
  | 'diagnostic.fieldReferenceBracesNotBalanced'
  | 'diagnostic.trailingBinaryOperator'
  | 'diagnostic.emptyExpression'

export function formulaCategoryLabel(category: FormulaFunctionCategory, isZh: boolean): FormulaFunctionCategoryDoc
export function formulaFunctionDescription(name: string, isZh: boolean): string
export function formulaDiagnosticLabel(key: FormulaDiagnosticLabelKey, isZh: boolean): string
export function formulaEmptyArgument(functionName: string, isZh: boolean): string
export function formulaMinArgs(functionName: string, count: number, isZh: boolean): string
export function formulaMaxArgs(functionName: string, count: number, isZh: boolean): string
export function formulaFieldNameReference(ref: string, isZh: boolean): string
export function formulaUnknownFieldReference(ref: string, isZh: boolean): string
export function formulaUndocumentedFunction(functionName: string, isZh: boolean): string
```

Notes:

- `FormulaFunctionCategory` / `FormulaFunctionCategoryDoc` can be imported as type-only imports to avoid a runtime cycle.
- Unknown categories must fall back to `String(value)`, not throw.
- `formulaFunctionDescription(name, isZh)` returns an empty string for unknown function names. Empty means "no description"; callers may decide whether to render a placeholder, but the helper must not invent a description by echoing the function name.
- Dynamic helpers must preserve raw function names (`ROUND`, `TODAY`, unknown `FOO`) and raw field refs (`Price`, `fld_missing`) exactly.
- `formulaFieldNameReference()` must keep `{fld_xxx}` literal raw inside the guidance text.

## 5. Exact Chrome Targets

### 5.1 Category Labels and Descriptions

| Category | EN label | zh label | EN description | zh description |
| --- | --- | --- | --- | --- |
| aggregate | Aggregate | 聚合 | Summarize numeric or non-empty values. | 汇总数字或非空值。 |
| math | Math | 数学 | Round, transform, and compare numbers. | 对数字进行舍入、转换和比较。 |
| operator | Operators | 运算符 | Combine values with spreadsheet operators. | 使用表格运算符合并值。 |
| logic | Logic | 逻辑 | Branch and combine conditions. | 分支处理并组合条件。 |
| text | Text | 文本 | Join, slice, and normalize text. | 拼接、截取并规范化文本。 |
| date | Date | 日期 | Create or extract date values. | 创建或提取日期值。 |
| lookup | Lookup | 查找 | Find values from arrays or ranges. | 从数组或范围中查找值。 |
| statistical | Statistical | 统计 | Calculate distribution helpers. | 计算分布类辅助值。 |

### 5.2 Formula Function Descriptions

All 54 function docs keep `name`, `signature`, `example`, and `insertText` raw. Only `description` is localized.

| Function | zh description |
| --- | --- |
| SUM | 将数字值相加。 |
| AVERAGE | 返回数字值的算术平均值。 |
| COUNT | 统计数字值。 |
| COUNTA | 统计非空值。 |
| MIN | 返回最小的数字值。 |
| MAX | 返回最大的数字值。 |
| ROUND | 将数字舍入到指定小数位。 |
| CEILING | 将数字向上舍入到最接近的整数。 |
| FLOOR | 将数字向下舍入到最接近的整数。 |
| POWER | 返回数字的乘方结果。 |
| SQRT | 返回数字的平方根。 |
| MOD | 返回除法后的余数。 |
| ABS | 返回数字的绝对值。 |
| ADD | 将两个数字值相加。文本数字会被转换为数字。 |
| SUBTRACT | 从左侧值中减去右侧数字值。 |
| MULTIPLY | 将两个数字值相乘。 |
| DIVIDE | 将左侧数字值除以右侧值。 |
| POWER_OPERATOR | 将左侧数字值提升到右侧值指定的幂。 |
| PERCENT_OPERATOR | 将数字转换为百分比值，例如 50% 会变为 0.5。 |
| CONCAT_OPERATOR | 将值按文本拼接。 |
| COMPARISON | 比较两个值并返回 TRUE 或 FALSE。 |
| IF | 根据条件在两个值中选择一个。 |
| AND | 仅当所有条件都为 true 时返回 true。 |
| OR | 任一条件为 true 时返回 true。 |
| NOT | 反转布尔值。 |
| TRUE | 返回布尔值 TRUE。 |
| FALSE | 返回布尔值 FALSE。 |
| SWITCH | 返回第一个匹配值对应的结果，可包含默认值。 |
| CONCAT | 将文本值拼接在一起。 |
| CONCATENATE | 将文本值拼接在一起。 |
| LEFT | 返回文本值开头的字符。 |
| RIGHT | 返回文本值末尾的字符。 |
| MID | 返回文本值中间位置的字符。 |
| LEN | 返回文本值的长度。 |
| UPPER | 将文本转换为大写。 |
| LOWER | 将文本转换为小写。 |
| TRIM | 移除文本开头和结尾的空白。 |
| SUBSTITUTE | 将旧文本的所有出现位置替换为新文本。 |
| NOW | 返回当前日期和时间。 |
| TODAY | 返回当前日期。 |
| DATE | 根据年、月、日数字创建日期。 |
| DATEDIF | 使用 D、M 或 Y 单位返回两个日期之间的差值。 |
| DATEDIFF | 返回两个日期之间的天数。 |
| YEAR | 返回日期值中的年份。 |
| MONTH | 返回日期值中的月份。 |
| DAY | 返回日期值中的日。 |
| VLOOKUP | 在类似表格的范围第一列中查找值。 |
| HLOOKUP | 在类似表格的范围第一行中查找值。 |
| INDEX | 按行列位置从范围中返回值。 |
| MATCH | 返回值在范围中的位置。 |
| STDEV | 返回数字值的样本标准差。 |
| VAR | 返回数字值的样本方差。 |
| MEDIAN | 返回数字值的中位数。 |
| MODE | 返回最常见的数字值。 |

### 5.3 Diagnostics

Static diagnostics:

| Source line | EN | zh |
| --- | --- | --- |
| `formula-docs.ts:641` | Unexpected closing parenthesis. | 意外的右括号。 |
| `formula-docs.ts:654` | Unexpected closing array bracket. | 意外的右方括号。 |
| `formula-docs.ts:667` | Unexpected closing field-reference brace. | 意外的字段引用右花括号。 |
| `formula-docs.ts:675` | Quoted string is not closed. | 引号字符串未闭合。 |
| `formula-docs.ts:678` | Parentheses are not balanced. | 圆括号不匹配。 |
| `formula-docs.ts:681` | Array brackets are not balanced. | 方括号不匹配。 |
| `formula-docs.ts:684` | Field reference braces are not balanced. | 字段引用花括号不匹配。 |
| `formula-docs.ts:689` | Formula cannot end with a binary operator. | 公式不能以二元运算符结尾。 |
| `formula-docs.ts:919` | Formula expression is empty. | 公式表达式为空。 |

Dynamic diagnostics:

| Source line | EN shape | zh shape | Raw values |
| --- | --- | --- | --- |
| `formula-docs.ts:889` | `${fn} has an empty argument.` | `${fn} 存在空参数。` | `fn` raw uppercase |
| `formula-docs.ts:899` | `${fn} expects at least ${n} argument(s).` | `${fn} 至少需要 ${n} 个参数。` | `fn`, `n` raw |
| `formula-docs.ts:907` | `${fn} expects at most ${n} argument(s).` | `${fn} 最多接受 ${n} 个参数。` | `fn`, `n` raw |
| `formula-docs.ts:933` | `Field reference {${ref}} uses a name. Use the field chip to insert a stable {fld_xxx} token.` | `字段引用 {${ref}} 使用了名称。请使用字段标签插入稳定的 {fld_xxx} 令牌。` | `ref`, `{fld_xxx}` raw |
| `formula-docs.ts:937` | `Unknown field reference {${ref}}.` | `未知字段引用 {${ref}}。` | `ref` raw |
| `formula-docs.ts:946` | `${fn} is not documented in this editor yet.` | `${fn} 尚未在此编辑器中记录。` | `fn` raw uppercase |

English pluralization stays byte-compatible for default callers: `argument` when `n === 1`, otherwise `arguments`. Chinese uses `个参数` for both.

## 6. API Shape Changes

Keep English default behavior for all existing callers:

```ts
export function getFormulaFunctionCategories(isZh = false): FormulaFunctionCategoryDoc[]
export function searchFormulaFunctionDocs(query: string, isZh = false): FormulaFunctionDoc[]
export function getFormulaFunctionCatalog(
  query = '',
  category: FormulaFunctionCategory | 'all' = 'all',
  isZh = false,
): FormulaFunctionCatalogSection[]
export function validateFormulaExpression(expression: string, fields: MetaField[], isZh = false): FormulaDiagnostic[]
```

Implementation notes:

- `FORMULA_FUNCTION_CATEGORIES` and `FORMULA_FUNCTION_DOCS` may remain the English default source of truth for backward compatibility.
- Locale-aware functions should return cloned/localized objects, not mutate exported static arrays.
- `searchFormulaFunctionDocs(query, true)` should search against `name`, `signature`, English description, and zh description.
- `MetaFieldManager.vue` should switch `formulaFunctionCategories` from a raw constant to a computed locale-aware list.
- `formulaCatalogSections` and `formulaDiagnostics` should pass `isZh.value`.

## 7. Raw Boundary

Do not translate:

| Raw item | Reason |
| --- | --- |
| Function names (`SUM`, `IF`, `ROUND`) | Formula language tokens; backend/runtime-compatible. |
| Function signatures (`SUM(number, ...)`) | Technical API syntax. |
| Insert snippets (`ROUND(, 2)`, `10%`, `>=`) | Inserted into formula expression; must remain runtime-compatible. |
| Formula examples (`=SUM({fld_price}, {fld_tax})`) | Copy-pastable formula syntax. |
| Field IDs and refs (`fld_price`, `{fld_missing}`, `{Price}`) | User/schema tokens. |
| Field names in chips (`Price`) | User-authored data. |
| Unknown function names (`FOO`) | User formula token; raw in diagnostics. |
| `diagnostic.severity` (`warning` / `error`) | CSS modifier state and persisted UI enum; never localize. |
| Formula expression textarea placeholder | Raw syntax example, not prose. |

M1 trap guard:

- `:class="\`meta-field-mgr__formula-diagnostic--${diagnostic.severity}\`"` must keep `diagnostic.severity` raw.
- Category `<option :value="category.id">` must keep category ID raw while display text localizes.

## 8. A11y and Attribute Boundary

Slice C localizes existing visible text and diagnostics only.

Source count in `MetaFieldManager.vue` before implementation:

```text
aria-label=0
title=9
placeholder=13
```

Rules:

- Do not add new `aria-label`, `title`, or `placeholder` attributes.
- Do not localize formula syntax placeholders such as `=SUM({fld_price}, {fld_tax})`.
- Existing `title` usage for field token insertion remains owned by `insertFieldTokenTitle(field.id, isZh)`.
- Render specs should lock a formula-panel fixture sentinel for `[aria-label]`, `[title]`, and `[placeholder]` counts.

## 9. Preflight Grep

Before implementation, run source and reuse scans:

```bash
grep -R -n -E "Aggregate|Summarize numeric|Adds numeric|Formula expression is empty|Unexpected closing|not balanced|has an empty argument|expects at least|expects at most|Unknown field reference|not documented in this editor yet" \
  apps/web/src/multitable/utils/formula-docs.ts \
  apps/web/src/multitable/components/MetaFieldManager.vue \
  apps/web/tests/multitable-formula-editor.spec.ts

grep -R -n -E "field\\.formulaReference|field\\.formulaSearchPlaceholder|field\\.allCategories|field\\.noMatchingFunctions|insertFieldTokenTitle" \
  apps/web/src/multitable/utils/meta-manager-labels.ts \
  apps/web/src/multitable/components/MetaFieldManager.vue \
  apps/web/tests
```

Verification MD must include:

- The post-implementation grep result showing formula prose now flows through `meta-formula-labels.ts` or localized helper calls.
- Reuse-key reachability evidence for existing `meta-manager-labels.ts` formula panel chrome.
- A raw-boundary grep snippet for `diagnostic.severity`, formula examples, and insert snippets.

## 10. Test Plan

Unit tests:

| Spec | Coverage |
| --- | --- |
| `meta-formula-labels.spec.ts` | 8 categories, representative function descriptions, all diagnostic helpers, EN default/zh output, unknown fallback, raw interpolation. |
| `multitable-formula-editor.spec.ts` | Existing formula utility behavior remains EN by default; localized catalog and diagnostics with `isZh=true`; search matches both EN function names and zh descriptions. |

Render tests:

Extend `multitable-formula-editor.spec.ts`:

- zh-CN formula panel renders `数学` / `运算符` category labels and zh descriptions while preserving `ROUND(number, digits)` and formula examples raw.
- zh-CN unknown field reference renders `未知字段引用 {fld_missing}。` and does not call `update-field`.
- zh-CN field-name warning preserves `{Price}` and `{fld_xxx}` raw.
- Category `<option>` values remain raw (`math`, `operator`, etc.) while text localizes.
- Formula-panel a11y sentinel counts stay unchanged for `[aria-label]`, `[title]`, `[placeholder]`.

Validation commands:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/meta-formula-labels.spec.ts \
  tests/multitable-formula-editor.spec.ts \
  tests/multitable-field-manager.spec.ts \
  --watch=false

pnpm --filter @metasheet/web run type-check
pnpm --filter @metasheet/web build
git diff --check origin/main..HEAD
```

## 11. Implementation Order

1. Rebase to latest `origin/main` and verify the branch is clean.
2. Run the preflight grep commands in Section 9.
3. Add `meta-formula-labels.ts` with category, function-description, and diagnostic helpers.
4. Extend `formula-docs.ts` optional `isZh = false` APIs; keep exported default arrays English and immutable.
5. Wire `MetaFieldManager.vue` formula category/catalog/diagnostic computed values to `isZh.value`.
6. Add `meta-formula-labels.spec.ts`.
7. Extend `multitable-formula-editor.spec.ts` for EN default, zh catalog/diagnostics, raw boundary, and a11y sentinels.
8. Write verification MD with preflight/reuse/raw/a11y evidence.
9. Run validation commands.
10. Commit only Slice C files and stop before push.

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| Mutating exported catalog arrays breaks EN default callers | Return localized clones; keep `FORMULA_FUNCTION_DOCS` and `FORMULA_FUNCTION_CATEGORIES` English. |
| Search becomes worse in zh mode | Search name/signature plus both EN and localized descriptions. |
| Unknown formula descriptions render misleading text | `formulaFunctionDescription()` returns `''` for unknown names; spec covers the empty fallback. |
| Function signatures/examples accidentally translated | Helper spec and render spec assert signatures/examples remain raw. |
| CSS class state localized by accident | `diagnostic.severity` remains raw; spec checks class modifier. |
| Dynamic diagnostic raw values get localized | Helper tests cover raw `ROUND`, `{Price}`, `{fld_missing}`, and unknown `FOO`. |
| Label-module cycle | Use type-only imports from `formula-docs.ts` in `meta-formula-labels.ts`, or keep formula label helpers type-light. |
| Slice C grows into manager rewrite | Reuse existing manager keys and only touch formula panel data. |
| Slice D API fallbacks get mixed in | API client fallback architecture remains explicitly deferred. |

## 13. Approval Gate

Implementation is ready for review when:

- `meta-formula-labels.ts` owns formula-only copy and no formula description/diagnostic key is duplicated in `meta-manager-labels.ts`.
- English default API behavior remains compatible with existing tests.
- zh-CN catalog and diagnostics render through `MetaFieldManager.vue`.
- Raw formula syntax, function signatures, examples, insert snippets, field refs, field names, and severity enums are preserved.
- A11y/title/placeholder counts do not increase.
- Verification MD includes preflight grep, reuse-key reachability, raw-boundary, and validation evidence.
