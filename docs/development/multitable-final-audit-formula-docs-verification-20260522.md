# Multitable Final Audit Slice C Verification — Formula Docs and Diagnostics

Date: 2026-05-22
Branch: `frontend/multitable-final-audit-formula-docs-design-20260522`
Base: `origin/main@149ec98e6` (`docs(attendance): close advanced scheduling read-only boundary (#1759)`)

## 1. DoD

Slice C is complete when formula catalog copy and formula diagnostics are locale-aware without changing formula syntax or runtime contracts.

Result: PASS.

| Gate | Result |
| --- | --- |
| Formula label module added | PASS: `meta-formula-labels.ts` owns formula category/function/diagnostic chrome. |
| English default compatibility | PASS: existing formula editor tests still assert EN default strings. |
| zh-CN catalog render | PASS: render spec asserts `数学` and zh description while keeping `ROUND(number, digits)` raw. |
| zh-CN diagnostics render | PASS: render spec asserts `未知字段引用 {fld_missing}。` and preserves `--error` class state. |
| Raw syntax preserved | PASS: signatures, examples, insert snippets, field refs, and function names remain raw. |
| A11y boundary | PASS: formula-panel fixture locks `[aria-label]/[title]/[placeholder] = 0/13/3`; no new attributes added. |
| Type-only import guard | PASS: `meta-formula-labels.ts` imports `formula-docs.ts` types only, avoiding a runtime cycle. |

## 2. Files Changed

```text
apps/web/src/multitable/utils/meta-formula-labels.ts          NEW
apps/web/src/multitable/utils/formula-docs.ts                 MOD
apps/web/src/multitable/components/MetaFieldManager.vue       MOD
apps/web/tests/meta-formula-labels.spec.ts                    NEW
apps/web/tests/multitable-formula-editor.spec.ts              MOD
docs/development/multitable-final-audit-formula-docs-design-20260522.md        NEW
docs/development/multitable-final-audit-formula-docs-verification-20260522.md  NEW
```

Out of scope and untouched: backend, contracts, migrations, attendance runtime code, K3 scripts, API client fallback architecture, visual view render module, manager non-formula chrome.

## 3. Preflight and Reachability Evidence

Formula source grep after implementation:

```text
apps/web/src/multitable/utils/formula-docs.ts:54:  { id: 'aggregate', label: 'Aggregate', description: 'Summarize numeric or non-empty values.' },
apps/web/src/multitable/utils/formula-docs.ts:69:    description: 'Adds numeric values together.',
apps/web/tests/multitable-formula-editor.spec.ts:37:    ])).toContainEqual({ severity: 'error', message: 'Unknown field reference {fld_missing}.' })
apps/web/tests/multitable-formula-editor.spec.ts:49:      message: 'Array brackets are not balanced.',
apps/web/tests/multitable-formula-editor.spec.ts:53:      message: 'Field reference braces are not balanced.',
apps/web/tests/multitable-formula-editor.spec.ts:61:      message: 'Parentheses are not balanced.',
apps/web/tests/multitable-formula-editor.spec.ts:74:      message: 'IF expects at least 3 arguments.',
apps/web/tests/multitable-formula-editor.spec.ts:78:      message: 'ROUND expects at most 2 arguments.',
apps/web/tests/multitable-formula-editor.spec.ts:82:      message: 'ROUND has an empty argument.',
apps/web/tests/multitable-formula-editor.spec.ts:86:      message: 'DATEDIF expects at least 3 arguments.',
apps/web/tests/multitable-formula-editor.spec.ts:90:      message: 'TODAY expects at most 0 arguments.',
apps/web/src/multitable/utils/meta-formula-labels.ts:29:    label: { en: 'Aggregate', zh: '聚合' },
apps/web/src/multitable/utils/meta-formula-labels.ts:30:    description: { en: 'Summarize numeric or non-empty values.', zh: '汇总数字或非空值。' },
apps/web/src/multitable/utils/meta-formula-labels.ts:63:  SUM: { en: 'Adds numeric values together.', zh: '将数字值相加。' },
apps/web/src/multitable/utils/meta-formula-labels.ts:120:  'diagnostic.unexpectedClosingParenthesis': { en: 'Unexpected closing parenthesis.', zh: '意外的右括号。' },
apps/web/src/multitable/utils/meta-formula-labels.ts:128:  'diagnostic.emptyExpression': { en: 'Formula expression is empty.', zh: '公式表达式为空。' },
apps/web/src/multitable/utils/meta-formula-labels.ts:161:    : `${functionName} has an empty argument.`
apps/web/src/multitable/utils/meta-formula-labels.ts:167:    : `${functionName} expects at least ${count} argument${count === 1 ? '' : 's'}.`
apps/web/src/multitable/utils/meta-formula-labels.ts:173:    : `${functionName} expects at most ${count} argument${count === 1 ? '' : 's'}.`
apps/web/src/multitable/utils/meta-formula-labels.ts:185:    : `Unknown field reference {${ref}}.`
apps/web/src/multitable/utils/meta-formula-labels.ts:191:    : `${functionName} is not documented in this editor yet.`
```

