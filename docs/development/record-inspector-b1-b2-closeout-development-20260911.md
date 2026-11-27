# Record Inspector B1/B2 Development Closeout

Status: product successors merged; bounded technical closeout, not UAT or release acceptance.
Evidence date: 2026-09-11. See the [verification report](record-inspector-b1-b2-closeout-verification-20260911.md).

## Authority and scope

The owner authorized #5585, then closure of #5488 only after landing, followed by serial B1/B2 integration. The W2 erratum was not blanket approval for either follow-up. B1 items 4/7/8/9 and B2 item 11 were independently confirmed; B1 item 9 is limited to its new section component, not the deferred B3 migration. The owner subsequently authorized new successors while retaining the original PRs, branches and metadata.

The integration decision is recorded in [B1 #5632](https://github.com/zensgit/metasheet2/pull/5632) and [B2 #5635](https://github.com/zensgit/metasheet2/pull/5635). This report does not ratify other items in the [historical design brief](multitable-record-inspector-v3-design-20260905.md), whose proposed/unchecked portions remain unchanged.

The separate docs-only Draft is covered by standing development/document delivery authority relayed from direct owner messages in coordinator task `019ecac3-1eb3-7cb1-b965-dfbf625cc542`: deliver design and verification MD; permit isolated development, ordinary push and new Draft/HOLD PRs; retain separate approval for Ready, merge, protection changes, flags, dispatch, deployment, production and real customer data. This is a provenance note, not an invented owner comment ID. The document PR must remain Draft until separately authorized.

## Landed commit chain

| Slice | Original head | Successor head | Actual merge |
| --- | --- | --- | --- |
| B1, refs #5494, successor #5632 | `c4da29de6146bb07afa65425db20b3c62cab6399` | `8ae716ed7bf5da17cd911f3366bdb05a62b68ee5` | `182f643f4465ba2556a06166c545d8a84e333281` |
| B2, refs #5495, successor #5635 | `ab91dc94c0348cd9f2938e81b7b783037cd9264d` | `3dc64615e5766b759f998a6b467a02bef178900b` | `f68a9377b8c8c7e3c160e728823a3b9106d86b0e` |

#5585 landed at `a22955f83187602d09f787889c4e433fdc815107`; #5488 was closed after that landing. B2 was integrated from actual B1 main `182f643f...`, not an unmerged B1 preview. No writes were made to original #5494/#5495 refs or metadata; they are not closed by this packet.

## B1 implementation

B1 preserves explicit-open behavior while adding view-ordered and hidden-in-view field sections, layer-2/property and layer-3 permission filtering, session-only hide-empty, copy-link, linked-record chips, keyboard behavior and attachment gallery layout. The primary section stays headerless/expanded; only the hidden-in-view section has disclosure state. Hide-empty retains its snapshot-plus-live-value behavior and exceptions.

Integration touched 17 relative-main paths. Fourteen non-intersection blobs equal the original B1 blobs. The 42 added Workbench lines match the original B1 patch while retaining intervening sheet-deletion and import-create-fields changes. Both test entrypoints preserve each parent's calls and test tokens, not just the last list in a file.

The B1 candidate tree was `4dff67d9719c7976555c8bea7275524a921aa89f`. Main advanced to `1dd4d489ceeecfd9987dbb06eaf1ceeb889ff204` with five disjoint stock-prep paths. The ordinary merge parents are that main and the exact B1 head; actual tree `0d4cf1a1bba767ce8d3018255f74866c136de09d` equals the prediction. Its first-parent binary patch equals the tested B1 increment, with all five new-main blobs preserved.

## B2 implementation and intersection fixes

`patchCell` returns an additive per-call `GridPatchFailure | null`. Routing checks `VERSION_CONFLICT` first and retains banner, marker and toast. Otherwise nonempty field errors, HTTP 422 or `VALIDATION_ERROR` can route inline only if the current inspector can render a nonempty alert; other outcomes retain toast fallback. The disclosed two non-field HTTP 400 `VALIDATION_ERROR` cases still route inline. This is not a backend error-contract change.

Integration repairs three intersections with B1:

- The inspector asks the fields panel's actual group/disclosure state via `hasRenderedField`, rather than assuming that a permission-visible field is rendered. Collapsed, property-hidden, hidden-empty, wrong-tab and wrong-record fields cannot silently swallow errors.
- A pending field error exempts its row from hide-empty, preserving the rejected draft and alert.
- A per-field request identity owns the inline error update. Synchronous record/view invalidation clears ownership. Older success cannot clear a newer error; older failure cannot replace it, including A-B-A navigation. Ineligible late errors keep toast fallback.

Frozen source anchors at merge `f68a9377...`:

- [FieldsPanel: hasRenderedField (~L648), isHideEmptyExempt (~L687)](https://github.com/zensgit/metasheet2/blob/f68a9377b8c8c7e3c160e728823a3b9106d86b0e/apps/web/src/multitable/components/MetaRecordFieldsPanel.vue#L648).
- [Inspector: canAnchorFieldError (~L1455)](https://github.com/zensgit/metasheet2/blob/f68a9377b8c8c7e3c160e728823a3b9106d86b0e/apps/web/src/multitable/components/MetaRecordInspector.vue#L1455).
- [Workbench: onDrawerPatch ownership (~L2719)](https://github.com/zensgit/metasheet2/blob/f68a9377b8c8c7e3c160e728823a3b9106d86b0e/apps/web/src/multitable/views/MultitableWorkbench.vue#L2719) and [context reset (~L4417)](https://github.com/zensgit/metasheet2/blob/f68a9377b8c8c7e3c160e728823a3b9106d86b0e/apps/web/src/multitable/views/MultitableWorkbench.vue#L4417).

Existing composable rollback ordering, global error behavior and unrelated deep-link/data-loading paths were not redesigned. This is not proof of complete asynchronous data-path isolation.

B2 touched the original 11 relative-main paths, with no backend, migration, dependency or flag delta. The candidate parents are actual B1 main and the original B2 head; candidate tree is `d9cebbd74a910ffeee70f1470dc36ea168e2d55c`. Main then advanced to `0ffc5e3550f80c3fb6a427ebd1f50fd69c6d3891` with five disjoint stock-prep docs/tests. Actual merge parents are that main and the exact B2 head; actual tree `535bc9a2afe97a366006ba34ea2c8c9fc1a264f9` equals the prediction. First-parent binary patch equals the tested B2 increment, and all five new-main blobs are retained.

## Gates and explicit limits

| Gate | Disposition |
| --- | --- |
| Independent B1/B2 design decisions | Confirmed for the bounded items above; W2 erratum alone was insufficient |
| Serial merge and exact-head CI | Completed for #5632 then #5635; details in verification report |
| Integration review | Independent bounded review found no P1/P2 integration blocker; not a new full product review |
| Browser/UAT | No new manual browser, accessibility readout or UAT session in this integration packet; automated browser CI is narrower evidence |
| B3 / wide-screen / persistence | Deferred; no new approval or flag enablement |
| Registry / deployment / production | Not authorized or executed; automatic workflows built only and skipped publication/deployment |
| Two nightly tracks and #5598 | Independently unresolved in coordinator scope; not closed or accepted by this packet |

## Process disclosure

B1 local commit/new-branch push began before the fresh shared-writer idle acknowledgement arrived, repeating an earlier sequencing deviation. Main and original refs were not modified by that operation, but a later acknowledgement does not retroactively cure the order. This remains disclosed in [B1's final evidence comment](https://github.com/zensgit/metasheet2/pull/5632#issuecomment-5630484921).

B2 commit/push and final Ready/merge used received idle acknowledgements followed by separate successful fresh-ref/check reads before writing. The final merge used the exact-head match and no administrator override. A coordinator window is not a repository-wide lock against unrelated writers. [B2's final evidence comment](https://github.com/zensgit/metasheet2/pull/5635#issuecomment-5631040064) records the checks and disjoint main drift. Correct later sequencing does not erase the earlier B1 deviation.
