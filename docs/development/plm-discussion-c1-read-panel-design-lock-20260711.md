# PLM Discussion C1 — read-only discussion panel · MINI DESIGN LOCK (PROPOSED)

- **Status**: **PROPOSED — doc-only, zero runtime. Owner ratification required before ANY implementation.**
  This resolves the four open decisions in `plm-discussion-consumer-taskbook-20260709.md` §9 and adds a
  constraint that taskbook did not account for (§1 below), which materially changes C1's shape.
- **Unlock word**: owner ratifies §4's decisions (or overrides them).
- **Difficulty/dispatch**: C1-a = S/M (one server-side fold + one read-only panel) → Sonnet 5 + adversarial review.

## §1 The decisive constraint the C1 taskbook did not account for: the token budget

**The embed token authorizes exactly ONE call.** Verified on `origin/main`:

- `routes/plm-embed.ts:103-110` — the token's `jti` is **atomically consumed BEFORE the query**:
  *"Single-use: atomically consume the token's jti against the SHARED store BEFORE querying, so a replay
  of a still-valid token cannot fetch data a second time."* A missing jti ⇒ 401; the store being
  unavailable **fails closed** (503).
- `PlmEmbedBomReviewView.vue:119` — the child accepts the **first** valid token and ignores the rest;
  it is **LISTEN-only** (`grep` for outbound `postMessage` ⇒ **0 calls**; :59 even notes a pinned-origin
  var *"kept for any future outbound use (none today)"*).
- The parent (`plm_workspace.html`) mints **one** token per mount and posts it one-way.

⇒ **One mount = one token = one authenticated call = one payload.** There is no way for the child to
obtain a second token today. That is precisely the gap the child→parent on-demand token protocol
(`plm-collab-discussion-phase3-write-ui-token-protocol-taskbook-20260711.md`, RATIFIED) exists to close —
and whose *implementation* is gated on the Option A merge sequence (P1-a → provider-pact → #4110 → #4113).

**Consequence (the point of this lock):** C1 is independent of the write **credential** (no
session-exchange, no `DISCUSSION_SESSION_ENABLED`) — but it is **NOT** independent of the token **supply**.
Any C1 shape that needs a second call (thread-detail-on-click, "load more", refresh) inherits the *same*
blocker as the write path. This splits C1 in two (§3).

## §2 What is already built (and currently dead)

- `PLMAdapter.getDiscussions()` / `getDiscussionThread()` (`PLMAdapter.ts:2433-2501`) — READ-ONLY, call the
  provider's existing `GET /api/v1/discussions[/…]`; a missing/unreadable target returns the provider's
  indistinguishable 404 as `result.error`, **never throws**.
- Pact-verified: `tests/contract/pacts/metasheet2-yuantus-plm.json` carries these interactions (41 total).
- `isFeatureAvailable` (`PLMAdapter.ts:681`, from #4020) — the capability-availability formula.
- **Zero callers.** `git grep` finds no route and no UI consuming either method. This code is **merged but
  dead** on main; C1 is what wires it.

## §3 The fork the token budget forces

| | **C1-a — bounded, one-payload (UNGATED)** | **C1-b — interactive (GATED)** |
|---|---|---|
| Shape | Fold a **bounded first page** of threads into the **existing** `GET /api/plm-embed/bom-review/context` response — the call the child already makes with its one token. | Thread-detail-on-click, pagination/"load more", refresh — each is an **additional** authenticated call. |
| Token cost | **Zero extra.** No new endpoint, no protocol change. | **One extra token per interaction** ⇒ requires the child→parent on-demand token protocol. |
| Gate | **None** — touches only already-merged read-path code. Buildable the moment §4 is ratified. | **Blocked** on the same sequence as the write-UI (P1-a → provider-pact → #4110 → #4113), because it needs the same token protocol. |

**Headline:** the on-demand token protocol is the **single unlock for the entire discussion surface** —
the interactive half of the *read* panel and the whole *write* path share one blocker. C1-b should not be
scoped as separate work; it is a rider on the write-UI's token-protocol implementation.

## §4 The four §9 open decisions — RESOLVED (proposed)

1. **C1 surface: BOM Review only, or also the generic embed shell?**
   → **Recommend: BOM Review only.** The generic embed shell has no part context to bind a
   `DiscussionTarget` to, and widening the surface widens the cross-origin embed's blast radius for zero
   present demand. Revisit when a second embed host actually exists (demand gate).
2. **Mentions in C1 (read-only) — or defer entirely to C2?**
   → **Recommend: render mentions read-only if the payload carries them; the picker is C2.** Rendering an
   already-present mention is display, not a new capability; *creating* one is a write (C2). If the
   provider payload does not carry resolved display names, render the raw handle rather than adding a
   second call to resolve them (token budget, §1).
3. **Unread-count shadow index in C1, or defer to L2 inbox federation?**
   → **Recommend: DEFER to L2.** An unread count is per-user state that must be *maintained* (read
   receipts ⇒ writes) and would want polling/refresh ⇒ extra calls ⇒ extra tokens (§1). It is structurally
   an L2 inbox-federation concern, not a C1 read panel concern.
4. **M1 manifest semantics for `discussion_core`.**
   → **ALREADY RESOLVED — close it.** #4020 landed `isFeatureAvailable` (`PLMAdapter.ts:681`) with
   `discussion_core: packaging=base`. This decision is stale in the taskbook; no owner action needed.

## §5 Proposed C1-a scope (only if §4 is ratified)

- **Server**: in `routes/plm-embed.ts`'s context handler, after the existing `getBomMultitableContext`,
  additionally call `adapter.getDiscussions(target)` for the SAME part and return the threads in the SAME
  payload — under the SAME already-consumed jti (no second token). **Bounded** page size (no unbounded
  fan-out into a cross-origin payload).
- **Degrade parity (non-negotiable)**: the discussion fetch must inherit the context route's contract —
  a provider error/absence degrades to `discussions: null, reason` and **never 500s** and never fails the
  BOM context. A discussion outage must not take the BOM review down.
- **Entitlement/masking**: reuse the route's existing chain verbatim (feature_key → origin allowlist →
  server-configured data source → tenant cross-check → single-use jti). C1 adds **no** new auth surface.
- **FE**: a read-only thread list in `PlmEmbedBomReviewView.vue`, rendered from the mount payload. **No**
  outbound postMessage (the page stays LISTEN-only — C1-a must NOT be the thing that breaks that
  invariant; the outbound channel is the token protocol's to introduce, under its own security review).
- **Tests**: extend `plm-embed-routes.test.ts` (degrade path, entitlement, no-extra-jti-consumption) and
  the FE specs — both now actually run in CI via the `plm-embed-web-guard` added in #4136.

## §6 Out of scope / gates (honest)

- **C1-b (interactive reads)** — gated, and a rider on the token protocol (§3). Do not scope separately.
- **C2 (writes: create/comment/resolve/reopen)** — the whole Option A write line; gated.
- The **auth/embed layer** (`embed-jti-store.ts`, `embed-config.ts`, `embed-token-auth.ts`) is **not
  touched** by C1-a and remains an owner-gated red line.
- This document authorizes **nothing** until the owner ratifies §4.
