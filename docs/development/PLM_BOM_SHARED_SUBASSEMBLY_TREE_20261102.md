# Shared subassembly BOM tree: static source delivery

Source commit: `751c553135d5ef1b5011751e08e5076697f833c8`. Parent: `5e3b23722cd3cd98470b6a86d4035123f03d4d6b`. This is a local child of the published Draft #6686 source. The source commit changes only `apps/web/src/views/plm/usePlmBomState.ts` and its existing `apps/web/tests/usePlmBomState.spec.ts`.

## Problem and resulting behavior

An ordinary BOM can use one subassembly through two different branches. At depth three or deeper, the Native tree response expands both occurrences. The Meta adapter flattens each occurrence and retains the same inner relationship ID and source parent on both copies. The frontend then grouped every copy under that parent and traversed the group again for each occurrence. For `ROOT → A → S → leaf` and `ROOT → B → S → leaf`, the six flat relationship records `RA, AS, L, RB, BS, L` therefore produced nine displayed tree rows instead of seven. The two copies of `L` also produced duplicate keys within each displayed path.

The collection step now keeps the first record for each nonempty real relationship ID within its exact parent bucket. It keeps the two displayed `S` paths, one `L` under each, and the original immediate edge quantity. Separate relationship IDs to the same child stay separate. Missing or empty real IDs retain their previous behavior. The flat input records, root deduplication, path/cycle/sort rules, filters and selection logic are unchanged. No quantities are summed or multiplied.

## Source evidence

The ordinary Native read chain was inspected at `7cb5acda84ce6b1c77ee2c6a5fdfb2b3bf99e0bf`: `bom_tree_router.py` lines270–340 delegates the authenticated read to `BOMService.get_tree`; `bom_service.py` lines220–254,283–379,1032–1066 expands each branch separately; `AMLEngine._filter_bom_tree_acl` lines178–236 preserves each readable occurrence. This was static inspection of the ordinary read path.

At the Meta parent, `PLMAdapter.getProductBOM` lines2730–2754 and its flatten functions lines4080–4141 retain the relationship ID, source parent and immediate quantity for every occurrence. `PlmProductView.vue` passes `result.items` to the state. The faulty collection and repeated traversal were in `usePlmBomState.ts` lines192–300.

## Implementation and authored regressions

The product change adds six lines in the parent-map collection block: a per-parent set of real IDs and the duplicate check. Removing those six inserted lines reconstructs the original product file exactly. Root integrated the Grok source bytes without a delta. The original full2407-byte test prefix remains exact, and five finite cases were appended: shared-path row/key/quantity preservation, distinct real IDs on one child, missing/empty IDs, equal IDs under separate parents, and delimiter-shaped IDs that must not collide.

The shared-path test expects seven rows, two `L` occurrences, distinct paths and quantity7. These are authored assertions and static expectations; no RED or GREEN test run is claimed. The cases do not exercise incoming branch quantities2/3 or compare every field of each flat record; opaque source preservation supports that unchanged behavior statically.

## Validation and limits

- `git diff --check`: PASS on the changed source.
- Independent static review: accepted with no known blocker; review SHA-256 `37c6f4c6e4aafbda97e8ed011618e361418be018b6f7429841e0baea9f99f997`.
- Frozen six-member coding capsule: SHA-256 `553cade99eb776c6ed3af707d6023c2e6b652912f2570b5f2c83b09bccbe51f1`,11417 bytes; each member hash/length and three readonly inputs verified.
- Product file:19541 bytes, SHA-256 `c47069d9615b700579f04471708b86cb5d4d714de9ee64bac1eea4501a6bddc3`. Test file:8313 bytes, SHA-256 `51100ca240693d49e09b28a3ea34b1405e87ae915ed69fc639f425636ca16f7b`.
- Grok requested4.7/medium; the observed CLI footer was4.7/xhigh. Backend deployment identity is UNKNOWN; the author report separately records actual effort UNKNOWN. Independent reviewer requested Sol6.1/high, actual model/effort UNKNOWN.
- Unit tests, type checks, lint, build, install, imports, HTTP/PG, browser and product runtime: **NOT_RUN for this source**. No retained old qualification was replayed. Draft #6686’s17 successful workflows qualify its earlier fixed head only.

This source and this single document are local commits. No push, new PR or new CI was performed or authorized for this increment. Further results belong in records or a future authorized PR body. A separate observed request-depth reconstruction issue remains a distinct pending static contract; this deduplication patch does not claim to resolve it. All seven delivery packages remain OPEN. N2 retention and every existing HOLD remain in effect; no merge, deployment, production enablement or business acceptance is implied.
