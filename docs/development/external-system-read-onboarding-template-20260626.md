# External-system read onboarding template (general) — 2026-06-26

> Status: standardization, docs-only. A reusable, **system-agnostic** playbook for safely onboarding a new external system's **READ** capability. Abstracted from the K3 read/list track (worked reference: C0 #3242 → C1 #3245 → C2 #3246 → C3 lock #3247 → GATE v2 #3257). It **deepens layer 3** (object/schema/read) of the 7-layer system-integration standardization template (`data-factory-system-integration-standardization-template-20260625.md`, #3213) — it does not replace it. Opens no runtime; every instance's stages are separate per-system opt-ins.

## 0. When to use

```text
USE   : onboarding a new external system's read (single-record first), or a new read object/mode on an
        existing system
DON'T : writes — read-first always; writes follow the write-gate layer / production-write discipline (FOS-P4
        style), never bundled into a read onboarding
```

## 1. Principles (invariants every read onboarding must hold)

```text
read-first           : a read slice contains no write capability
dormant/fail-closed  : the read runs only when explicitly enabled (default off); unknown inputs reject
preset/allowlist only: built-in presets define object/mode/read shape; the request supplies neither config nor raw access
backend credentials  : load via the credentialed backend path, never the public credential-stripped response
values-free evidence : counts / coarse codes only — never keys, values, credentials, or raw payloads
probe = operator     : an active credentialed probe returning an existence signal is an enumeration oracle →
                       gate it to integration-write/operator, not read
staged opt-in        : design-lock → contract → wire → broader surfaces, each a separate GATE
```

## 2. Onboarding ladder (generalized C0→C5)

| Stage | Scope | Runtime opened |
| --- | --- | --- |
| G0 | design-lock: contract / evidence / boundary for this system's read | None |
| G1 | contract normalizer + preset/allowlist metadata + tests | None |
| G2 | narrow single-record read-smoke, wired, dormant, operator-gated | single allowlisted read |
| G3 | list/bulk read runtime | only if the system GATE requires it (and no existing bulk channel suffices) |
| G4 | related/child-object read | own slice, own evidence |
| G5 | resolver / server-side composition | explicit owner unlock |

No stage combines contract definition with broad runtime expansion. No stage opens a write.

## 3. Contract shape (generalized)

```text
declarative + allowlisted:  { presetId, intent: { object, mode, key } }   (+ a compat subset if a simpler
                            shape shipped first, e.g. { presetId, key })
- presetId → built-in preset; object/mode → preset allowlist; key → runtime-only (never in evidence/docs/logs/PR)
- raw endpoint/path/method/headers/body/response/credential keys are PRESET- or GATE-owned, never request-owned
- a normalizer reconciles any compat subset with the forward shape → ONE output (no silent divergence)
```

## 4. System GATE (generalized Part A) — per broader read surface

Before any surface beyond the single-record read moves from contract to runtime, require:

```text
☐ named owner authorization for THAT specific surface (not a blanket "read" go)
☐ customer-supplied REDACTED request/response shape (no real keys/values/credentials)
☐ the surface's semantics known + BOUNDED (pagination/filtering for list; relationships for child-objects)
☐ a real need the existing channels don't already meet (e.g. a bulk/SQL channel may already cover list)
☐ the runtime slice has its own adversarial review + negative controls + a values-free entity-machine smoke
☐ no write of any kind; credentials stay in backend/security context
default until met: each broader surface = locked / defer-by-default
```

## 5. Values-free evidence checklist (generalized Part B)

```text
CAPTURE (allowed): presetId, object, mode, requestShape, httpStatus, apiOk, recordPresent,
                   relatedObjectCount, errorCode, errorType, rawPayloadIncluded=false,
                   writeExecuted=false, broaderSurfaceExecutedUnlessGated=false
ENTITY CONTEXT   : persistedReadConfigPresent, backendRestarted, missingKeyGuard=fail_closed,
                   writeUserDenied=403, deployBundleFingerprintMatchesMain
NEVER CAPTURE    : record/relationship key; raw request/response payload; host/tenant/token/authority/
                   cookie/password/credential/connection string; business row values; stack traces with
                   submitted values; server-side credential-store identifiers
SIGN-OFF         : valuesFreeEvidence=true  noWriteExecuted=true  noBroaderSurfaceUnlessGated=true  stage=<G2|G3|...>
```

## 6. Acceptance locks (generalized C1/C2/C3 locks)

```text
☐ request cannot supply raw config / credential / payload (strict key allowlist; prototype-key safe)
☐ unknown preset / object / mode fails closed BEFORE adapter creation
☐ missing/blank key fails closed BEFORE the external system is called
☐ evidence values-free on success, failure, AND validation-error paths
☐ the read-request builder consumes the NORMALIZED object/mode (not a hardcoded single-object shape) before
  any multi-object/mode widening
☐ no write path reachable from a read slice; the operator-gate holds for the credentialed probe
☐ a preset overlay (if used) is in-memory only — never mutates/persists the stored system role/config
```

## 7. Reference implementation (worked instance)

```text
K3 read/list track maps stage-for-stage:
  G0 = C0 design-lock        #3242
  G1 = C1 normalizer+metadata #3245
  G2 = C2 wired read-smoke    #3246  (+ C3 acceptance lock #3247)
  GATE/evidence              = GATE v2 + checklist #3257
Copy this shape for the next system; substitute the system's presets/objects/modes + GATE evidence.
```

## 8. Non-goals

```text
- No runtime in this template; each system's G0–G5 is a separate opt-in.
- No write onboarding (separate write-gate / production-write discipline).
- Not a replacement for the 7-layer system-integration template (#3213) — this deepens its read layer (3).
- Building a second system's read onboarding is a separate decision; this only records the reusable shape.
```
