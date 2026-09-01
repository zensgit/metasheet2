# Governed AI Service Boundary

_Design + consumer contract. 2026-09-01._

The **one place** every AI/LLM call is mediated. All AI features — the 列映射副驾
(schema-mapping copilot) and everything after it — call `GovernedAiService.suggest()`
and nothing else reaches a provider. The boundary, not the caller, chooses the
provider and enforces the platform's AI-safety rules in a single spot, then returns
a provenance-stamped, advisory-only envelope.

## Files

| File | Role |
| --- | --- |
| `packages/core-backend/src/services/governed-ai-service.ts` | The boundary + the consumer interface (`suggest()`). |
| `packages/core-backend/src/services/ai-routing-policy.ts` | Data-classification routing (the security core) + the deploy-file loader. |
| `packages/core-backend/tests/unit/governed-ai-service.test.ts` | Boundary end-to-end + fail-open + provenance + metering. |
| `packages/core-backend/tests/unit/ai-routing-policy.test.ts` | Routing decision + deploy-file validation (witnessed RED). |

## What it extends (does NOT duplicate)

The boundary reuses the existing multitable-AI wiring and adds a governance layer
around it:

- `resolveAiProviderReadiness(env)` — the existing **aiBlocked / readiness** gate
  (provider, model, caps).
- `AiProviderClient.complete()` — the existing provider call (anthropic + an
  **OpenAI-compatible** endpoint, key-in-headers, redaction, timeout). A self-hosted
  Qwen/DeepSeek is already reachable through this client via `MULTITABLE_AI_BASE_URL`.
- `redactString()` — the same unsafe-input scan the bulk path uses.

The boundary adds, in ONE place: the **data-class routing gate before the call**, and
the **provenance + citation envelope after it**. The heavy usage ledger / quota
(`ai-usage-ledger.ts`) stays where it is on the bulk path; the boundary exposes a
light metering seam instead.

## Consumer interface (build against this)

```ts
import { GovernedAiService } from '@metasheet/core-backend/src/services/governed-ai-service'

const ai = new GovernedAiService()          // reuses the env-configured provider
const res = await ai.suggest({
  feature: 'schema-mapping-copilot',        // for metering + audit
  dataClass: 'business',                    // 'business' | 'non-sensitive'; omitted → 'business'
  prompt: 'Suggest a column mapping for the source below.',
  grounding: [                              // optional; folded into the prompt, cited by [[id]]
    { id: 'col:7', label: 'Bom_ExAttr1', content: 'ACME-123, ...' },
  ],
  meterKey: 'tenant:acme',                  // optional accounting tag
})

if (res.available) {
  res.suggestion            // string — ALWAYS AI-generated, ADVISORY ONLY
  res.provenance            // { aiGenerated: true, advisory: true, providerTier, provider, model }
  res.citations             // [{ id, label?, referenced }]  — which sources were available/used
  res.usage                 // { promptTokens, completionTokens } | null
} else {
  res.reason                // machine token — TREAT AS "AI enhancement absent"
  res.message               // values-free hint
  res.provenance            // provider tier when known, else null
}
```

`suggest(request, env?)` is the **only** method. It is **advisory-only**: there is no
method that commits authoritative data or triggers a side-effect. It **never throws**
for an operational reason — readiness, routing, provider, or metering failures all come
back as `{ available: false, reason }`.

### `AiUnavailableReason` (stable contract)

| reason | meaning |
| --- | --- |
| `provider_not_ready` | Readiness ≠ ready (the aiBlocked condition). Fail-open. |
| `routing_policy_invalid` | The deploy-file is broken. Fail-closed route (no data sent), fail-open platform. |
| `business_data_cloud_forbidden` | Business data + a cloud-tier provider. **Refused; data never sent.** |
| `class_not_cloud_authorized` | The data class is not permitted on a cloud provider. |
| `unsafe_input` | The assembled prompt is secret-shaped; not sent. |
| `metered_out` | The metering hook declined the call. |
| `provider_error` | The provider call failed. |
| `internal_error` | Any unexpected fault — the boundary degraded instead of throwing. |

## The routing policy — how business data stays local

