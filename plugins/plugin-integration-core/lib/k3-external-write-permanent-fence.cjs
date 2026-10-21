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
// BOTH K3 KINDS (parity, 20260901). G-4 bans "K3 external write-back", not "one K3 transport".
// The ban originally named only `erp:k3-wise-webapi`, so its SIBLING connector kind
// `erp:k3-wise-sqlserver` — a second, disjoint transport into the same customer K3 — sat outside
// it. That kind's own guard was materially weaker AND config-bypassable (an object config could
// set `allowDirectTableWrite: true` and walk past the middle-table rule), and what actually kept
// it shut in production was the DEFAULT injection of a read-only query executor. A doctrine held
// by a default is not a fence: swapping in a write-capable executor re-opened a K3 write without
// touching one character of this module. Both kinds are now subjects of the SAME ban, refused
// with the SAME closed token at four layers each:
//
//   layer  erp:k3-wise-webapi                        erp:k3-wise-sqlserver
//   -----  ----------------------------------------  ----------------------------------------
//     1    http-routes.cjs apply route               SAME call site — the kind predicate below
//                                                    now matches both, and a pipeline whose
//                                                    target system is the sqlserver kind is
//                                                    refused on the credential-stripped peek.
//     2    external-write-dry-run applyExternalWrite SAME call site — same widened predicate.
//     3    k3-wise-c6-write-profile.cjs writeRows     k3-wise-sqlserver-channel.cjs `upsert` —
//          (the C6 write-source facade)               unconditional, FIRST statement, before the
//                                                     table allowlist, the middle-table rule and
//                                                     any executor resolution.
//     4    k3-wise-webapi-adapter.cjs `upsert`,       the EXECUTOR SEAM — every injected
//          before `login()`                           `queryExecutor` is wrapped so `insertMany`
//                                                     refuses unconditionally. This is the layer
//                                                     that converts "safe because the default
//                                                     executor is read-only" into "safe whatever
//                                                     executor a deployment injects".
//
// Layer 4 for the sqlserver kind is deliberately at the seam a deployment CONTROLS, because that
// seam was the whole gap: the write capability arrived from outside this package.
//
// The runner gates are widened alongside, for the same reason and in the same act: both K3 kinds
// are now refused at `pipeline-runner.cjs` target resolution (the plain-run seam that reaches the
// one kind-generic `targetAdapter.upsert(...)` in this package) and at dead-letter replay. Those
// are pre-existing K3 gates that named only the WebAPI kind by literal; the sqlserver kind walked
// past both. They are refusals in their own right, not part of the four — a run refused there
// costs no adapter, no credential reload and no source read.

// The SQL Server transport writes through a driver, not a URL, so its refusal is a thrown error
// at the seam rather than a suppressed network call. Same token, same status, same absoluteness.
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

// The connector kinds the ban covers. Kept as their own literals rather than imported from the
// adapters or the C6 profile ON PURPOSE: this module must stay a leaf (no cycles), and a fence
// that resolves its own subject through another module can be defeated by changing that module.
//
// `K3_EXTERNAL_WRITE_TARGET_KIND` keeps naming the WebAPI kind and keeps its exact former value —
// it is the kind the wired C6 write profile resolves to, pinned by name elsewhere, and it stays
// the default `targetKind` reported in a refusal's details so no existing refusal shape moves.
const K3_EXTERNAL_WRITE_TARGET_KIND = 'erp:k3-wise-webapi'
const K3_EXTERNAL_WRITE_SQLSERVER_TARGET_KIND = 'erp:k3-wise-sqlserver'

// The closed subject set. Frozen: a runtime mutation of this array would be exactly the unlock
// §10.1 forbids, so it must not be possible even from inside this process.
const K3_EXTERNAL_WRITE_TARGET_KINDS = Object.freeze([
  K3_EXTERNAL_WRITE_TARGET_KIND,
  K3_EXTERNAL_WRITE_SQLSERVER_TARGET_KIND,
])

// Fixed, values-free operator-facing text. Identical at every layer so the four fences are
// indistinguishable in a response body — a caller must not be able to probe WHICH layer caught
// them and work inward.
const K3_EXTERNAL_WRITE_REFUSAL_MESSAGE =
  'K3 external write-back is permanently disabled; no flag, policy or approval can enable it'

