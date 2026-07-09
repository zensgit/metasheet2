# PLM x MetaSheet — Discussion Phase 3 Consumer — Slice-1 (READ-ONLY) Dev & Verification

Date: 2026-07-09
Branch: `feat/plm-discussion-read-consumer`

## 1. Scope

This is the metasheet2-side **consumer** half of the Yuantus Discussion Phase 3 integration,
staged per the Yuantus design-lock taskbook
`docs/development/plm-collab-discussion-phase3-metasheet-consumer-taskbook-20260709.md`
(Yuantus repo): **Slice-1 (1st impl) = READ-ONLY consumer**. It adds no PLM write channel and no
new Yuantus provider route — the routes it calls already ship on Yuantus main (Discussion Core
R1 + Phase-2 + Phase-6).

Two new `PLMAdapter` read methods:

- `getDiscussions(target, options?)` -> `GET /api/v1/discussions`
- `getDiscussionThread(threadId, options?)` -> `GET /api/v1/discussions/{thread_id}`

**Explicitly out of scope for this slice** (later slices per the taskbook):
`GET /discussions/my`, `GET /discussions/mentionable-users`, and every write route (`POST
/discussions`, `POST .../comments`, `PATCH/DELETE .../comments/{id}`, `resolve`/`reopen`). No
capability/SKU gating was added either — the provider routes are bearer-JWT + target-permission
gated only (not entitlement-gated), and the `discussion_core` capability-manifest key is a
separate, not-yet-ratified owner fork (taskbook §4 M1).

## 2. Provider surface consumed (read-only relevant, unchanged on Yuantus main)

Confirmed directly against `origin/main` of the Yuantus repo
(`src/yuantus/meta_engine/web/discussion_router.py`,
`src/yuantus/meta_engine/discussion/service.py`,
`src/yuantus/meta_engine/discussion/resolvers.py`):

```
GET /api/v1/discussions
    ?target_type={item|item_version|file|eco|pdm_relationship}
    &target_id={id}
    &include_resolved={bool, default false}
    &include_children={bool, default false — item targets only, Phase-6 one-level BOM-children aggregation}
    &limit={1..200, default 50}
    &cursor={opaque string}
  -> 200 {"threads": [ThreadSummary...], "next_cursor": string|null}
  -> 404 {"detail": "discussion target not found"}   (missing OR unreadable target — indistinguishable)

GET /api/v1/discussions/{thread_id}
    ?include_history={bool, default false — Phase-6 read-only lifecycle/version merge, item-backed only}
  -> 200 ThreadDetail = ThreadSummary + {"comments": [Comment...], "history"?: [...] }
  -> 404 {"detail": "discussion thread not found"}   (missing thread OR — via the same
                                                        _resolve_target re-check — an
                                                        unreadable target)
```