Interpretation: remaining EN literals in `formula-docs.ts` are the immutable default English catalog arrays. Remaining EN literals in tests are EN-baseline assertions. Runtime localized prose now lives in `meta-formula-labels.ts` or flows through helper calls.

Existing manager formula panel reuse grep:

```text
apps/web/src/multitable/utils/meta-manager-labels.ts:30:  | 'field.formulaReference' | 'field.formulaSearchPlaceholder'
apps/web/src/multitable/utils/meta-manager-labels.ts:31:  | 'field.allCategories' | 'field.noMatchingFunctions'
apps/web/src/multitable/utils/meta-manager-labels.ts:157:  'field.formulaReference': { en: 'Formula reference', zh: '公式参考' },
apps/web/src/multitable/utils/meta-manager-labels.ts:158:  'field.formulaSearchPlaceholder': { en: 'Search SUM, IF, %, ^, &...', zh: '搜索 SUM、IF、%、^、&...' },
apps/web/src/multitable/utils/meta-manager-labels.ts:159:  'field.allCategories': { en: 'All categories', zh: '全部分类' },
apps/web/src/multitable/utils/meta-manager-labels.ts:160:  'field.noMatchingFunctions': { en: 'No matching functions.', zh: '没有匹配的函数。' },
apps/web/src/multitable/utils/meta-manager-labels.ts:310:export function insertFieldTokenTitle(fieldId: string, isZh: boolean): string {
apps/web/src/multitable/components/MetaFieldManager.vue:184:                :title="insertFieldTokenTitle(field.id, isZh)"
apps/web/src/multitable/components/MetaFieldManager.vue:190:            <span>{{ ml('field.formulaReference') }}</span>
apps/web/src/multitable/components/MetaFieldManager.vue:195:                :placeholder="ml('field.formulaSearchPlaceholder')"
apps/web/src/multitable/components/MetaFieldManager.vue:198:                <option value="all">{{ ml('field.allCategories') }}</option>
apps/web/src/multitable/components/MetaFieldManager.vue:229:            <div v-else class="meta-field-mgr__formula-empty">{{ ml('field.noMatchingFunctions') }}</div>
```

Type-only import cycle guard:

```text
apps/web/src/multitable/utils/meta-formula-labels.ts:7:import type {
```

The new formula label module imports only types from `formula-docs.ts`; `formula-docs.ts` imports runtime helpers from `meta-formula-labels.ts`.

## 4. Raw Boundary Evidence

Raw syntax and selector state grep:

