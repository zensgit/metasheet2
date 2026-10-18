import { computed, onMounted, ref } from 'vue'
import { useLocale } from './useLocale'
import { useSessionOrg } from './useSessionOrg'
import { elearningLabel } from '../views/elearningLabels'

/**
 * Session-org entry for the cloud-classroom pages (learner view, admin view, manual-grading
 * view, app-shell installation section). Every /api/elearning* request answers 403
 * ORG_CONTEXT_REQUIRED while the session carries no organization claim, which is the state a
 * member of several organizations starts in; without an in-page way to pick one they had to
 * leave for the attendance page.
 *
 * - ONE `useSessionOrg()` instance per page (see `SessionOrgHost` in SessionOrgSwitcher.vue:
 *   a second live instance is emptied by the first one's switch). Each host calls this once.
 * - Visible only for a member of more than one organization, mirroring the approval template
 *   center: a single-org member never sees a selector, and a member of none has nothing to
 *   choose (the 403 message tells them to contact an administrator instead).
 * - Re-mints the session claim only (`switchSessionOrg`); it writes no org id anywhere else.
 * - An accepted switch does NOT reload by itself. Like attendance (`AttendanceView.vue`'s
 *   `attendanceSessionStale` banner), the page is marked stale: its content is made inert and
 *   a banner offers 「放弃未保存内容并重新加载」. Every host can hold input the user has not
 *   saved yet (admin forms, exam answer drafts, practice answers, grading scores), so the
 *   discard is the user's decision, never automatic.
 */
export const elearningSessionOrgPage = {
  /** Test seam: specs replace this; production reloads the document. */
  reload: (): void => {
    window.location.reload()
  },
}

export function useElearningSessionOrg() {
  const { isZh } = useLocale()
  const sessionOrg = useSessionOrg()
  const visible = computed(() => sessionOrg.hasMultipleOrgs.value)
  const stale = ref(false)

  async function changeSessionOrg(orgId: string): Promise<void> {
    if (await sessionOrg.switchSessionOrg(orgId)) stale.value = true
  }

  function reloadPage(): void {
    elearningSessionOrgPage.reload()
  }

  /**
   * Display-time refinement of the org-context explanation. A member of exactly ONE active
   * organization only receives ORG_CONTEXT_REQUIRED when their token was minted before that
   * membership existed (the login-time claim is written only for exactly one membership); for
   * them "contact an administrator / choose above" is wrong, and signing in again is the fix.
   * Any other text passes through unchanged.
   */
  function explainOrgContext(text: string): string {
    if (sessionOrg.orgs.value.length !== 1) return text
    for (const zh of [true, false]) {
      if (text === elearningLabel('error.orgContextRequired', zh)) {
        return elearningLabel('error.orgContextStaleLogin', isZh.value)
      }
    }
    return text
  }

  onMounted(() => {
    void sessionOrg.loadSessionOrgs()
  })

  return {
    visible,
    stale,
    orgs: sessionOrg.orgs,
    selectedOrgId: sessionOrg.selectedOrgId,
    currentOrgId: sessionOrg.currentOrgId,
    loading: sessionOrg.loading,
    switching: sessionOrg.switching,
    errorMessage: sessionOrg.errorMessage,
    changeSessionOrg,
    reloadPage,
    explainOrgContext,
  }
}
