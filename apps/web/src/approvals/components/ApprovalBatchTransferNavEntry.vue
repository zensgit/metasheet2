<template>
  <router-link
    v-if="capability === 'granted'"
    to="/approvals/batch-transfer"
    class="nav-link"
    data-testid="nav-approval-batch-transfer"
  >{{ label }}</router-link>
</template>

<script setup lang="ts">
// P1b round 2, item (1) — the 批量转交 nav entry, gated on the SERVER's approval-administrator
// capability rather than on the token-derived `getAccessSnapshot().isAdmin`.
//
// The two gates are not the same predicate: the token gate passes on a JWT `admin` role or any of
// `*:*` / `admin:all` / `users:write` / `roles:write` / `permissions:write`, while the approval
// list scope's admin arm requires `users.is_active AND (is_admin OR role = 'admin')` in the
// database. A principal admitted by the first but not the second reached the page and was shown
// another approver's queue as EMPTY. The nav entry is now conjunctive — the caller still renders
// this component only for a token-admin (so no ordinary user's shell issues the read at all), and
// this component renders the link only when the server's own predicate says yes.
//
// ANY answer other than `granted` hides the entry, INCLUDING `unavailable`: an entry that leads to
// a page which cannot confirm the caller's rights is worse than no entry. The page itself remains
// reachable by URL and states, there, which of the three answers it got.
//
// Round-4 item 2: the answer is held through `useApprovalAdminCapability`, which re-reads on an auth
// transition instead of resolving once at mount. This entry lives in the app shell, which is NOT
// remounted by every identity change (`bootstrapSession`'s 401 branch clears the token with no
// navigation at all), so a mount-only read left a `granted` link rendered for the principal that
// replaced the one it was resolved for.
import { useApprovalAdminCapability } from '../useApprovalAdminCapability'

defineProps<{ label: string }>()

const capability = useApprovalAdminCapability()

defineExpose({ capability })
</script>
