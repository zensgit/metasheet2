# PLM Discussion Consumer taskbook (federation scope lock, 2026-07-09)

> **Type:** development taskbook / scope lock, doc-only. Does not authorize
> implementation by itself.
>
> **Provider status:** Yuantus Discussion Core R1 is LIVE on yuantus-plm main
> (PR #1146, squash `2f0320c1`): threads / one-level replies / explicit
> mentions / resolve-reopen with target-inherited permissions, plus the
> Phase-2 slice-1 follow-on (#1147: My Discussions, mentionable-users lookup,
> comment edit / soft delete) and the **Phase-6 slice-1 read projections
> (#1149: `include_history` domain-timeline merge; `include_children`
> BOM-children aggregation, scoped to the WP1.2 product-structure vocabulary —
> ASSEMBLY ∩ `is_current=True`)**. Program roadmap: yuantus-plm
> `docs/development/plm-collab-discussion-visual-collaboration-roadmap-20260709.md`
> (§4.4 federation hard locks, §11.2 consumer coverage list — this document is
> that deliverable).
>
> **Split:** this taskbook is the CONSUMER-side canonical (ms2 adapter / UI /
> downgrade / pact consumer interactions). The PROVIDER-side Phase 3 lock
> (capability manifest, pact provider states, provider-first sequencing, the
> write-credential design gate) lives in yuantus-plm PR #1153's taskbook —
> complementary documents, not competing ones.

## 1. Scope

Phase 3 of the discussion program, in the roadmap's locked order:

- **C1 (first implementation PR): read-only provider.** Display target-bound
  Yuantus discussion threads inside PLM projection surfaces (BOM Review
  first). No writes.
- **C2: write provider.** Create thread / reply / resolve / reopen from the
  embedded surface — gated on the write-session credential design (§4).
- **C3: review enhancements.** Row/cell anchors, unresolved filters,
  stale-drawing and release-readiness context columns.
- **Out of scope:** inbox federation (L2), federation read API (L3), viewer
  markup, external collaborators, any change to MetaSheet's native comment
  system.

## 2. Federation boundary (hard locks, non-negotiable)

1. PLM object discussions are stored ONLY in Yuantus. MetaSheet native
   `meta_comments` never stores a PLM projection comment; the provider is a
   distinct data path from the native comment store.
2. Any cache/shadow index (e.g. unread counts) must be rebuildable and must
   never become the authority.
3. Yuantus 401/403/404/422 responses are authoritative; MetaSheet UI checks
   are advisory affordances only.
4. Rule of thumb: **"survives the sheet ⇒ lives in PLM."** Projection sheets
   are disposable; anything reviewers must find later goes through the
   provider to Yuantus.

## 3. Provider contract (C1)

```ts
interface PlmDiscussionProvider {
  listThreads(scope: PlmDiscussionScope): Promise<ThreadList>   // limit / cursor / include_resolved
  getThread(threadId: string): Promise<ThreadDetail>
  searchMentionableUsers(q: string): Promise<MentionableUser[]> // provider-side, id+username only
  // C2 only:
  createThread(scope, input: CreateThreadInput): Promise<ThreadDetail>
  addComment(threadId, input: AddCommentInput): Promise<ThreadDetail>
  resolveThread(threadId, input?: TransitionInput): Promise<ThreadDetail>   // comment? + mentioned_user_ids?
  reopenThread(threadId, input?: TransitionInput): Promise<ThreadDetail>
  editComment(threadId, commentId, body): Promise<ThreadDetail>
  deleteComment(threadId, commentId): Promise<ThreadDetail>     // soft delete; body renders null
}
```

- `PlmDiscussionScope` = `{target_type, target_id}` with **PLM ids only**
  (`pdm_relationship` line item id, `eco` id, `item_version` id).
- Default review targets: **`eco`** (change review) or **`item_version`**
  (release review) — never bare `item`, so resolved threads do not drift onto
  later revisions.
- Anchors: single `anchor` JSON with `kind` discriminator, passed opaquely.
  `metasheet_cell` anchors MUST resolve to the PLM target via PLM ids alone
  (`row_key` = relationship/item id); `base/sheet/view` ids are display hints
  only — anchors must survive a projection rebuild (test-pinned, §8).
- Deleted comments arrive with `body: null` + `deleted_at` set — render a
  tombstone, never hide the row (reply threading depends on it).

## 4. Identity, tokens, and the write channel (C2 gate)

1. **Never reuse the embed token for writes.** It is TTL-capped (600s) and
   jti-AUDITED — single-use enforcement is NOT an implemented property of the
   shipped pattern (yuantus-plm #1148 review note [M]); it must never carry
   write authority regardless. C2 requires exchanging a valid embed context
   for a Yuantus-issued, discussion-scoped session credential (dedicated
   `aud`, target-scoped, refreshable) following the existing embed-token
   audience pattern — the mint endpoint is a Yuantus-side contract addition
   (provider taskbook, PR #1153 lane) and must be taskbooked there before C2
   starts.
2. **Identity mapping is explicit.** `mentioned_user_ids` are Yuantus
   identity user ids; MetaSheet user ids are never assumed equal.
3. Mention picker uses the provider's `GET /api/v1/discussions/
   mentionable-users` (tenant-safe, id+username only) — no client-side
   identity caching or scraping.

## 5. Notifications

- Cross-system dedup key = the Yuantus outbox occurrence nonce
  (`payload.event_id`) carried on the webhook. When MetaSheet renders a
  Yuantus-sourced discussion event it must suppress its own native alert for
  the same key — one business event, one user-visible alert (test-pinned).
- C1 ships with polling (`last_comment_at` keyset cursor); realtime is an
  enhancement, not a correctness requirement.

## 6. Entitlement and downgrade

- Gate: capability manifest feature key `metasheet_review` / SKU
  `plm.metasheet_review` (`{supported, entitled}` pair from the Yuantus
  manifest). The `discussion_core` manifest question (M1) is decided in this
  lane — options: not exposed / base-included semantics / ratified SKU.
- Graceful downgrade: unentitled or unsupported → discussion affordances
  absent, zero broken UI; discussion data remains in Yuantus and stays
  readable on PLM surfaces ("data outlives the add-on") — assert both in the
  downgrade tests.

## 7. Pact sequencing

- The Yuantus provider routes are NOW live on yuantus-plm main, so the
  previous hold ("no discussion interactions on metasheet2 main before the
  provider exists") is lifted **for the R1+Phase-2 route set**.
- Consumer pact publishes only on push to main; the broker gate on Yuantus
  main is blocking. Land pact interactions and their provider verification in
  the same window; respect `can-i-deploy` in both directions.
- C1 interactions: list threads (cursor paging + 401/403/404 shapes), thread
  detail, mentionable-users. C2 adds create/comment/resolve/reopen/edit/
  delete (+422 shapes: unknown target type, empty body, reply-to-reply,
  transition mentions without comment, edit-of-deleted).

## 8. Verification plan

- Provider unit tests against the recorded Yuantus response shapes (thread /
  comment key sets, `body_format: plain_text`, `mentioned_user_ids`,
  deleted-comment tombstone).
- Downgrade tests (unsupported / unentitled / provider 403) incl. the
  data-outlives-the-add-on assertion.
- Anchor round-trip: rebuild the projection sheet, re-resolve the same
  anchors via PLM ids.
- Notification dedup: one synthetic `event_id` → exactly one user-visible
  alert.
- Pact: consumer tests generate the interactions; provider verification green
  before main.

## 9. Open decisions for owner

1. C1 surface: BOM Review only, or also the generic embed shell.
2. Mentions in C1 (read-only surfaces show them; creating them is C2) — defer
   the picker entirely to C2?
3. Unread-count shadow index in C1 or defer to L2 inbox federation.
4. M1 manifest semantics for `discussion_core` (see §6).