`ThreadSummary` (provider's `DiscussionService._thread_summary`):

```json
{
  "id": "string",
  "target_type": "string",
  "target_id": "string",
  "title": "string | null",
  "status": "string",
  "created_by_id": "number",
  "created_at": "ISO-8601 string",
  "resolved_by_id": "number | null",
  "resolved_at": "ISO-8601 string | null",
  "last_comment_at": "ISO-8601 string | null",
  "comment_count": "number",
  "anchor": "object | null"
}
```

`Comment` (provider's `DiscussionService._thread_detail`; soft-deleted comments are redacted at
the API surface — `body`/`anchor` -> `null`, `mentioned_user_ids` -> `[]`):

```json
{
  "id": "string",
  "parent_comment_id": "string | null",
  "body": "string | null",
  "body_format": "string",
  "author_user_id": "number",
  "mentioned_user_ids": "number[]",
  "created_at": "ISO-8601 string",
  "edited_at": "ISO-8601 string | null",
  "deleted_at": "ISO-8601 string | null",
  "anchor": "object | null"
}
```

Auth: `get_current_user` (bearer JWT) only — no `is_entitled` / capability check on these two read
routes. Permission is target-inherited via the discussion resolver registry (read = the target's
AML `get`, ECO delegates to `EcoAuthzGate`, `pdm_relationship` requires both ends readable). A
missing-or-unreadable target/thread is **deliberately indistinguishable** — always a plain 404,
never a 403 or a distinguishing error body, so the consumer cannot infer existence of something it
cannot read.

## 3. Consumer adapter changes

`packages/core-backend/src/data-adapters/PLMAdapter.ts`:

- New exported types: `DiscussionTargetType`, `DiscussionTarget`, `DiscussionListOptions`,
  `DiscussionThreadOptions`, `DiscussionThreadSummary`, `DiscussionThreadListResult`,
  `DiscussionComment`, `DiscussionThreadDetail`.
- `getDiscussions(target: DiscussionTarget, options?: DiscussionListOptions):
  Promise<QueryResult<DiscussionThreadListResult>>` — builds `target_type`/`target_id` plus the
  optional `include_resolved` / `include_children` / `limit` / `cursor` query params and calls
  `this.query('/api/v1/discussions', [params])`, mirroring the existing `getWhereUsed` /
  `getBomCompare` pattern (mock-mode branch, `apiMode !== 'yuantus'` branch, then a plain
  `this.query(...)` pass-through — no extra field remapping, since the provider envelope already
  matches the consumer type 1:1). **Note the query-param guards are truthy-only**
  (`` if (options?.includeResolved) params.include_resolved = ... ``), so `includeResolved: false`
  / `includeChildren: false` (or omitted) are never put on the wire — only `true` is. This matches
  the provider's own `false` defaults, so the two behave identically; the pact fixtures below
  reflect this (no `include_resolved` key on the wire when the caller didn't ask for resolved
  threads).
- `getDiscussionThread(threadId: string, options?: DiscussionThreadOptions):
  Promise<QueryResult<DiscussionThreadDetail>>` — same shape, calls
  `` this.query(`/api/v1/discussions/${threadId}`, [params]) ``.
- Both follow the adapter-wide error convention: the underlying `HTTPAdapter.query()` never
  throws on a non-2xx response — it returns `{data: [], error}` — so a 404 (missing/unreadable
  target or thread) surfaces as `result.error` (with `error.response.status === 404` on the real
  axios error), never a thrown exception. This mirrors how the rest of `PLMAdapter` treats
  provider errors and lets a degrading panel treat "no threads" and "target unreadable" the same
  way without probing which one happened.
- `'discussions'` added to `YUANTUS_SUPPORTED_OPERATIONS` (purely descriptive — `getRuntimeStatus()`
  advertises it under `apiMode='yuantus'`; not used for any gating anywhere in the codebase).
- Auth/tenant headers (`Authorization: Bearer <token>` via `getYuantusToken()`/`tokenProvider`,
  `x-tenant-id` / `x-org-id` from `connect()`) are unchanged — both new methods go through the same
  `this.query()` -> `HTTPAdapter` axios client as every other yuantus-mode read, so they inherit
  the existing bearer-token refresh-on-401 and header wiring with no new code.

## 4. Pact contract changes

`packages/core-backend/tests/contract/pacts/metasheet2-yuantus-plm.json`: 3 new interactions
inserted at the END of the adapter-owned interaction list (index 34, i.e. immediately before the
V1.2 parent-host embed-token mint interaction, which is index 34 in the 38-interaction baseline).
Total interaction count: **38 -> 41**.

| # | Description | Provider state | Method + Path | Status |
|---|---|---|---|---|
| 1 | `list discussion threads bound to a readable PLM target` | `tenant-1 can read item 01H000000000000000000000T1 and it has an open discussion thread 01H000000000000000000000T2` | `GET /api/v1/discussions` | 200 |
| 2 | `fetch a discussion thread and its comments, including the read-only history merge` | `tenant-1 can read discussion thread 01H000000000000000000000T2 on item 01H000000000000000000000T1 and it has one comment` | `GET /api/v1/discussions/01H000000000000000000000T2` | 200 |
| 3 | `list discussion threads for a missing or unreadable target returns the no-leak 404` | `item 01H000000000000000000000T9 does not exist, or tenant-1 cannot read it (indistinguishable no-leak target)` | `GET /api/v1/discussions` | 404 |

Fixture ids used (fresh, not reused from any other pact interaction): `01H000000000000000000000T1`
(target item), `01H000000000000000000000T2` (thread), `01H000000000000000000000T3` (comment),
`01H000000000000000000000T9` (missing/unreadable target).

### Interaction 1 — thread-list success

Request: `GET /api/v1/discussions`, query
`{target_type: ["item"], target_id: ["01H000000000000000000000T1"], limit: ["20"]}` (no
`include_resolved` key — the caller didn't request resolved threads, and the adapter's guard is
truthy-only so `false` is never put on the wire), headers `{Authorization: "Bearer ...",
x-tenant-id: "tenant-1"}`.

Response `200`:

```json
{
  "threads": [
    {
      "id": "01H000000000000000000000T2",
      "target_type": "item",
      "target_id": "01H000000000000000000000T1",
      "title": "Check tolerance on mounting hole",
      "status": "open",
      "created_by_id": 1,
      "created_at": "2026-07-09T00:00:00.000Z",
      "resolved_by_id": null,
      "resolved_at": null,
      "last_comment_at": "2026-07-09T00:05:00.000Z",
      "comment_count": 2,
      "anchor": null
    }
  ],
  "next_cursor": null
}
```

### Interaction 2 — thread-detail success

Request: `GET /api/v1/discussions/01H000000000000000000000T2`, query
`{include_history: ["true"]}`, same auth headers.

Response `200`: `ThreadSummary` fields for thread `T2` + `comments: [one Comment]` +
`history: [one lifecycle_transition entry]` (demonstrates the Phase-6 `include_history` merge is
wired through, even though this consumer slice treats `history` as an untyped passthrough —
`DiscussionThreadDetail.history?: Array<Record<string, unknown>>`).

### Interaction 3 — no-leak 404

Request: `GET /api/v1/discussions`, query
`{target_type: ["item"], target_id: ["01H000000000000000000000T9"], limit: ["20"]}`, same auth
headers.

Response `404`: `{"detail": "discussion target not found"}` — the exact string the Yuantus
`TargetNotFoundError("discussion target not found")` produces via FastAPI's default
`HTTPException` body.

### Drift guards updated

- `PLM_ADAPTER_PACT_PATHS` (`plm-adapter-yuantus.pact.test.ts`) gained 3 entries at the end:
  `GET /api/v1/discussions` (list success), `GET /api/v1/discussions/01H000000000000000000000T2`
  (detail success), `GET /api/v1/discussions` (404) — the index-by-index order test enforces they
  land at exactly this position in the JSON.
- The `endpointsToFind` source-grounding array gained `/api/v1/discussions` and
  `` /api/v1/discussions/${threadId} `` so the pact cannot silently drift from what
  `PLMAdapter.ts` actually calls.
- New dedicated test: `'Discussion Phase 3 slice-1: thread-list success, thread-detail success,
  and the no-leak 404 are locked'` — asserts the exact request query shapes, the `{threads,
  next_cursor}` envelope (NOT a bare array, unlike the ECO list endpoint), the comment envelope,
  and the exact 404 body.

## 5. Provider-states the Yuantus side needs to author

For the broker provider-verify gate to go green, `Yuantus/src/yuantus/api/tests/
test_pact_provider_yuantus_plm.py` needs fixture handlers for these 3 provider-state strings
(verbatim, so they match the copied pact JSON):

1. `tenant-1 can read item 01H000000000000000000000T1 and it has an open discussion thread
   01H000000000000000000000T2`
2. `tenant-1 can read discussion thread 01H000000000000000000000T2 on item
   01H000000000000000000000T1 and it has one comment`
3. `item 01H000000000000000000000T9 does not exist, or tenant-1 cannot read it (indistinguishable
   no-leak target)`

States 1 and 2 can most likely share one fixture (seed item `T1` + thread `T2` + one comment on
`T2`, readable by `tenant-1`); state 3 seeds nothing for `T9` (or seeds it in a different tenant),
so the resolver's `TargetNotFoundError` fires naturally. This mirrors the Wave 4 doc's "no-op
provider-state handler, deterministic via distinct seeded fixtures" pattern.

## 6. Test results

Ran from `packages/core-backend/` (`pnpm install --frozen-lockfile` at the workspace root first;
did not mutate the lockfile):

```bash
npx vitest run tests/contract/plm-adapter-yuantus.pact.test.ts tests/unit/plm-adapter-yuantus.test.ts
```

Result: **2 test files passed, 48 tests passed** (43 pre-existing + 1 new pact assertion test +
5 new adapter unit tests, `omits optional list params`/`omits include_history` count as 2 of the
5).

```bash
npx vitest run tests/contract --reporter=dot
```

Result: **2 test files passed, 23 tests passed**.

```bash
npx tsc --noEmit -p .
```

Result: exit code 0, no type errors.

```bash
npx vitest run tests/unit --reporter=dot
```

Result: **337 test files passed, 4520 tests passed** (full `core-backend` unit suite — confirms
the `YUANTUS_SUPPORTED_OPERATIONS` addition and the new types did not regress any other adapter
or federation test).

## 7. Files changed

- `packages/core-backend/src/data-adapters/PLMAdapter.ts`
- `packages/core-backend/tests/contract/pacts/metasheet2-yuantus-plm.json`
- `packages/core-backend/tests/contract/plm-adapter-yuantus.pact.test.ts`
- `packages/core-backend/tests/contract/README.md`
- `packages/core-backend/tests/unit/plm-adapter-yuantus.test.ts`
- `docs/development/plm-yuantus-discussion-phase3-read-consumer-slice1-20260709.md` (this file)

## 8. Deferred to later slices

- `GET /api/v1/discussions/my` (caller-scoped: created/commented/mentioned)
- `GET /api/v1/discussions/mentionable-users` (mention-picker lookup)
- `POST /api/v1/discussions` (create thread)
- `POST /api/v1/discussions/{thread_id}/comments` (add comment)
- `PATCH /api/v1/discussions/{thread_id}/comments/{comment_id}` (edit comment)
- `DELETE /api/v1/discussions/{thread_id}/comments/{comment_id}` (soft-delete comment)
- `POST /api/v1/discussions/{thread_id}/resolve` / `.../reopen`
- Consumer UI panel wiring (threads rendered in BOM Review) — this taskbook slice is
  adapter+pact only, per the "Build + verify locally" scope; no panel/route wiring was requested
  or added.
- Capability-manifest `discussion_core` entry (owner fork M1, not ratified) — no
  `getIntegrationCapabilities()` change was made.
- The write-session-credential design (taskbook §5) — required before any write-capable slice.