```text
apps/web/src/multitable/utils/formula-docs.ts:70:    example: '=SUM({fld_price}, {fld_tax})',
apps/web/src/multitable/utils/formula-docs.ts:115:    signature: 'ROUND(number, digits)',
apps/web/src/multitable/utils/formula-docs.ts:119:    insertText: 'ROUND(, 2)',
apps/web/src/multitable/components/MetaFieldManager.vue:164:            <textarea v-model="formulaDraft.expression" class="meta-field-mgr__textarea" placeholder="=SUM({fld_price}, {fld_tax})"></textarea>
apps/web/src/multitable/components/MetaFieldManager.vue:171:              :class="`meta-field-mgr__formula-diagnostic--${diagnostic.severity}`"
apps/web/src/multitable/components/MetaFieldManager.vue:1048:    const blockingDiagnostic = formulaDiagnostics.value.find((diagnostic) => diagnostic.severity === 'error')
apps/web/src/multitable/components/MetaFieldManager.vue:1357:.meta-field-mgr__formula-diagnostic--warning { background: #fff7e6; color: #8a5a00; border: 1px solid #f3d19e; }
apps/web/src/multitable/components/MetaFieldManager.vue:1358:.meta-field-mgr__formula-diagnostic--error { background: #fef0f0; color: #c0392b; border: 1px solid #fbc4c4; }
apps/web/tests/multitable-formula-editor.spec.ts:385:    expect(container.textContent).toContain('ROUND(number, digits)')
apps/web/tests/multitable-formula-editor.spec.ts:387:    expect(container.textContent).toContain('未知字段引用 {fld_missing}。')
apps/web/tests/multitable-formula-editor.spec.ts:389:    expect(container.querySelector('.meta-field-mgr__formula-diagnostic--error')).toBeTruthy()
```

Raw values covered by tests:

| Raw value | Evidence |
| --- | --- |
| Function names | `ROUND`, `IF`, `TODAY`, `FOO` asserted raw in helper/spec diagnostics. |
| Function signatures | `ROUND(number, digits)` asserted visible in zh render. |
| Examples and insert snippets | `=ROUND({fld_amount}, 2)` and `ROUND(, 2)` remain raw. |
| Field refs | `{Price}`, `{fld_missing}`, `{fld_xxx}` asserted raw inside zh diagnostics. |
| Category option value | `option[value="math"]` remains raw while option text is `数学`. |
| Severity enum | `.meta-field-mgr__formula-diagnostic--error` asserted raw. |

## 5. A11y Boundary

Source-level before implementation:

```text
MetaFieldManager.vue aria-label=0
MetaFieldManager.vue title=9
MetaFieldManager.vue placeholder=13
```

Formula-panel fixture after implementation:

```text
[aria-label] = 0
[title] = 13
[placeholder] = 3
```

The fixture count differs from source count because only a subset of conditional UI is rendered in the formula panel, while repeated field rows and field-token chip titles are present. The spec locks the fixture count to prevent adding new a11y attributes in this slice.

## 6. Validation

Post-ff base rerun on `origin/main@149ec98e6`:

```text
pnpm --filter @metasheet/web exec vitest run tests/meta-formula-labels.spec.ts tests/multitable-formula-editor.spec.ts tests/multitable-field-manager.spec.ts --watch=false

Test Files  3 passed (3)
Tests       34 passed (34)
```

```text
pnpm --filter @metasheet/web run type-check

> vue-tsc -b
exit 0
```

```text
pnpm --filter @metasheet/web build

✓ 2422 modules transformed.
✓ built in 6.31s
```

Build warning observed and unchanged in character:

```text
WorkflowDesigner.vue is dynamically imported by appRoutes.ts but also statically imported by viewRegistry.ts and AttendanceWorkflowDesigner.vue.
```

This is a pre-existing bundling warning unrelated to formula docs.

## 7. Notes

- `formulaFunctionDescription('FOO', true)` returns `''` by design. Empty means "unknown function has no description"; the helper does not invent description text by echoing the function name.
- `FORMULA_FUNCTION_CATEGORIES` and `FORMULA_FUNCTION_DOCS` remain English default arrays. Locale-aware APIs return cloned localized objects.
- `searchFormulaFunctionDocs(query, true)` searches raw function names/signatures, English descriptions, and zh descriptions. Specs cover `SUM`, `Adds`, and `相加`.
- `MetaFieldManager.vue` formula catalog and diagnostics now read `isZh.value` at render/computed time; locale toggles re-render the formula docs/diagnostics rather than storing event-time strings.
- `apps/web/dist/` and `apps/web/node_modules` may be present from local build/install state; they are ignored and not part of the intended PR diff.
