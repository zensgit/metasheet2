# Multitable Home Base Search Development - 2026-05-18

## Why This PR Exists

After `/multitable` became the primary table entry and gained template quickstart, the landing page still listed all accessible bases without a way to narrow the list. That is acceptable for a few bases, but it becomes noisy once users start using templates and data-factory generated bases.

This PR adds a local search filter to the "可访问的 Base" panel.

## Scope

In scope:

- Add a search input to the Base list panel when at least one Base is loaded.
- Filter visible Base cards by name or ID.
- Show matched count versus total count when a search query is active.
- Show a no-match empty state when the loaded list has bases but none match the query.
- Add focused frontend regression coverage.

Out of scope:

- No backend changes.
- No new API query parameter.
- No persistence of search state.
- No sorting, favorites, recent history, or pagination.
- No `/grid` or `/spreadsheets` behavior changes.

## Implementation

`MultitableHomeView.vue` now keeps:

```ts
const baseSearch = ref('')
```

and derives:

```ts
const filteredBases = computed(() => {
  const query = baseSearch.value.trim().toLowerCase()
  if (!query) return bases.value
  return bases.value.filter((base) => {
    return base.name.toLowerCase().includes(query) || base.id.toLowerCase().includes(query)
  })
})
```

The page renders `filteredBases` instead of `bases` and preserves the existing loaded `bases` array. Search is therefore UI-only and does not change API calls or loaded state.

The panel count behaves as follows:

- No search query: shows total base count.
- Search query active: shows `匹配 X / Y 个`.
- No match: shows `没有匹配的 Base。请调整搜索关键词。`

## Files Changed

- `apps/web/src/views/MultitableHomeView.vue`
- `apps/web/tests/multitable-home-view.spec.ts`
- `docs/development/multitable-home-base-search-development-20260518.md`
- `docs/development/multitable-home-base-search-verification-20260518.md`

## Risk Notes

- Filtering is local and case-insensitive.
- The loaded base list is not mutated.
- Existing open/create/template flows remain unchanged.
- The search field only renders when the user has at least one Base, avoiding an unnecessary control in the empty state.
