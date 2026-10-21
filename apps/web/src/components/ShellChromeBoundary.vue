<template>
  <slot v-if="!failed" />
</template>

<script setup lang="ts">
// P1b round 2, item (3) — blast-radius isolation for optional app-shell chrome.
//
// WHY. `App.vue` renders the whole application shell. Anything mounted directly inside it that
// throws during setup takes the ENTIRE shell down — `apps/web/src/main.ts` installs no
// `app.config.errorHandler`, so the mount call itself rejects and the page renders nothing at all.
// That is an acceptable failure mode for the router outlet; it is not an acceptable one for an
// optional decoration such as a pending-count badge, whose worst honest outcome is "no badge".
//
// Verified behaviour, not assumed (see approvalNavTodoBadge.spec.ts, which mounts the real shell
// with a deliberately-throwing child and asserts both halves): a child's setup throw reaches this
// component's `onErrorCaptured`, which stops propagation, so the shell mounts; `failed` then flips
// and this boundary re-renders WITHOUT the slot, so the broken subtree is removed rather than left
// half-initialised. Without this wrapper the same throw leaves `container.innerHTML` empty.
//
// SCOPE. Deliberately narrow: it swallows errors only from what a caller explicitly wraps. It is
// not an app-wide handler and must never be placed around `<router-view>` — a page that fails to
// render must still surface, not disappear.
import { onErrorCaptured, ref } from 'vue'

const failed = ref(false)

onErrorCaptured(() => {
  failed.value = true
  // Stop propagation: the shell keeps rendering, and this boundary drops the failed subtree.
  return false
})

defineExpose({ failed })
</script>
