# K3 WISE Reference Mapping — UI Contract Design - 2026-05-25

## Scope

- Turn the #1821 authoring design + #1824 probe findings into a **product contract** for the Data Factory / K3 reference-mapping UI and its completeness preview.
- **Docs-only.** No K3 Save runtime; no Submit/Audit/BOM; no read/list runtime; no new K3 object; nothing implemented.
- Step 1 of the agreed sequence: **UI-contract (here) → frontend-only preview → [decide read/list runtime] → 1 Material Save-only regression**.

## Background — what is already settled (evidence)

- **#1792 GATE `PASS_SAVE_AND_READBACK`** — the deployment requires **full reference objects** (`{FName, FNumber}` / `{FID, FName}`), proven via clone-preservation of an existing Material detail.
- **#1824 O4** — `config.objects.material.schema` (incl. each field's `reference.identifier`) round-trips `upsert` → store → `get`; the public projection rebuilds null-proto objects (JSON content identical).
- **#1824 lookup analysis** (`univer-meta.ts:1636-1674`) — a multitable `lookup` yields an **array** of **one** target field's raw value, **skipping** null/undefined targets and unreadable linked records. ⇒ a single lookup **cannot** compose a reference object.

## Contract

### C1 — ③ 基础资料对照表 is multi-column components, NOT single-lookup-to-object
- One row = one full K3 reference object, expressed as **separate columns**: `sourceCode` / `k3FNumber` / `k3FName` / `k3FID` / `enabled` / `description`.
- Component rule: at least one of `k3FNumber` | `k3FID`; any `{FName, …}` shape additionally requires `k3FName`.
- The UI **MUST NOT** present a "single lookup → reference object" path (proven impossible, #1824). Each component is surfaced by its **own** lookup (or carried as its own staging column) and composed (see C3).

### C2 — lookup output is an array with null-skip semantics
- Any consumer of a lookup-sourced reference column **MUST** treat the value as `unknown[]`, never a scalar.
- The array length **may be less than** the number of linked records (null/undefined targets and unreadable links are skipped — `univer-meta.ts:1648-1650`).
- Consumer rule: **an empty array ⇒ "unresolved"**. Never assume "1 linked record ⇒ 1 entry"; `[0]` is valid **only after** asserting the array is non-empty.

### C3 — composition location (the core constraint)
Composing `{FName, FNumber}` / `{FID, FName}` from C1 components has four possible homes. **This contract authorizes exactly one and explicitly does not enable the others.** Any consumer that composes a reference object **MUST declare** its composition home.

| composition home | lock status | this contract |
|---|---|---|
| **preview** (client-side) | lock-safe | ✅ **AUTHORIZED** (the step-2 preview) |
| operator/client-driven Save | lock-safe | ❌ NOT authorized here |
| server / pipeline transform | **FROZEN** | ❌ NOT enabled |
| staging pre-populated (objects already in the row) | needs read/list to source | ❌ deferred (separate track) |

**Only preview composition is in scope.** Productionized (pipeline) Save composition is a **separate decision in step 3** (read/list runtime) and is **NOT pre-committed** by this contract. This clause exists to stop a later PR from quietly composing server-side "because the contract didn't say not to."

### C4 — ② shape selector persists to runtime config
- Persist per-field shape into `config.objects.material.schema[*]` (#1824 O4: this round-trips). The frontend **MUST write the COMPLETE schema array** — the config merge replaces the whole array (shallow-merge), so a partial write would drop sibling fields.
- The get/public projection returns **null-prototype** objects; consumers compare JSON-normalized content, not by prototype/`instanceof`.

### C5 — preview completeness + Save guard
- ⑤ preview reads the staging reference columns + the user's ③ mapping (a **bounded sample scan**, not full-table), composes **client-side** (C3), and lists each reference value as resolved or **"unresolved"** (no ③ row OR missing a required component OR empty lookup array per C2).
- The preview **MAY disable the Save action client-side** as a UX guard. This is **not** a hard server gate — a hard block would be runtime, out of scope here.

## Boundary / non-goals

- Docs-only; nothing implemented; no behavior changed.
- **No** K3 Save runtime; **no** Submit/Audit/BOM; **no** read/list runtime (deferred by capability; the docs-front read/list contract is #1593); **no** new K3 object.
- **Rollback procedure is not in scope** (separate track). The eventual 1-record Save regression's manual rollback belongs to that test's customer approval, per the #1792 GATE thread.
- Productionized (pipeline/server) Save composition is deferred to step 3.

## See also

- #1821 — reference-mapping authoring design (the surfaces ①–⑤ this contract formalizes).
- #1824 — O4 round-trip test + lookup code-path analysis (merge `996bf3c73`).
- #1792 — Customer GATE; `PASS_SAVE_AND_READBACK` proved full reference objects are required.
- #1593 — read/list docs-front GATE contract (the runtime is deferred; not started here).
