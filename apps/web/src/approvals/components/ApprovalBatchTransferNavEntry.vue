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
import { onMounted, ref } from 'vue'
import { resolveApprovalAdminCapability, type ApprovalAdminCapability } from '../adminCapability'

defineProps<{ label: string }>()

const capability = ref<ApprovalAdminCapability | 'pending'>('pending')

onMounted(async () => {
  try {
    capability.value = await resolveApprovalAdminCapability()
  } catch {
    // `resolveApprovalAdminCapability` already answers `unavailable` rather than rejecting; this
    // is the belt for a future change that lets a rejection escape. Nav chrome never throws.
    capability.value = 'unavailable'
  }
})

defineExpose({ capability })
</script>