// HTTP status for the refusal. 403, not 422: this is not a configuration the caller can fix.
const K3_EXTERNAL_WRITE_REFUSAL_STATUS = 403

function isK3ExternalWriteTargetKind(kind) {
  return kind === K3_EXTERNAL_WRITE_TARGET_KIND
    || kind === K3_EXTERNAL_WRITE_SQLSERVER_TARGET_KIND
}

// The matched kind, or null. Same OR-shaped walk as the boolean below; it exists so a refusal can
// report WHICH banned kind was presented instead of always reporting the WebAPI one. The caller
// already knows the kind it asked for, so this leaks nothing — it is the same class of structural
// identifier the C6 planner reports as expectedKind/actualKind.
function matchedK3ExternalWriteTargetKind(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      if (isK3ExternalWriteTargetKind(candidate)) return candidate
      continue
    }
    if (candidate && typeof candidate === 'object' && isK3ExternalWriteTargetKind(candidate.kind)) {
      return candidate.kind
    }
  }
  return null
}

// True when ANY of the identities a caller could present names K3. Deliberately OR-shaped and
// deliberately fed several independent sources at the call sites (the loaded target system's
// kind, the flattened planner target config's kind, the server-resolved write profile's kind):
// a bypass would have to launder K3 out of every one of them simultaneously.
function mentionsK3ExternalWriteTarget(...candidates) {
  return matchedK3ExternalWriteTargetKind(...candidates) !== null
}

// The refusal object, built by a caller-supplied constructor so each layer throws ITS OWN error
// type (HttpRouteError / ExternalWriteDryRunError / AdapterValidationError) and rides that
// layer's established mapping — while the token, message and status stay identical.
//
// `buildError` receives (status, code, message, details). A layer whose error type has a
// different arity adapts in its own one-line lambda; this module never learns those shapes.
//
// `targetKind` is OPTIONAL and is NOT a switch: it can only ever change which banned kind the
// details name. An unrecognised value — or none — falls back to the WebAPI kind, which is the
// exact string every refusal reported before the sqlserver kind joined the ban, so no existing
// refusal shape moves. It can never suppress the refusal, and it is validated against the closed
// subject set so a caller cannot inject a value of its own choosing into the details.
function k3ExternalWritePermanentRefusal(buildError, targetKind) {
  return buildError(
    K3_EXTERNAL_WRITE_REFUSAL_STATUS,
    K3_WISE_EXTERNAL_WRITE_DISABLED,
    K3_EXTERNAL_WRITE_REFUSAL_MESSAGE,
    {
      code: K3_WISE_EXTERNAL_WRITE_DISABLED,
      targetKind: isK3ExternalWriteTargetKind(targetKind) ? targetKind : K3_EXTERNAL_WRITE_TARGET_KIND,
    },
  )
}

// Unconditional refusal: no predicate, no escape. Used at layers 3 and 4 of BOTH kinds, where
// reaching the call site AT ALL is already the violation. The optional `targetKind` only labels
// the refusal; passing nothing, or anything outside the closed set, still refuses.
function refuseK3ExternalWritePermanently(buildError, targetKind) {
  throw k3ExternalWritePermanentRefusal(buildError, targetKind)
}

// Conditional refusal for layers 1 and 2, which also serve non-K3 targets. The kind that matched
// is what gets reported, so a sqlserver-target refusal names the sqlserver kind.
function assertK3ExternalWriteRefused(buildError, ...candidates) {
  const matched = matchedK3ExternalWriteTargetKind(...candidates)
  if (matched !== null) {
    refuseK3ExternalWritePermanently(buildError, matched)
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
  K3_EXTERNAL_WRITE_SQLSERVER_TARGET_KIND,
  K3_EXTERNAL_WRITE_TARGET_KIND,
  K3_EXTERNAL_WRITE_TARGET_KINDS,
  K3_WISE_EXTERNAL_WRITE_DISABLED,
  assertK3ExternalWriteRefused,
  isK3ExternalWriteTargetKind,
  k3ExternalWritePermanentRefusal,
  matchedK3ExternalWriteTargetKind,
  mentionsK3ExternalWriteTarget,
  refuseK3ExternalWritePermanently,
}
