import { computed, onMounted } from 'vue'
import { useSessionOrg } from './useSessionOrg'

/**
 * Session-org entry for the cloud-classroom pages (learner view, admin view, app-shell
 * installation section). Every /api/elearning* request answers 403 ORG_CONTEXT_REQUIRED while
 * the session carries no organization claim, which is the state a member of several
 * organizations starts in; without an in-page way to pick one they had to leave for the
 * attendance page.
 *
 * - ONE `useSessionOrg()` instance per page (see `SessionOrgHost` in SessionOrgSwitcher.vue:
 *   a second live instance is emptied by the first one's switch). Each host calls this once.
 * - Visible only for a member of more than one organization, mirroring the approval template
 *   center: a single-org member never sees a selector, and a member of none has nothing to
 *   choose (the 403 message tells them to contact an administrator instead).
 * - Re-mints the session claim only (`switchSessionOrg`); it writes no org id anywhere else.
 * - A successful switch reloads the page — the attendance precedent (`reloadAttendanceSession`):
 *   every section of these pages caches per-organization data, watch sessions and exam drafts,
 *   and a full reload is the one re-read that cannot leave any of them on the old organization.
 */
export const elearningSessionOrgPage = {
  /** Test seam: specs replace this; production reloads the document. */
  reload: (): void => {
    window.location.reload()
  },
}

export function useElearningSessionOrg() {
  const sessionOrg = useSessionOrg()
  const visible = computed(() => sessionOrg.hasMultipleOrgs.value)

  async function changeSessionOrg(orgId: string): Promise<void> {
    if (await sessionOrg.switchSessionOrg(orgId)) elearningSessionOrgPage.reload()
  }

  onMounted(() => {
    void sessionOrg.loadSessionOrgs()
  })

  return {
    visible,
    orgs: sessionOrg.orgs,
    selectedOrgId: sessionOrg.selectedOrgId,
    currentOrgId: sessionOrg.currentOrgId,
    loading: sessionOrg.loading,
    switching: sessionOrg.switching,
    errorMessage: sessionOrg.errorMessage,
    changeSessionOrg,
  }
}
