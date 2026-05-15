# Multitable Feishu Phase 3 — Lane A1 Ratification Table

- Date: 2026-05-15
- Author: Claude (Opus 4.7, 1M context), interactive harness; **read-only decision preparation, no code, no TODO Status change, no implementation PR**
- Status: **Landed as read-only decision packet; not ratified.** This table consolidates seven outstanding ratification items for Lane A1 into a single operator-markup matrix. Until each item receives an operator answer AND the K3 PoC stage-1 lock lifts, A1 cannot ship — irrespective of this document landing.
- Companion to: `/tmp/multitable-phase3-lane-a1-implementation-design-20260515.md` (A1 design draft, still in `/tmp/`, not committed to `docs/development/`).
- Scope: consolidate the seven outstanding ratification items from the A1 design draft §15 into a single decision table the operator can mark up.

## 1. Charter

The A1 design draft in `/tmp/multitable-phase3-lane-a1-implementation-design-20260515.md` carries proposed-but-not-ratified values across env names, RBAC posture, OpenAPI integration, response shape, provider allowlist, and default caps. Before A1 can become an implementation PR (which itself still needs K3 GATE PASS or `打破阶段一约束`), the operator must ratify each item.

(Line count of the design draft intentionally omitted here — the draft may continue to evolve in `/tmp/` as the operator's review surfaces more refinements; this ratification table tracks decision content, not draft size.)

This table consolidates them. **The macro gate (K3 lock) is a separate decision; this table does not propose lifting it.** Even if the operator ratifies every row below today, A1 still cannot ship until the macro gate lifts.

## 2. Ratification matrix

For each row: the operator either accepts the proposed value, proposes an alternative, or rejects the row (which usually means scoping A1 differently).

### 2.1 RBAC posture

| Item | Proposed value | Rationale | If operator rejects |
| --- | --- | --- | --- |
| R-1 | Reuse existing platform JWT middleware for all multitable routes (the same middleware that wraps `/api/multitable/sheets/:sheetId/automations/...`). | `routes/automation.ts` does NOT add an application-layer permission check; auth is platform-middleware-only. A1 should follow the same pattern. | Operator must say which middleware to use OR which new permission primitive to introduce. New permission primitives have to be designed before any A1 implementation. |
| R-2 | A1's route uses the existing admin flag (whatever `req.user.role === 'admin'` or equivalent is on `main`). Non-admin authenticated callers receive whatever fail-closed status that existing flag produces (401 or 403). | A1 surfaces operator-level config (AI provider state); rule authors don't need access until A2 lands. | Operator names a different RBAC tier (e.g. "everyone authenticated" — usually a bad idea for AI config). |
| R-3 | **A1 does NOT invent `automation.admin` or any other new permission primitive.** | If a fine-grained AI permission is later needed, that is an A2/A3 decision after live execution paths exist. | Operator wants A1 to introduce the primitive proactively — feasible but expands A1 scope and risks parameter creep. |

**Operator nod required**: yes / no / alternative.

### 2.2 OpenAPI integration

| Option | Implication | Recommended | If chosen |
| --- | --- | --- | --- |
| Option A — public API | Route is added to `packages/openapi/` source. `verify:multitable-openapi:parity` enforces parity at every PR. SDK consumers can call. | No (for A1) | Implementing PR includes OpenAPI source edits + regenerates `dist/openapi.{yaml,json}` + `dist-sdk/`. Parity check must pass. |
| Option B — internal route | Route is NOT added to OpenAPI source. Marked internal in the route file header. SDK consumers cannot call. Future migration to A would be a separate PR. | **Yes** | Implementing PR includes a one-line header comment citing this decision. No OpenAPI source edit. |

**Why B is recommended for A1**: readiness data is operational config, not product API. Keeping it out of the public SDK lets the shape evolve as A2/A3 close T1 / T3 / T6 without SDK consumer churn.

**Operator decision required**: A / B / defer.

### 2.3 Response shape

| Item | Proposed value | Rationale | If operator rejects |
| --- | --- | --- | --- |
| S-1 | Implementing PR surveys `main` for current precedent (list → envelope-with-array-key like `/logs` → `{ executions: [] }`; single object → flat like `/stats` → flat `AutomationStats`) and chooses to match. A1 returns a single object, so precedent suggests **flat**. | Don't invent new conventions. | Operator wants a specific shape (envelope) — implementing PR honors it but cites why it diverges from precedent. |
| S-2 | Decision is deferred to implementing PR, not committed in the design draft. | Avoids stale documentation if precedent changes between now and implementation. | Operator wants the design to commit now — feasible but the design would need to be revisited if precedent on `main` changes. |

**Operator decision required**: explicit shape (envelope / flat) OR "defer to implementing PR" (recommended).

### 2.4 Env-var names — 12 items become long-term contract

These names ship in `package.json` / docs / ops runbooks. Once shipped, renaming them needs migration. Operator must ratify each name or propose a rename now.

| Env var | Proposed name | Type / default | Purpose |
| --- | --- | --- | --- |
| E-1 | `MULTITABLE_AI_ENABLED` | bool, default unset → `disabled` | Top-level opt-in. |
| E-2 | `MULTITABLE_AI_PROVIDER` | string, allowlisted | Which provider (see §2.5). |
| E-3 | `MULTITABLE_AI_API_KEY` | string, always `<redacted>` in artifacts | Provider API key. |
| E-4 | `MULTITABLE_AI_BASE_URL` | string, optional | Custom endpoint (proxy / on-prem). |
| E-5 | `MULTITABLE_AI_MODEL` | string, allowlisted per provider | Default model id. |
| E-6 | `MULTITABLE_AI_REQUEST_TIMEOUT_MS` | int, default `15000`, min `1000`, max `60000` | Per-call wall-clock cap. |
| E-7 | `MULTITABLE_AI_MAX_OUTPUT_TOKENS` | int, default `1024`, min `64`, max `4096` | Per-call response length cap. |
| E-8 | `MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP` | int, default `100000`, min `1000` | Per-tenant daily token budget. |
| E-9 | `MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP` | int, default `500000` | Per-tenant weekly token budget. |
| E-10 | `MULTITABLE_AI_TENANT_BURST_RPM` | int, default `30` | Per-tenant rate limit, requests/min. |
| E-11 | `MULTITABLE_AI_ACCOUNT_DAILY_USD_CAP` | int (USD), default `10` | Account-level daily USD cap. |
| E-12 | `MULTITABLE_AI_CONFIRM_LIVE_REQUESTS` | bool, default unset | Second confirmation flag to allow real provider calls (mirrors `CONFIRM_SEND_EMAIL`). |

**Operator action**: for each of E-1 through E-12, mark accept / rename-to-X / drop.

### 2.5 Provider allowlist

| Item | Proposed value | Rationale | If operator rejects |
| --- | --- | --- | --- |
| P-1 | Allowlist `anthropic` + `openai`. Reject all other values in resolver — return `blocked`. | Two well-documented providers, clear key formats, both already covered by existing redactor `\bsk-[A-Za-z0-9_-]{20,}` rule. | Operator may want to add Azure OpenAI (`azure-openai`), AWS Bedrock (`bedrock-anthropic`), or restrict to one provider. Each addition needs key-shape redactor coverage check. |

**Operator action**: confirm 2-provider list, OR propose alternative list.

### 2.6 Default cap values

These are operator-tuneable via the corresponding env var, but the defaults ship in the resolver code. Once shipped, the defaults are the experience an operator sees on first deploy — they have to be sensible.

| Cap | Proposed default | Sanity-check | Risk if too low | Risk if too high |
| --- | --- | --- | --- | --- |
| Q-1 `tenantDailyTokenCap` | `100000` tokens | ~ $0.30-$1 / day per tenant on most providers; fits a small AI-feature trial. | Genuine workflow blocked early. | Customer trial costs us money before we realize. |
| Q-2 `tenantWeeklyTokenCap` | `500000` tokens | 5× daily; assumes some workdays use more than others. | Same as above amplified. | Cost ceiling per tenant is high. |
| Q-3 `tenantBurstRpm` | `30` requests/min | One request every two seconds, comfortable for human-triggered AI shortcuts. | UI feels laggy if user is doing a lot of bulk classification. | Easy DoS surface against the provider. |
| Q-4 `accountDailyUsdCap` | `$10` / day | Hard cost ceiling for the whole platform. | Account-wide service interruption when budget hit. | Hard surprise on a slow billing cycle. |

**Operator action**: accept each default or propose a different number. Note that A1 only **declares** these values; A2 ships the enforcement, so the numbers can be revisited at A2 time. But the env-var names (E-8 through E-11) are committed at A1 time.

### 2.7 T-blocker closure framing

| T-ID | A1's relationship | Closure responsibility |
| --- | --- | --- |
| T1 (cost ledger / rate-limit / budget) | A1 declares the shape. **Does NOT close T1.** | A2 ships ledger writer + cap enforcement; A3 ships display. All three must land. |
| T3 (SLO numbers) | A1 declares the numeric defaults and bounds. **Does NOT close T3.** | A2 / A3 honor them when they ship. |
| T6 (state enum) | A1 declares the full enum, emits only `disabled` / `blocked` / `ready`. Reserves `rate_limited` / `quota_exhausted` / `provider_error` / `unsafe_input` for A2. **Does NOT close T6.** | A2 derives the four reserved states. |
| T2, T4, T5, T7 | Not in A1 scope. | Other lanes. |

**Operator action**: confirm this framing matches expectation. (Especially important: confirm A1 does NOT claim to close T1 — earlier draft incorrectly framed this as "closes T1".)

## 3. Recommended operator decision template

Operator can mark up this matrix by replying inline:

```text
R-1: [accept | reject | alternative=...]
R-2: [accept | reject | alternative=...]
R-3: [accept | reject | alternative=...]
OpenAPI: [A | B | defer]
Response shape: [flat | envelope | defer-to-PR]
E-1..E-12: [accept all | rename E-N to ... | drop E-N]
P-1: [accept anthropic+openai | add azure | restrict to ... | other]
Q-1: [accept 100000 | =X]
Q-2: [accept 500000 | =X]
Q-3: [accept 30 | =X]
Q-4: [accept 10 USD | =X]
T-framing: [confirmed]
```

Once **all** items above receive an operator answer AND the macro gate lifts (K3 GATE PASS or `打破阶段一约束`), A1 can move from `/tmp/` design draft to a Lane A1 implementation PR. **Until both happen, A1 stays deferred.**

## 4. What this table did NOT do

- Did NOT modify any TODO Status line.
- Did NOT propose lifting the K3 lock.
- Did NOT propose an implementation PR.
- Did NOT touch real provider keys, real env config, or real customer data.
- Did NOT extend A1 scope into A2/A3 territory.

## 5. References

- `/tmp/multitable-phase3-lane-a1-implementation-design-20260515.md` §15 (gate items 5-10), §6 (env vars), §11 (RBAC + OpenAPI + response shape), §3 (T-blocker framing).
- `docs/development/multitable-phase3-unlock-checklist-20260515.md` §4.1 (A1 unlock row + the explicit caveat that the draft is NOT ratified).
- `docs/development/multitable-feishu-phase3-ai-hardening-review-20260514.md` (T1-T7 enumeration).
- `packages/core-backend/src/routes/automation.ts` (RBAC pattern A1 inherits from).
- `packages/openapi/tools/{build,diff,validate}.ts` (OpenAPI parity tooling A1's Option A would integrate with).
- `apps/web/src/multitable/utils/automation-log-redact.ts` + `scripts/ops/multitable-phase3-release-gate-redact.mjs` (existing `\bsk-` rule that already covers Anthropic / OpenAI key shapes).
