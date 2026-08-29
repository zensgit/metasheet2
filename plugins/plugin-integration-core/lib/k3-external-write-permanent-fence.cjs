'use strict'

// E4 (HG v1.2 §10) PERMANENT STRUCTURAL FENCE for K3 WISE external write-back.
//
// AUTHORITY. The go-live gate G-4, ratified as E4 in the Human-Governance solution v1.2, declares
// K3 Save/Submit/Audit external write-back permanently banned. §10.1 INVARIANTS, verbatim:
//
//   - 本 runtime 中 K3 Save/Submit/Audit 永久不可达。
//   - env flag、通用 C6 开关、owner policy、审批结果和请求参数均不能解锁。
//   - 若未来改变,只能通过新的 superseding ADR、独立 Gate 和代码变更;不得预留运行时开关。
//   - 固定 values-free 错误码:`K3_WISE_EXTERNAL_WRITE_DISABLED`。
//
// Before this module those invariants had no enforcement point in code — Submit/Audit were
// hard-off, but Save still executed and `erp:k3-wise-webapi` was a first-class C6 apply target.
//
// WHAT THIS IS. A leaf module (zero intra-package requires, so it can be pulled into the HTTP
// route layer, the C6 apply engine, the K3 C6 write source and the K3 WebAPI adapter without
// creating a require cycle) holding ONE closed refusal token and the predicate that decides it.
// It is deliberately parameterless: there is no options object, no env read, no policy argument
// and no registry lookup anywhere in this file, because every one of those would be the
// re-enable surface §10.1 forbids. NO RUNTIME SWITCH IS RESERVED. Re-enabling K3 external write
// requires a superseding ADR, its own Gate, and editing product code in four independent places.
//
// §10.2 FOUR LAYERS OF REFUSAL, each independent of the others:
//   1. Apply HTTP route      (http-routes.cjs `pipelinesExternalWriteApply`) — after authz, on
//      credential-STRIPPED target metadata, before credential reload / token consumption /
//      source read / adapter construction / any network call.
//   2. C6 apply engine       (external-write-dry-run.cjs `applyExternalWrite`) — after static K3
//      target resolution, before token consumption and before the planner.
//   3. K3 write-source       (adapters/k3-wise-c6-write-profile.cjs insert/update/write) —
//      before the target adapter is obtained.
//   4. K3 WebAPI adapter     (adapters/k3-wise-webapi-adapter.cjs `upsert`) — final refusal,
//      before login.
// If any upper guard is bypassed by a future caller, the deepest layer must still guarantee
// `login=0, save=0`.
//
// WHAT IT IS NOT. It does not touch K3 READ. A K3 read failure must surface its OWN pre-enumerated
// read-only code and must never be swallowed into the write-fence code (§15.2 E4-06). It does not
// touch preview/composition (composing a Save body and never sending it is not a write;
// `previewUpsert`, the C6 dry-run planner and the target-payload preview all keep working — a
// blanket deny that killed the read path would be a FAIL, not a pass, under §15.2 E4-05).
//
// VALUES-FREE. The only thing that ever leaves here is the fixed token below plus the connector
// KIND literal (a structural identifier, the same class of fact the C6 planner already reports as
// expectedKind/actualKind). No customer value, key, count, path, credential or message.

// The single closed refusal token, frozen by §10.1. Fixed string, never derived, never formatted
// from input, identical at every one of the four layers.
const K3_WISE_EXTERNAL_WRITE_DISABLED = 'K3_WISE_EXTERNAL_WRITE_DISABLED'

// The connector kind the ban covers. Kept as its own literal rather than imported from the
// adapter or the C6 profile ON PURPOSE: this module must stay a leaf (no cycles), and a fence
// that resolves its own subject through another module can be defeated by changing that module.
const K3_EXTERNAL_WRITE_TARGET_KIND = 'erp:k3-wise-webapi'

// Fixed, values-free operator-facing text. Identical at every layer so the four fences are
// indistinguishable in a response body — a caller must not be able to probe WHICH layer caught
// them and work inward.
const K3_EXTERNAL_WRITE_REFUSAL_MESSAGE =
  'K3 external write-back is permanently disabled; no flag, policy or approval can enable it'

// HTTP status for the refusal. 403, not 422: this is not a configuration the caller can fix.
const K3_EXTERNAL_WRITE_REFUSAL_STATUS = 403

function isK3ExternalWriteTargetKind(kind) {
  return kind === K3_EXTERNAL_WRITE_TARGET_KIND
}

// True when ANY of the identities a caller could present names K3. Deliberately OR-shaped and
// deliberately fed several independent sources at the call sites (the loaded target system's
// kind, the flattened planner target config's kind, the server-resolved write profile's kind):
// a bypass would have to launder K3 out of every one of them simultaneously.
function mentionsK3ExternalWriteTarget(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      if (isK3ExternalWriteTargetKind(candidate)) return true
      continue
    }
    if (candidate && typeof candidate === 'object' && isK3ExternalWriteTargetKind(candidate.kind)) return true
  }
  return false
}

// The refusal object, built by a caller-supplied constructor so each layer throws ITS OWN error
// type (HttpRouteError / ExternalWriteDryRunError / AdapterValidationError) and rides that
// layer's established mapping — while the token, message and status stay identical.
//
// `buildError` receives (status, code, message, details). A layer whose error type has a
// different arity adapts in its own one-line lambda; this module never learns those shapes.
function k3ExternalWritePermanentRefusal(buildError) {
  return buildError(
    K3_EXTERNAL_WRITE_REFUSAL_STATUS,
    K3_WISE_EXTERNAL_WRITE_DISABLED,
    K3_EXTERNAL_WRITE_REFUSAL_MESSAGE,
    { code: K3_WISE_EXTERNAL_WRITE_DISABLED, targetKind: K3_EXTERNAL_WRITE_TARGET_KIND },
  )
}

// Unconditional refusal: no subject, no predicate, no escape. Used at layers 3 and 4, where
// reaching the call site AT ALL is already the violation.
function refuseK3ExternalWritePermanently(buildError) {
  throw k3ExternalWritePermanentRefusal(buildError)
}

// Conditional refusal for layers 1 and 2, which also serve non-K3 targets.
function assertK3ExternalWriteRefused(buildError, ...candidates) {
  if (mentionsK3ExternalWriteTarget(...candidates)) {
    refuseK3ExternalWritePermanently(buildError)
  }
}

// The values-free marker a K3 C6 dry-run/preview carries so the plan a human reads cannot be
// mistaken for something that could later be applied. Frozen: nothing may add a field that
// varies with the plan, or the marker becomes a channel.
const K3_EXTERNAL_WRITE_APPLY_MARKER = Object.freeze({
  permanentlyRefused: true,
  refusalCode: K3_WISE_EXTERNAL_WRITE_DISABLED,
  authority: 'E4',
})

module.exports = {
  K3_EXTERNAL_WRITE_APPLY_MARKER,
  K3_EXTERNAL_WRITE_REFUSAL_MESSAGE,
  K3_EXTERNAL_WRITE_REFUSAL_STATUS,
  K3_EXTERNAL_WRITE_TARGET_KIND,
  K3_WISE_EXTERNAL_WRITE_DISABLED,
  assertK3ExternalWriteRefused,
  isK3ExternalWriteTargetKind,
  k3ExternalWritePermanentRefusal,
  mentionsK3ExternalWriteTarget,
  refuseK3ExternalWritePermanently,
}
