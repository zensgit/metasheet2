# DF-T3b-2b UI-wire — preview sends referenceMappingSources (operator-UI-reachable) — development verification (2026-05-29)

> Small follow-up to DF-T3b-2b (#2073). That slice made the preview **route** resolve
> `from_reference_table` live from real mapping sheets, but it was **API-reachable only** — no shipped
> client sent `referenceMappingSources`. This wires `IntegrationWorkbenchView.previewPayload` to send
> them, so an operator clicking Preview gets live mapping-sheet resolution. **Frontend-only, read-only.**

## Locked scope (owner-set)

In:
- `previewPayload` sends `referenceMappingSources` when the operator provides them (and a
  `payloadTemplate` is set — the DF-T1 path where `from_reference_table` applies).
- A minimal operator input: a `referenceMappingSources` JSON textarea, mirroring the existing
  `payloadTemplate` textarea pattern.
- A request-body keystone test (the POST carries `referenceMappingSources`) + a negative control.

Out:
- ❌ DF-T3b-2c real-Save compose-before-`upsert` (separate opt-in).
- ❌ No richer structured authoring UI (domain/system/object pickers) — the JSON textarea is the
  minimal wire; a structured editor is future polish.
- ❌ No backend change (the route + bulk-read shipped in #2073).

## What shipped (frontend-only)

- `apps/web/src/services/integration/workbench.ts`: new `IntegrationReferenceMappingSource`
  (`{domain, systemId, object}`) + optional `referenceMappingSources` on
  `IntegrationTemplatePreviewRequest`.
- `apps/web/src/views/IntegrationWorkbenchView.vue`:
  - `referenceMappingSourcesText` ref + a `data-testid="reference-mapping-sources"` JSON textarea
    (with an operator hint: binds each `from_reference_table` domain to its staging system/object; only
    effective when a target template JSON is set).
  - `previewPayload` (inside the `payloadTemplate` path) parses the textarea: non-empty → must be a JSON
    **array** → `request.referenceMappingSources`; empty → omitted (byte-compatible); invalid JSON /
    non-array → throws → error path, **no backend call**.
- `apps/web/tests/IntegrationWorkbenchView.spec.ts`: extends the preview test.

## Reachability — now closed for the operator

DF-T3b-2b (#2073) was **API-reachable, not operator-UI-reachable**. With this wire, an operator who
fills the reference-mapping-sources textarea and clicks Preview produces a POST that **carries
`referenceMappingSources`**, which the #2073 route live-bulk-reads → `from_reference_table` resolves
per-material in the preview. The three-state fail-closed + the server-side staging-kind / duplicate
guards all live in #2073's route; this slice only supplies the input.

## Test + negative control

`IntegrationWorkbenchView.spec.ts` (15 passed): the **request-body keystone** (#1968 lesson — assert
the POST body, not just a render) — before filling, `referenceMappingSources` is **absent** from the
body; after filling the textarea and re-previewing, the POST body **carries** the parsed array (and
still the DF-T1 `payloadTemplate`). Negative control: neutering the send (`void parsedSources`) makes
the keystone assertion **fail**. vue-tsc clean for the changed files.

## Known limitations / remaining operator friction (on record — not fixed here)

- **`systemId` discoverability.** The wire is correct, but the textarea needs a `systemId`, and the
  view surfaces system **names** (the source-system `<select>` binds `:value="system.id"` but displays
  the label; ids appear only as option values / `data-testid`s). Object names and staging-descriptor
  ids *are* visible, but the raw `systemId` is not plainly copyable. So "operator-UI-reachable" means
  the input is wired and fillable — **full self-service still needs the operator to know the `systemId`
  or a future structured picker** (domain/system/object). Honest framing: this closes the *send* gap,
  not the *discover-the-binding* gap.
- **Parse-error affordance.** Invalid reference-mapping-sources JSON throws into the existing preview
  catch → the generic `预览失败`, indistinguishable from a backend preview error. Acceptable for a
  minimal wire; a distinct "mapping-sources JSON malformed" message belongs with the structured-editor
  polish.

## Next (gated, separate opt-in)

- **DF-T3b-2c** — real-Save compose-before-`upsert` (changes K3 Save bytes), with its recorded review
  checklist (per-row fail-closed → dead-letter/provenance, same bindings as preview, I/O failure as its
  own category).
- Optional later polish: a structured reference-mapping-sources editor (domain/system/object pickers)
  in place of the raw JSON textarea.
