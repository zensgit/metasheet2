# Lock-8 — Bounded Additional Form-Field Vocabulary (2026-08-17)

**Status:** RATIFIED (2026-08-17 — §4 record; design authorization only, slices still gated)
**Baseline:** `origin/main@6c0b9162a9a878d894d8f747d7f2ae5ab16656dc` — the Lock-5 landing commit (#4947).
Every anchor was READ AT THIS BASELINE on an **unshallowed** clone (`git rev-parse --is-shallow-repository`
→ `false` *before* any ancestry claim; a shallow clone's `merge-base` answers are not evidence). Line numbers
are exact here and differ from the parents' citations in several places (§0.2). Unqualified `:NNNN` anchors are
`packages/core-backend/src/services/ApprovalProductService.ts`. The member is spelled **`'record-link'`**
(hyphen); underscores appear only in FWB issue codes.
**Parents (all RATIFIED, all on main, all verified ancestors):** `approval-parity-master-design-lock-20260817.md`
(last touched `075d078eb4`) §3 Lock-8 row — this is that row's draft, binding scope *"bounded additional field
vocabulary, excluding department/contact, exact money, and number FWB"* — plus §P6 (*"Prioritize date range,
explanatory text, formatted number… Formula fields require a deterministic evaluation and dependency lock"*),
§8 non-goals, the UI-8 row, **M10 verbatim** (§1.3), M4, M8, M11. Lock-0 `075d078eb4`, Lock-1 `b1195b84bc`,
Lock-3 `e0c882220c`, Lock-4 `3c5f0992ba`, Lock-5 `6c0b9162a9`, Lock-6 `8aa9fb00eb` supply the enum/gate house
form; Lock-5 §1.1's allowlist arithmetic and §2.4's values-free rule are reused directly.
**Conditional parent (NOT on main — every palette statement citing it is conditional):** F2
`origin/claude/approval-p0-f2-exact-slots-drag-codec-20260817` @ `53c27520b55a152497e9e329c1e86dc3c30beb83`,
forked from `c7f736b370` (two commits behind this baseline), **not** an ancestor of it, purely additive
(15 files, +2945/−0), changing neither union.
**Non-effects:** no runtime code, migration, flag change, tenant UAT, deployment, or completion label.
Department/contact controls are Lock-2's and are not narrowed here; exact decimal/money and number FWB stay
master §8 non-goals; `readonly`/`editable` is Lock-7; print stays a master §P5 optional slice (§2.4). Each
contract still needs its own PR, required checks, adversarial gate, and ledger row.

## 0. Corpus evidence, the anchor corrections it forced, and the fact that governs this lock

Corpus = the offline Feishu administrator handbook (`feishu/6933484342190538780.txt`, 2350 lines) §3.2
表单控件详情; section boundaries were derived from the file's own `## ` headers, never from a fixed-width
slice. Master M11 governs the language: "the reference corpus did not evidence", never "the competitor lacks".

| # | Corpus statement | Line | Disposition |
|---|---|---|---|
| C-1 | 说明 — "用于输入描述性说明、备注等文本"; the ONLY setting is 默认提示 (grey hint, ≤256 chars, i18n); 其他可选 carries **打印 only** | 568-589 | L8-A, with the D-1 ambiguity disclosed |
| C-2 | 多行文本 and 数字 both carry 标题 (required) **and** 必填 in 其他可选 — the neighbours C-1 differs from | 532-567, 590-633 | the contrast making C-1's omissions readable as deliberate |
| C-3 | 数字 — 标题/默认提示/单位/设置数值范围 (min or max alone); "身份证、银行卡等超过 15 位数的情况，请使用文本控件" | 590-633, 632 | the corpus's own precision caveat; corroborates M10 |
| C-4 | 金额 — 币种 defaults 人民币元(CNY), dropdown of global currencies; 格式 = 大写数字 (recommended when CNY) + 千位分隔符 + 自定义小数位数; 设置金额范围 | 634-683, 656-667 | L8-C's display vocabulary, and only that |
| C-5 | 计算公式 — 实时计算 over 数值/金额; 公式 built by clicking controls/symbols/digits; 格式 = **the same three options as C-4**; 其他可选 打印 only (no 必填) | 684-718, 700-711 | L8-D deferred; its 格式 reuses L8-C, not a second vocabulary |
| C-6 | 日期 — 日期类型 a required 3-way enum (年-月-日 / 年-月-日 上午/下午 / 年-月-日 时:分), exactly one | 812-851, 834-840 | D-2: we ship two types where the corpus ships one control plus a format enum |
| C-7 | 日期区间 — "用于选择起始和结束时间，可自动计算时长"; **three** required titles (控件名称 1/2/3 = start/end/auto-duration); 默认提示; 时长 = whether the submitter may MODIFY the computed duration, **default allowed**; 日期类型 as C-6; 其他可选 打印+必填 | 852-909, 862-898 | L8-B |
| C-8 | 关联显示条件 requires 单选/多选/数字/金额/计算公式/日期区间 (or the 请假/加班/出差 groups) — 说明 absent, 日期区间 present | 443 | governs MS-8/MS-9 |

### 0.1 Four divergences the table must not let pass silently

| # | Divergence | Disposition |
|---|---|---|
| D-1 | **C-1 does not settle whether 说明 holds a value.** It says 用于**输入**…文本 with a 默认提示 described as "输入框内未输入内容时的灰色提示文字", yet omits both 标题 and 必填, which both immediate neighbours carry (C-2) | this document does **not** claim the corpus proves either shape. L8-A narrows to display-only for a contract reason, not a corpus one: valuelessness is the whole economy of the slice (no submit validation, no `required`, no FWB mapping, no record projection, no detail-column value semantics). **A valued 说明 is `textarea` with a different label, and the family loses its reason to exist** |
| D-2 | **one control plus a format enum vs. two types.** C-6's 日期类型 is what our `date`/`datetime` split already expresses, with deliberately different value contracts: `date` is a strict, lexically leap-validated `YYYY-MM-DD` civil date whose `min`/`max` compare lexicographically (`ApprovalGraphExecutor.ts:373-380`, `:514-531`); `datetime` is a `Date.parse`-able instant compared by epoch (`:381-388`, `:533-551`) | L8-B does not merge them and adds no third arm |
| D-3 | **C-7's computed duration is EDITABLE by default** — a computed value the submitter may override is a third state, neither display nor input | the one place L8-B could quietly acquire formula semantics; §1.2 keeps v1 display-only |
| D-4 | **C-4 is a first-class 金额 control; ours is not** | M10 binds: currency symbol, grouping, uppercase and declared precision "may enhance an existing number field only when labeled *formatted number*", and the product "must not call it exact monetary storage or enable number FWB" |

### 0.2 Five inherited anchors that do not survive verification at this baseline

| Inherited claim | Verified state at `6c0b9162a9` | Consequence |
|---|---|---|
| a new member "ripples through FWB type-compat `isFwbTargetFieldTypeCompatible`" | **False.** `multitable/approval-fwb-activation.ts:154-161` takes `(storedFieldType: string, targetType)` and all three call sites pass a **multitable** `meta_fields.type` read by SQL (`approval-fwb-write-action.ts:96`, `automation-service.ts:2117`, `routes/automation.ts:456`). No approval `FormFieldType` reaches it; `targetType` is the separate 4-member FWB vocabulary `text\|number\|date\|select` (`:38`) | the L8-C carrier case must rest on §0.3, not a non-existent ripple |
| `normalizeApprovalGraph` carries field-type arms | **False.** `:1734-1738` takes `(value, context, options)` — no `formSchema`, no field-type arm; it normalizes node config only. The coupling lives in five *separate* validators: assignee sources `:648-671` (`:663` `field.type !== 'user'`), visibility rules `:1031-1066` (`:1051` rejects `detail`, `:1060` `record-link`), condition formulas `:673-700`, node field permissions `:1249-1267` (type-agnostic), branch rules `:1620-1660` (type-agnostic) | naming that choke would have produced a gate testing nothing |
| `DETAIL_LEAF_FIELD_TYPES` is *the* derivation | **two**, disagreeing in direction: BE `:450-452` **derives** (`[...FORM_FIELD_TYPES].filter(t => t !== 'detail' && t !== 'record-link')` — 9 members, `attachment` included and barred from detail only by a flag-gated check `:929-935`, so flag-OFF accepts it); FE `apps/web/src/approvals/detailField.ts:25-34` is an **explicit 8-member literal** | a new member is auto-ADMITTED by the backend, auto-OMITTED by the frontend, no compile error either side |
| `AuthorableFieldType` is the authorable gate | the **type** `Exclude<FormFieldType,'attachment'>` (`templateAuthoring.ts:72`) auto-widens; the gate consulted is the **runtime literal** `AUTHORABLE_FIELD_TYPES` (`:81-92`, 10 members) via `isAuthorableFieldType` (`:371-373`). `approvalFormCommands.ts:134-136` derives a *second, independent* set from its own label map, gated `:256` | type and both literals drift silently; that drift produces §2.2's fail-closed behavior |
| the compiler catches a new member | only presentation maps error (five expected, one confirmed directly — N-3 establishes the set), and **none of the erroring sites validates a value** (§0.3) | the census gate is not optional |

Union anchors also moved: FE `apps/web/src/types/approval.ts:35-47`, BE `types/approval-product.ts:59-71`,
member-for-member identical (11 members, same order, same doc comment). The interface is `FormField`
(`approval.ts:171-187`; BE `:279-295`) with `props?: Record<string, unknown>` — one untyped bag shared by
every type.

### 0.3 The governing fact: the compiler guards presentation; every semantic gate is hand-maintained

`record-link` is the worked precedent for what a member costs: it had to be **explicitly excluded** from the
detail-leaf derivation (`:450-452`, comment "explicitly excluded from DETAIL_LEAF below"), from both
visibility denylists (`:1060`, `recordLinkField.ts:84-86`), and from the OpenAPI `FormFieldGeneric` enum so
its `oneOf` stays unambiguous (`base.yml:3682-3683`). None of those was compiler-forced.

| # | Site | Anchor | On a new union member |
|---|---|---|---|
| MS-1 | FE / BE unions | `types/approval.ts:35-47`; `types/approval-product.ts:59-71` | two independent hand copies, no compile link |
| MS-2 | BE publish+load validator set | `:431-444`, gate `:782-784` | `new Set([…bare strings])` infers `Set<string>` — a **third** hand copy, no type link; unlisted ⇒ rejected |
| MS-3 | **BE submit-time value validation** | `ApprovalGraphExecutor.ts:412-413` `default: return null` (`validateFieldType`); `:552-553` `default: return []` (`validateFieldConstraints`) | **FAIL-OPEN: any submitted value accepted, no constraint enforced.** The most dangerous auto-admit in the product |
| MS-4 | BE detail-leaf (derived denylist) | `:450-452`, enforced `:890-896` | **AUTO-ADMITS** |
| MS-5 | FE detail-leaf (explicit list) | `detailField.ts:25-34`, enforced `:174-177` | auto-omits |
| MS-6 | FE authorable type + two literals | `templateAuthoring.ts:72`, `:81-92`, `:371-373`; `approvalFormCommands.ts:121-136`, `:256` | type widens, both literals omit ⇒ whole template read-only (§2.2) |
| MS-7 | **OpenAPI — four edits in one file** | `packages/openapi/src/base.yml:3641` (`FormFieldDetailLeaf.type`, 9), `:3691` (`FormFieldGeneric.type`, 10), `:3726` (`FormFieldRecordLink.type`), `:3750-3766` (`oneOf` + `discriminator.mapping`, 11 entries) | omitted ⇒ requests **fail `oneOf` resolution**; regenerated artifacts (`dist-sdk/index.d.ts:16488`, `:16517`, `dist/openapi.json`, `dist/openapi.yaml`, `dist/combined.openapi.yml`) and `tools/guard-codegen.mjs` must refresh in the same slice |
| MS-8 | BE visibility-rule denylist | `:1031-1066` (`:1051`, `:1060`) | **AUTO-ADMITS** |
| MS-9 | FE visibility/condition driver denylist | `recordLinkField.ts:84-86`; consumers `conditionEdit.ts:128,129,133,277` | **AUTO-ADMITS** |
| MS-10 | Condition-formula type mapper | `ApprovalConditionFormula.ts:871-872` `default: return 'unsupported'`; numeric guard `:591` | auto-omits (fail-closed) |
| MS-11 | FE label / mark / group tables | `TemplateDetailView.vue:959-971` `Record<FormFieldType,…>`; `TemplateAuthoringView.vue:2475`, `:2491`, `:2603-2612`; `approvalFormCommands.ts:121`; `ApprovalFormInlineEditor.vue:456` | **the five compile errors** — plus `TemplateAuthoringView.vue:2503-2516`'s grouped literal, which is *not* derived and does not error |
| MS-12 | Fill / display / prefill dispatch | `ApprovalNewView.vue:166-282`, `:320-333` `v-if` chains; `detailField.ts:474-506` (`default: return String(value)` at `:503`); `prefillFromSnapshot.ts:33-65` (`default: return false` at `:63`) | auto-omits (no widget, no prefill) or stringifies raw |
| MS-13 | Palette chips + property editor | F2 `ApprovalFormPalette.vue:68-111`; **no per-type inspector exists** — editing is inline `v-if` in `ApprovalFormInlineEditor.vue:139/209/224` | conditional; a new type silently renders only type-invariant rows, with no error |

**Therefore "add the member and let the compiler find the sites" does not work here.** Five sites are expected
to error and all five are label, mark or palette *presentation* maps — but only `TemplateDetailView.vue:959`
was confirmed by reading its `Record<FormFieldType, …>` directly; the other four are inferred from the
`Record<AuthorableFieldType, …>` shape plus `Exclude<>` auto-widening, and **gate N-3 is what establishes the
exact set** rather than this paragraph. The count is therefore a working figure, not a verified one (§4). What
*is* verified is the asymmetry that matters: every site deciding whether a value is legal (MS-3), whether the
type may nest (MS-4/MS-5), whether it may drive a condition (MS-8/MS-9), or whether the HTTP contract accepts
it (MS-7) is a hand-maintained denylist or a fail-open `default`, and none of them is compile-forced.
Per-family hand checklists are the enumeration anti-pattern this program has repeatedly lost to (Lock-5
§2.1); §2.1 requires a mechanical census instead.

### 0.4 Shipped surfaces this lock reuses rather than rebuilds

| Shipped surface | Anchor | Disposition |
|---|---|---|
| the per-type **strict props allowlist** precedent | `record-link` `:816-836`: unknown props keys **fail publish**, then props are **canonicalized** to `{ baseId, sheetId }`, never spread residually (`:836`) | the shape L8-C copies (§1.3) |
| the permissive default it excepts | `normalizeFormField` validates `props` only as `isRecord` (`:807-809`) and otherwise carries it **verbatim**: `{ props: { ...value.props } }` (`:860`) | new keys persist today with zero backend change — and zero validation |
| props are **not authorable** today | `buildFormSchema` (`templateAuthoring.ts:860-914`) writes `props` only for `record-link` (`:901-905`); for other types it strips the pins and passes through whatever rode in on `field.original` (`:906-913`). `FieldAuthoringDraft` (`:105-127`) has no numeric members. Values come from presets: `commonTemplatePresets.ts:149` `{min:0.5, step:0.5}`, `:201` `{min:0, derivedFrom:{…}}` | L8-C is **not** free: it needs a draft carrier, an authoring UI, and a `buildFormSchema` arm |
| declared decimals, shipped and load-bearing | `props.precision`, integer clamped 0..6, **default 2**, read by FE `amountAutoSum.ts:18-26` `numberFieldScale`, mirrored by BE `services/amount-total-check.ts:16-24` as the round-half-up scale of the server-enforced `amountConsistencyCheck` total. It is **not** a submit constraint — `ApprovalGraphExecutor.ts:500-513` enforces only `min`/`max` | L8-C **reuses** `precision`; a second `decimals` key would fork a validated arithmetic contract |
| uppercase 大写, shipped | `amountInWords.ts` `amountToChineseWords` (`:38`), pure; rendered only at `ApprovalNewView.vue:460-464`, gated on `field.type === 'number' && isAutoSummedTotal(field.id)` | L8-C **re-sites** it to a per-field display flag; no new arithmetic |
| derived, non-editable form value | `useAutoSumTotal.ts` (design-lock #3189 Gate B) makes the total read-only when `amountConsistencyCheck` is declared | the precedent L8-B follows for its duration |
| the number-FWB stop rule | `approval-fwb-activation.ts:134-138` `hasUnavailableFwbNumberMapping` = `mappings.some(m => m.targetType === 'number')`; save `routes/automation.ts:323`, `automation-service.ts:2063`; execute `automation-executor.ts:3043`, `:3176`; its header records it is deliberately NOT an env flag. sha256 of that 545-line file: `46f54ec5b7918388cb2cc5a8a5e2bf1e092963f310118220194d3eb707e00ad2` | **byte-untouched** by every family here (M-1) |

The stop rule keys on the **multitable target** type, not the approval field — precisely why no display
metadata on our side can weaken it, a claim M-1 proves behaviourally rather than asserting.

## 1. Contracts

### 1.1 L8-A — `explanation` (说明): the first family, and the one that builds the census gate

**Carrier.** A new member `'explanation'` in MS-1's two unions, MS-2, and MS-7's `FormFieldGeneric` enum plus
discriminator mapping.

**Shape.** Display-only. No submitted value, so `required` is **refused at publish** (nothing to require; C-1
carries no 必填), as are `defaultValue`, `options` and `placeholder`; the field never enters `formSnapshot`,
an FWB mapping, or record projection. The BE requires a non-blank `label` for **every** field unconditionally
(`:786`), so an `explanation` carries one even though corpus 说明 has no 标题 — the label is the
authoring-list name, and OD-L8-3 decides where the *rendered body* lives.

**Five closures, none compiler-demanded (§0.3), all in the same slice:** (1) **MS-3** — an explicit
`validateFieldType` arm returning "no value permitted"; relying on `default: return null` makes the type
fail-**open**, not valueless. (2) **MS-4** — excluded from the BE derivation in the `record-link` form at
`:450-452` (a valueless control inside a repeating row has no per-row meaning), and it stays **out** of MS-5
to match. (3) **MS-8 + MS-9** — excluded from **both** visibility denylists; auto-admission would let an
author compare a field with no value, and C-8 corroborates (说明 absent from the driver list). (4) **MS-6** —
added to `AUTHORABLE_FIELD_TYPES` *and* `approvalFormCommands.ts`'s independent set, or the new chip produces
a template the new editor itself locks read-only (§2.2). (5) **MS-10 / MS-12** — the fail-closed defaults
(`'unsupported'`, `return false`) are already correct and are asserted, not changed, while
`formatDisplayValue` needs an arm so a valueless field is not `String()`-ed into a detail snapshot.

**Print is not in this contract.** A sweep across `apps/web/src/approvals`, `types/approval.ts`,
`types/approval-product.ts`, `views/approval` and `ApprovalProductService.ts` finds **no print carrier and no
consumer** (`printable`, `isPrintable`, `printHidden`: zero hits); master §P5 already routes printing to a
separate optional slice. A `print` flag now is a switch no runtime reads — M8 theater. Corpus 打印 appears on
every control (C-1…C-7), so print is one cross-cutting slice, never a per-type property invented here.

### 1.2 L8-B — `date_range` (日期区间)

**Carrier.** A new member `'date_range'` with props `{ dateType: 'date' | 'date_half_day' | 'date_minute';
startLabel: string; endLabel: string; durationLabel?: string }` and value `{ start: string; end: string }`.
`dateType` mirrors C-7/C-6's required 3-way enum and is **required with no absent-default**: a range whose
granularity is implicit cannot be compared or diffed unambiguously. Each arm reuses D-2's shipped value
contract rather than inventing a third. C-7 requires 控件名称 1/2/3, so `label` (BE-required, `:786`) is the
group name, `startLabel`/`endLabel` are required props, and `durationLabel` appears only with a duration.

**`start <= end` is an explicit MS-3 arm, and its error is values-free.** The comparison follows the arm's
granularity (lexicographic for the civil-date arm, epoch for the two time-bearing arms, per
`ApprovalGraphExecutor.ts:514-531` / `:533-551`) and carries **`{ fieldId }` only** — never either endpoint.
This is the first family in this program whose validation reads *user form values*, and `ServiceError.details`
is serialized to clients (Lock-5 §2.4 records the live counterexample at `:6996-7001` leaking a threshold
tally). The naive formulation carries both dates, so B-1 is written the Lock-5 X-1 way: assert the same path
**does** carry `fieldId`, so it cannot pass against an empty payload.

**Widgets bind neither bounds nor format today, and L8-B does not change that.** `ApprovalNewView.vue:222-238`
passes no `disabled-date` and no `value-format` to either shipped picker — the inverse of the number story,
where the widget surfaces more than the server enforces. L8-B renders two pickers of the declared granularity
and leaves the min/max prop story to a separate slice.

**Duration is display-only in v1 (D-3 accepted, not hidden),** following `useAutoSumTotal` (§0.4): an
editable computed value needs an override-vs-recompute precedence rule, a stale-override rule after an
endpoint edit, and approval-time reconciliation of submitted against derived — three decisions belonging with
L8-D's evaluation lock. Authoring copy must not describe the duration as adjustable.

**Detail eligibility is a genuine fork (OD-L8-4) and exclusion is not the default.** MS-4 auto-admits, so v1
exclusion is a positive edit. Recommended **exclude**: two-to-three sub-values inside a structure whose
columns are single-leaf by construction ripples into the derivation column contract (`lineDerivation.ts`),
FWB per-column mapping, diff granularity, and detail display. C-8 admits 日期区间 as a **condition driver**,
a separate question: recommended admitted for the **endpoints only**, never as one comparable value — which
MS-8/MS-9's denylist shape cannot express, so both need a per-type predicate (OD-L8-5).

### 1.3 L8-C — formatted number over the EXISTING `number` type (M10 verbatim)

M10: *"Currency symbol, grouping, uppercase display, and declared precision may enhance an existing number
field only when labeled 'formatted number'. The product must not call it exact monetary storage or enable
number FWB. Exact decimal/money and number writeback remain a separate D0-D4 design line."*

**Carrier (OD-L8-6): props on the existing `number` type. No new union member.** M10 forecloses the
alternative in words, and §0.3 gives the mechanical reason: a new member touches thirteen site families of
which five compile — none a value validator — while auto-admitting itself into MS-3, MS-4, MS-8 and MS-9 and
requiring OpenAPI `oneOf` surgery. **Props on `number` leave all of those untouched by construction: not
merely handled, unreachable.** The FWB ripple previously offered as a third reason does not exist (§0.2).

```ts
// on an existing `number` field's props bag — display metadata only
currencySymbol?: string          // C-4 币种, a display prefix; NOT a currency-typed value
thousandsSeparator?: boolean     // C-4 千位分隔符
uppercaseCny?: boolean           // C-4 大写数字, re-siting the shipped amountInWords.ts
precision                        // ALREADY SHIPPED — reused verbatim, NOT redefined
```

**`precision` is load-bearing and must not move.** It is the round-half-up scale of the server-enforced
`amountConsistencyCheck` total (§0.4) even though it is *not* a submit constraint. L8-C may **read** it as the
declared decimal count and may not change its clamp, default, or arithmetic role: a display change that
silently moved a validation boundary is exactly the failure this program treats as a P1.

**This is authoring work, not a props rename.** Number props are unauthorable today (§0.4), so L8-C must add
a draft carrier, an affordance in `ApprovalFormInlineEditor.vue`'s inline chain (no per-type inspector
component exists), and a `buildFormSchema` arm writing the new keys without dropping the preset keys riding on
`field.original`.

**A strict props allowlist is required, and it is a narrowing that must be sized before it is written.**
Unknown props ride through verbatim (`:807-809`, `:860`), so the new keys would be fail-open, and
`record-link` (`:816-836`) is the fail-closed shape to copy. **But `number` props are already populated in the
wild** — `min`/`max`/`step`/`precision` (`numberFieldProps.ts:18-25`) plus a detail column's `derivedFrom`
(`commonTemplatePresets.ts:201`, consumed by `lineDerivation.ts`) — so a naive `additionalProperties:false`
would **reject existing published templates at their next save, and their history at restore** (`:3652-3660`
re-validates snapshots against today's contract). The allowlist must be the enumerated union of shipped keys
plus the three new ones, derived by sweeping presets and a real template corpus, not by listing what this
document happens to remember (OD-L8-7). "Existing templates stay editable" is the bar, per Lock-5 A-3 — not
"round-trips safely".

**Explicit non-claims, each proved by a gate rather than asserted:** not exact monetary storage; no change to
storage, rounding, or comparison semantics; number FWB not enabled; `hasUnavailableFwbNumberMapping` stays
byte-untouched **and** behaviourally fail-closed for a formatted-number source (M-1). Copy may say 格式化数字,
never 金额.

### 1.4 L8-D — `formula` (计算公式): DEFERRED-BY-DESIGN, with a negative contract

Master §P6: *"Formula fields require a deterministic evaluation and dependency lock."* That lock does not
exist, is **not** drafted here, and is not this lock's to draft. Contracted here is only the placeholder
posture, because recording it prevents an enum-only shortcut:

- `'formula'` **does not enter** either union, MS-2, MS-6, either detail-leaf set, MS-7's enums, MS-8/MS-9,
  MS-11's label maps, or the palette. A template declaring it is rejected at publish by MS-2 (`:782-784`) and,
  arriving from a newer server, makes the whole template read-only (§2.2). Both are intended and both are
  asserted (F-1) with a positive control, because an absence test without one is green against nothing.
- **Adding then removing the member is not reversible:** `restoreTemplateVersion` re-validates historical
  snapshots against today's contract (`:3598`, `:3652-3660`; same at the clone path `:4278-4286`), so any
  version published while it existed becomes unrestorable once it is withdrawn.
- The future lock must define at minimum: evaluation determinism and where evaluation runs; the dependency
  graph and its cycle rule; recompute triggers; stored versus recomputed-at-read; behaviour when a dependency
  is retyped or deleted (master M3's reference-aware retype seam); and approval-time reconciliation of a
  stored result against a recomputed one. A distinct formula surface already ships for *conditions*
  (`ApprovalConditionFormula.ts`, numeric-only at `:591`) and is not the same thing.
- One reuse should not be re-decided later: C-5's 格式 block (`:706-711`) is **the same three options** as
  C-4's (`:662-667`), so a formula result's display metadata is L8-C's vocabulary, not a second one.

## 2. Cross-cutting invariants

**2.1 One family, one slice, and the census assertion is L8-A's deliverable.** A family's union edits, MS-2
entry, MS-3 arm, denylist exclusions, MS-6 literals, MS-7 OpenAPI edits plus regenerated artifacts, MS-11
labels, chip and inspector affordance land **together**, or the family is dropped from the slice: partial
landing produces either a chip that authors a permanently read-only template or a type whose values are
unvalidated. Because only presentation maps are compile-forced (§0.3), the L8-A slice must add a **mechanical**
census — one exported table of field types × the sites that must carry them, with every gate iterating it —
and must show it red when a member is added without its row. **The forcing function has a precedent to
generalize rather than invent:** F2's `apps/web/tests/approval-form-palette-chips.spec.ts:107` asserts
`[...groupedTypes].sort()` equals `[...AUTHORABLE_FIELD_TYPES].sort()` — exactly this shape for one site. A
hand-written per-site checklist does not discharge this.

**2.2 Forward compatibility: the shipped door is whole-template read-only, and this lock preserves it rather
than improving it.** `unsupportedTemplateAuthoringReason` (`templateAuthoring.ts:718-722`) tests field types
**first**: any top-level field failing `isAuthorableFieldType` returns a non-null reason, and
`TemplateAuthoringView.vue:1245`/`:1249` turn that into `readOnly` and `!canSave` for the **entire template**.
Because MS-6's literal is explicit while the type is derived (§0.2), an old editor meeting a new type finds it
absent and locks the whole template — fail-closed **by construction**. For every family here: yes, the
behavior applies; no, it is not changed. Nothing here may be read as per-field graceful degradation.

Two refinements, both inherited, neither introduced here. First, `:719` walks `formSchema.fields` only and does
**not** recurse into `.columns`, so an off-list *detail sub-column* takes a different path — preserved verbatim
on hydrate (`detailField.ts:100-108`, `:118-135`), rejected per-field on save (`:174-177`, server-side
`:892-894`) — so any family admitted into detail must state which door it lands in. Second, MS-2 runs on load
as well as publish, so a type written by a newer server can make a graph unloadable on an older one; Lock-5
§1.1 records the same for `signaturePolicy`, and the remedy, if wanted, is a forward-compatibility slice
covering both, never a weakening here. One residual is noted, not fixed: the reason string interpolates the
field's author-supplied `label` (`:721`) — authoring metadata an admin already sees, and no family here widens
it to a submitted **value**.

| # | Invariant |
|---|---|
| 2.3 | **Values-free errors, tightened for the first value-validating family.** Every error any family adds carries `{ fieldId }` at most — never an endpoint date, number, currency symbol, submitted value, or actor id — on both the HTTP body and the log line. Publish-time refusals reuse the field-index form `normalizeFormField` already uses (`:783` interpolates only the index, never the offending type) and add nothing |
| 2.4 | **Print stays out of every family (§1.1).** No family authors a `print` flag while no runtime reads one. A ratified print slice adds one cross-cutting property over the whole vocabulary; a per-type flag invented here would have to be un-invented then |
| 2.5 | **Version diff needs no arm; restore is the constraint.** `templateVersionDiff.ts` is type-agnostic — it keys fields by `id` and compares canonicalized JSON (`:28-44`, `:102-116`) — so a new type diffs correctly with zero changes, and MS-11's compile-forced label map is the version-detail surface precisely because presentation is all the compiler guards. The real constraint is `restoreTemplateVersion` re-validating history against today's contract (`:3652-3660`): a family's vocabulary may widen but must never narrow after any version is published with it |
| 2.6 | **Palette/inspector statements are conditional on F2, and no inspector component exists.** Chips land in F2's five hand-written groups (`ApprovalFormPalette.vue:97-102`: 文本/数值/选项/日期/其他 — a plain literal, not derived, which is why `:107`'s test is the forcing function); `date_range` belongs in 日期, `explanation`'s group needs an owner decision. There is **no per-type property-editor component** on main or F2: editing is an inline `v-if` chain in `ApprovalFormInlineEditor.vue` (`:139` record-link, `:209` select/multi-select, `:224` detail), so a new type silently renders only type-invariant rows with no error. Each family's affordance is new UI in that chain, not a registry entry |

## 3. Acceptance gates

Every absence assertion carries a positive control; an absence test without one is green against nothing.
Every mutation row names the test it turns red and asserts the anchor was hit. Backend gates land in the
required backend lane; frontend gates extend `apps/web/scripts/run-required-web-tests.sh`, never an ungated
file.

| # | Gate | Assertion | Positive control (mandatory) |
|---|---|---|---|
| M-1 | **M10 pinning gate, two halves** | (i) drift detector: `approval-fwb-activation.ts` sha256 equals `46f54ec5…e00ad2` and `hasUnavailableFwbNumberMapping` is byte-identical; (ii) **behavioural gate**: a `number` field carrying every L8-C display prop, mapped to a multitable `number` target, still fails closed `exact_number_mapping_unavailable` at BOTH save (`routes/automation.ts:323`, `automation-service.ts:2063`) and execute (`automation-executor.ts:3043`, `:3176`) | mutating `hasUnavailableFwbNumberMapping` to `return false` reds a **named** behavioural test — the digest alone is a change detector, and re-pinning it must not be able to make the suite green |
| M-2 | No exact-money claim | no shipped string in authoring, member, or error surfaces describes an L8-C field as 金额 / money / exact | the same sweep DOES find 格式化数字 — not passing over an empty string set |
| N-1 | **Census exhaustiveness (§2.1)** | the exported type × site table covers **MS-1…MS-13** by exact set equality and every other gate iterates it. MS-13 is included, not exempted for being F2-conditional: §2.1 requires the chip and inspector affordance to land with the family, so leaving it outside the bound would permit exactly the partial landing this gate exists to prevent. While F2 is unlanded, MS-13's row asserts the affordance is absent for **every** type, so the equality holds without it and tightens automatically when F2 lands | adding a 12th field type with no row reds the equality test; each landed family with its row present passes — coverage is table-selected |
| N-2 | **Fail-open value validation is closed** | each landed family has an explicit `validateFieldType` arm; a wrong-shaped submitted value is rejected | **deleting only that arm** makes the value ACCEPTED via `ApprovalGraphExecutor.ts:412-413` and reds a named test — proving the default is fail-open and the arm load-bearing |
| N-3 | Compile-door honesty | a test records the ACTUAL set of sites that fail to compile on a new member — executed, not inferred — and asserts it contains only MS-11 presentation maps, with no value, nesting, condition, or OpenAPI site among them. This gate, not §0.3's working figure of five, is what fixes the count | removing one MS-11 arm reds a named typecheck; removing an MS-4 exclusion reds **no** typecheck — that asymmetry is why N-1 exists |
| N-4 | **OpenAPI contract (MS-7)** | a request carrying a landed type resolves against `FormFieldGeneric` and its `discriminator.mapping`; `base.yml` and every regenerated artifact agree; `guard-codegen.mjs` passes | reverting only the `discriminator.mapping` entry makes the request fail `oneOf` and reds a named test — the enum edit alone is insufficient |
| A-1 | `explanation` valuelessness | `required: true`, `defaultValue`, `options` and `placeholder` each fail publish; the field is absent from `formSnapshot` and FWB source candidates | the same keys on a `textarea` publish normally — rejection is type-selected |
| A-2 | `explanation` denylist closures | it fails publish as a detail column (MS-4) and is unselectable as a visibility/condition dependency at **both** MS-8 and MS-9 | **reverting only the MS-4 exclusion admits it**, and **neutering MS-8 and MS-9 separately reds two DIFFERENT named tests** — one test asserting "rejected" proves nothing about which door did it (Lock-5 §2.3) |
| A-3 | Display and prefill | `explanation` is never prefilled on 再次提交 and never reaches `formatDisplayValue`'s `String()` default | a `text` field in the same snapshot IS prefilled; a `number` detail cell IS formatted — neither default passes vacuously |
| B-1 | Range validation, values-free | `start > end` fails with `{ fieldId }` only; no endpoint value appears in body or log | the same path DOES carry `fieldId`, and `start === end` succeeds — comparison-selected |
| B-2 | `dateType` strictness | absent or out-of-enum `dateType` fails publish, never coerced; each arm round-trips; the civil-date arm rejects a datetime endpoint and the minute arm accepts it | a valid arm in the same graph publishes — rejection is value-selected |
| B-3 | Duration is not editable | a submitted duration differing from the derived one is handled per OD-L8-8; no authoring control offers editing | the derived duration IS rendered and DOES change when an endpoint changes — not green against an absent duration |
| B-4 | Detail eligibility is decision-selected (OD-L8-4) | under the recommended exclusion, `date_range` as a detail column fails publish, and the slice states which §2.2 door it lands in | reverting only that exclusion admits it; `number` stays admitted throughout |
| C-1 | Props survive AND stay editable | a template carrying all L8-C props survives publish and reload and stays **EDITABLE** in both editors | a template carrying `signaturePolicy` still goes read-only in both (Lock-5 A-3's control) — proving the props path widened rather than a guard being removed |
| C-2 | **Allowlist narrowing is bounded (OD-L8-7)** | every shipped preset and fixture template still publishes after the allowlist lands, including a detail column carrying `derivedFrom` (`commonTemplatePresets.ts:201`); every historical version still restores (`:3652-3660`); an unknown key fails publish and props are canonicalized with no residual spread | remove `derivedFrom` from the allowlist and a named test reds — the sweep found real pre-existing keys rather than asserting there were none |
| C-3 | `precision` semantics unmoved | the total-check gives byte-identical verdicts across a scale sweep before and after L8-C; `numberFieldScale`'s clamp and default are unchanged on both sides | changing the clamp on either side reds a named test — the invariance is not vacuous |
| C-4 | Uppercase is display-only | `uppercaseCny` changes no stored value, no comparison, and no total-check outcome | the caption IS rendered and DOES change with `precision` — the no-op assertion is paired with a visible effect |
| F-1 | `formula` absence, fail-closed | `'formula'` is in neither union, MS-2, MS-6, either detail-leaf set, MS-7's enums, MS-8/MS-9, MS-11, nor the palette; a template declaring it fails publish and makes an editor read-only | the **landed** families ARE present in each of those sites in the same assertion — the absence test is paired so it cannot be green against nothing |
| X-1 | Old-template compatibility | a corpus of pre-Lock-8 published templates round-trips save → publish → preview → version-compare → restore byte-for-byte | mutate one new prop in a new-format fixture and assert the version diff SHOWS it |
| X-2 | Forward-compat door (§2.2) | a template carrying a landed L8 type opens **read-only, whole-template**, save disabled, in a build lacking that MS-6 entry | the same template is fully editable in the build that has the entry — read-only is entry-selected, and no per-field partial-edit path exists |
| X-3 | Browser check, per family | real-browser (not jsdom): each family's chip and inspector affordance are reachable, operable and state-announced at 1440×900, 1024×768 and 390×844 | a template with no L8 field renders none of those elements at any width |

## 4. Owner ratification block

```text
Decision: RATIFY
Owner: zensgit — goal-set in-session instruction (2026-08-17), executing recorded recommendations;
  recorded by the executing session with this provenance; reversible before implementation lands.
  Independent pre-ratify review: Claude (fable) — spot-verified the executor fail-open `default:
  return null` (submit values accepted for unknown types, :412-413) and accepted the two task-premise
  corrections (FWB compat reads multitable meta_fields.type; no normalizeApprovalGraph field-type
  arm); drafted by opus with two pre-push review fixes.
Date: 2026-08-17
Document SHA: drafted cbf1014a65; this record lands on top.
Decisions recorded: OD-L8-1 (a) · OD-L8-2 (a) display-only 说明 · OD-L8-3 (a) props.text carrier ·
  OD-L8-4 (a) · OD-L8-5 (a) per-type predicate both sides · OD-L8-6 (a) props on existing number ·
  OD-L8-7 (a) sized-by-sweep allowlist · OD-L8-8 (a) derived display-only duration · OD-L8-9 (a)
  formula DEFERRED-BY-DESIGN — all nine per this document's recommendations.
Independent review: (none recorded)

Decisions required ([R] = this document's recommendation; rejected options carry their citation so
they are not re-proposed):

  OD-L8-1  Family staging order (discriminator = Lock-5's disjoint-write-set rule, not preference;
           L8-A and L8-C both touch templateAuthoring.ts, ApprovalFormInlineEditor.vue and the F2
           palette, so their write sets are NOT disjoint) — (a)[R] serial L8-A -> L8-B -> L8-C, L8-A
           first as the smallest family and the one that builds §2.1's census · (b) L8-A ∥ L8-C, only
           if a write-set diff proves disjointness first · (c) L8-C first [rejected: inherits the
           census as undelivered debt]
  OD-L8-2  L8-A value posture — (a)[R] display-only, no submitted value (D-1: valuelessness is the
           economy of the slice) · (b) an optional un-required text value per the 默认提示 reading
           [rejected D-1: that is `textarea` with a different label]
  OD-L8-3  L8-A rendered-body carrier + palette group — (a)[R] `props.text`, `label` (BE-required,
           :786) only in authoring lists/pickers/errors; group per owner choice · (b) reuse `label`
           as the body [rejected: labels surface in pickers, version diffs and the read-only reason
           string :721 — a paragraph leaks into all three]
  OD-L8-4  L8-B detail sub-field eligibility (MS-4 AUTO-ADMITS, so exclusion is a positive edit) —
           (a)[R] exclude in v1 (two-to-three sub-values in a single-leaf column structure ripples
           into lineDerivation, FWB per-column mapping, diff granularity, detail display) · (b) admit,
           extending those four contracts same-slice · (c) admit endpoints as two separate columns
           [rejected: that is two `date` columns, already buildable today]
  OD-L8-5  Visibility/condition driver shape (MS-8 + MS-9) — (a)[R] a per-type predicate on BOTH:
           `explanation` excluded, `date_range` admitted for ENDPOINTS only (C-8 admits 日期区间; a
           range is not one comparable value) · (b) denylists plus `explanation` only [rejected:
           leaves `date_range` auto-admitted as a single comparable] · (c) exclude `date_range` from
           conditions entirely [accepted residual: diverges from C-8]
  OD-L8-6  L8-C carrier — (a)[R] props on the EXISTING `number` type; no new member, so MS-3/4/5/7/
           8/9/11/12 are unreachable rather than merely handled · (b) a new `formatted_number` member
           [rejected by M10 verbatim ("may only enhance the existing number field") and by §0.3:
           thirteen site families, only presentation maps compile-forced, plus OpenAPI oneOf
           surgery. The previously-offered FWB type-compat ripple does NOT exist (§0.2) and must not
           be re-cited either way]
  OD-L8-7  L8-C props allowlist width (unknown props ride through verbatim today, :807-809/:860, so
           the new keys would be fail-open) — (a)[R] the record-link fail-closed shape (:816-836)
           with the allowlist derived by SWEEPING shipped presets and a real template corpus for
           pre-existing `number` keys (≥ min/max/step/precision plus a detail column's derivedFrom) ·
           (b) additive-permissive: validate the three new keys, unknown keys still ride through
           [accepted residual] · (c) naive additionalProperties:false [rejected §1.3: rejects
           existing published templates at their next save AND their history at restore, :3652-3660]
  OD-L8-8  L8-B duration posture — (a)[R] derived, display-only in v1 per useAutoSumTotal; a
           submitted duration is ignored server-side and no control offers editing · (b) editable per
           C-7's default [rejected §1.2 for v1: needs override-vs-recompute precedence, a
           stale-override rule, and approval-time reconciliation — L8-D's evaluation lock] ·
           (c) omit it [rejected: C-7 requires 控件名称 3 and it is the family's value over two
           separate date fields]
  OD-L8-9  L8-D formula — (a)[R] DEFERRED-BY-DESIGN per §1.4 + gate F-1, the evaluation/dependency
           lock named as a separate future owner lock per master §P6 · (b) admit the member now with
           evaluation unimplemented [rejected: master §P6, and it is the enum-only shortcut §1.4
           exists to prevent — an inert type is M8 theater that MS-3/4/8/9 would auto-admit, and
           :3652-3660 makes withdrawing it later unrestorable for any version published meanwhile]

Decisions recorded: (none — PROPOSED)

Unverified at this baseline, recorded so no later document treats it as settled:
  - whether ANY FWB path validates the SOURCE approval form field's TYPE. Source-field EXISTENCE is
    checked (`unknown_form_field`, automation-service.ts:2068); a source-side TYPE check was not
    located, and §0.2 establishes only that isFwbTargetFieldTypeCompatible is target-keyed.
  - whether `FormFieldGeneric.props` in packages/openapi/src/base.yml permits additional properties.
    If it does not, OD-L8-7's allowlist is also an MS-7 edit; that props schema was not read.
  - the exact set of sites that fail to COMPILE on a new union member. Only
    TemplateDetailView.vue:959 was confirmed by reading its Record<FormFieldType,…> directly; the
    other four in MS-11 are inferred from the Record<AuthorableFieldType,…> shape plus Exclude<>
    auto-widening, and no typecheck was executed. Gate N-3 establishes the set; §0.3's "five" is a
    working figure. The verified claim — that no value, nesting, condition, or OpenAPI site is
    compile-forced — does not depend on the count.
  - the full pre-existing population of `number` props keys across shipped presets and real
    templates. OD-L8-7(a) makes that sweep a precondition of the allowlist, not an assumption.
  - F2's surfaces are on a branch that is not an ancestor of this baseline; §2.6 makes every chip
    statement conditional on it landing.
  - no test was run, no browser opened, and no CI invoked for this document. Source and corpus
    inspection qualifies the plan, not the product.

Runtime authorization: NONE — ratifying this document would authorize design only. Each L8 family
  still needs its own PR, required checks, adversarial gate, and ledger row. No flag, no UAT, no
  deployment. Gate C-2 cannot be written before OD-L8-7's sweep is performed, and B-3/B-4 cannot be
  written before OD-L8-8/OD-L8-4 are decided. Department and contact controls remain Lock-2's; exact
  decimal/money and number FWB remain master §8 non-goals.
```
