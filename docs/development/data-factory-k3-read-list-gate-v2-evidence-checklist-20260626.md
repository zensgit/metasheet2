# K3 read/list GATE v2 + reusable values-free evidence checklist (2026-06-26)

> Status: standardization, docs-only. Consolidates the C3+ unlock conditions (**GATE v2**) and a **reusable values-free evidence checklist** for read-smoke / read-run evidence. Opens no runtime — C3+ (LIST / BOM / resolver) stays frozen until the GATE below is met, and all writes stay frozen (first real write of any kind = a separate owner authorization). Supersedes the scattered C0 §5/§6 conditions by stating them as one GATE.
> Grounding: C0 design-lock #3242, C1 normalizer #3245, C2 wired #3246, C3 acceptance lock #3247; PoC GATE context #1792.

## Part A — K3 read/list GATE v2 (C3+ unlock conditions)

The read/list track is shipped through **C2**: single-record `Material/GetDetail` read-smoke, accepting both `{presetId, key}` and `{presetId, intent}` (normalized to one read), write-gated (`integration:write`), fail-closed before any credentialed call, values-free. Everything broader is **contract-only** until the GATE below is met. Each row is a **separate owner opt-in**; meeting the GATE authorizes only that row's runtime.

### Common GATE preconditions (every row)

```text
☐ named owner authorization for the specific slice (not a blanket "read/list" go)
☐ customer-supplied REDACTED request/response shape for the new surface (no real keys/values/credentials)
☐ the runtime slice has its own adversarial review + negative controls + a values-free entity-machine smoke
☐ the C3 acceptance lock holds: buildReadSmokeRequest consumes contract.object/mode (or dispatches by mode)
   before allowedObjects/allowedModes is widened (see C0 §7a / #3247)
☐ no write of any kind; credentials stay in backend/security context; evidence values-free (Part B)
```

### C3 — WebAPI LIST runtime

```text
GATE: customer GATE evidence explicitly requires WebAPI LIST RATHER THAN the existing SQL-Server read
      channel (which already does bulk read)
   +  redacted list request/response shape supplied
   +  pagination + filtering semantics known and BOUNDED (no broad/unbounded scan)
   +  LIST evidence is values-free (counts / coarse status only)
default until met: webApiList = defer_by_default   (consistent with #3224)
```

### C4 — BOM read runtime

```text
GATE: BOM-specific request/response + relationship semantics confirmed (redacted)
   +  its OWN slice — must not ride on a Material-detail PR
   +  values-free evidence
default until met: bom = locked
```

### C5 — resolver / server-side composition

```text
GATE: explicit owner unlock + a named demand
   +  the composition boundary (operator-in-the-loop vs server-side) re-confirmed
default until met: resolver/composition = locked
```

### Always frozen (NOT part of this read GATE)

```text
Save / Submit / Audit / production write / external write — a separate owner authorization (FOS-P4-style
gate), never bundled into a read GATE. A read GATE never authorizes a write.
```

## Part B — reusable values-free evidence checklist

Use for every read-smoke / read run (slice tests AND entity-machine reruns). Capture ONLY the allowed fields.

### Capture — allowed (bounded metadata only)

```text
presetId=<built-in preset id>      object=<allowlisted object>      mode=<allowlisted mode>
requestShape=<presetId+key | presetId+intent>
httpStatus=<coarse status>         apiOk=<true|false>
recordPresent=<true|false>         referenceObjectCount=<count>
errorCode=<coarse code only>       errorType=<coarse type only>
rawPayloadIncluded=false           saveSubmitAuditBomListExecuted=false       productionWriteExecuted=false
```

### Entity-machine context — when applicable

```text
persistedReadConfigPresent=<true|false>   (overlay path: false is expected)
backendRestarted=<true|false>             missingKeyGuard=fail_closed
writeUserDenied=403                        (operator-gate proof)
deployBundleFingerprintMatchesMain=<true|false>
```

### NEVER capture — forbidden

```text
material/BOM key; raw K3 request/response payload; host/tenant/token/authority code/cookie/password/
credential/SQL connection string; K3 business row values; stack traces carrying submitted values;
server-side credential store identifiers
```

### Sign-off line

```text
valuesFreeEvidence=true   noWriteExecuted=true   noListBomUnlessGated=true   slice=<C2|C3|C4|C5>
```

## Next (not now)

```text
- Step 2 (separate decision): consider abstracting Part A/B into a general "external-system read onboarding
  template" reusable beyond K3. Decide AFTER this lands; do not pre-build.
- C3 runtime: NOT built. Waits for the customer GATE (Part A · C3) to explicitly require WebAPI LIST.
```