Data-class routing is **deploy-configured**, mirroring the outbound-write gate
(`plugins/plugin-integration-core/lib/outbound-http-write-gate.cjs`) and the host's
`readDeployJsonObjectFile`. The env var **`MULTITABLE_AI_ROUTING_POLICY`** points at a
server-side JSON file:

```jsonc
{
  "policyId": "acme-ai-routing",
  "policyVersion": 1,
  "activeProvider": { "tier": "local" },     // 'local' (self-hosted) | 'cloud'
  "cloudDataClasses": ["non-sensitive"]      // classes a CLOUD provider may serve; 'business' is refused at load
}
```

Three states, exactly like the write gate:

- **unset / blank** → `null`, the **most-restrictive default** (zero file I/O).
- **set + usable** → a frozen, validated policy.
- **set + unreadable / malformed / not-an-object / lists `business` in `cloudDataClasses`**
  → **throws** (a typo must be distinguishable from "unset"). The boundary catches the
  throw and returns `routing_policy_invalid` — no provider is ever called.

### The invariant (structurally enforced, fail-closed)

**Business-class data NEVER routes to a cloud provider.**

- `decideAiRoute(dataClass, tier, cloudDataClasses)` refuses `business` on a `cloud`
  tier as its **first branch**, before any allowlist is consulted — no allowlist can
  reach past it. An unknown/omitted class normalizes to `business` (most restrictive).
- The loader **refuses a policy that lists `business`** among the cloud classes — the
  one thing the gate forbids is not even expressible in config. (Defense in depth: even
  if the loader were bypassed, the router still refuses.)
- **Default-unset = local-only.** With no policy the configured provider keeps its
  built-in tier (anthropic / openai public endpoints = `cloud`), and no class is
  cloud-permitted → every request that would touch cloud is refused.
- **Fail-closed URL downgrade.** A provider **declared `local`** whose effective
  `MULTITABLE_AI_BASE_URL` is unset (→ the default public endpoint) or resolves to a
  known public cloud host (`api.anthropic.com`, `api.openai.com`) is treated as `cloud`.
  A mistaken `local` claim pointed at the public API can never launder business data
  off-prem. "Local" means an explicitly-set, non-public, self-hosted endpoint.

### To enable each mode

| Goal | Deployment does |
| --- | --- |
| Business AI (customer data) | Point `MULTITABLE_AI_BASE_URL` at the self-hosted endpoint **and** declare `activeProvider.tier = "local"`. |
| Non-sensitive AI on cloud | Leave the provider cloud; list `"non-sensitive"` in `cloudDataClasses`. |
| Nothing (safe default) | Leave `MULTITABLE_AI_ROUTING_POLICY` unset. |

## Provider selection (pluggable)

The provider is chosen by **config + policy, not the caller**. The `AiProviderClient`
interface already supports anthropic and any OpenAI-compatible endpoint; a self-hosted
model (Qwen / DeepSeek behind an OpenAI-compatible server) is selected with
`MULTITABLE_AI_PROVIDER=openai` + `MULTITABLE_AI_BASE_URL=<self-hosted>` + a `local`
policy declaration. Tests inject a fetch-spied client through the same construction
seam production uses — no real provider HTTP anywhere.

## Grounding / citations

`grounding: AiGroundingSource[]` is folded into the prompt with `[[id]]` markers (and a
"cite each fact by its `[[id]]`, do not invent numbers" instruction; per-source content
is char-capped). The response envelope carries `citations: { id, label?, referenced }[]`
— the supplied set is always echoed; `referenced` is a best-effort signal (the model's
output mentions the id/label) for the UI to show "based on these sources."

## Metering

Inject an `AiMeteringHook { admit?(ctx): boolean; record(event): void }`. `admit` gates a
call before any provider/policy work (rate/quota → `metered_out`); `record` gets every
outcome (`served` / `unavailable`). Both are best-effort — a throwing hook can never
break fail-open. `createInMemoryAiMeter({ maxCalls })` is a minimal counter for tests
and simple deployments; a real deployment supplies its own.

## Fail-open guarantee

The boundary is **not a hard dependency**. If no provider is ready, the route refuses,
the policy is broken, the metering hook declines, or anything throws, `suggest()` returns
`{ available: false, reason }` and the platform works fully without it. Callers treat
`available: false` as "AI enhancement absent" and proceed with their non-AI path.
