import { ref } from 'vue'
import {
  fetchTeamAvailability,
  TeamAvailabilityFetchError,
  type TeamAvailabilityResponse,
} from '../../services/attendance/teamAvailability'

// #6 TA-3: load-and-clear state for the team-availability section. The clear-on-failure invariant is the
// acceptance criterion "403/404/failed query clears old data" — a stale group's table must never linger.
export function useTeamAvailability() {
  const data = ref<TeamAvailabilityResponse | null>(null)
  const loading = ref(false)
  const errorStatus = ref<number | null>(null)
  const errorMessage = ref<string | null>(null)

  async function load(groupId: string, from: string, to: string): Promise<void> {
    loading.value = true
    errorStatus.value = null
    errorMessage.value = null
    // Clear stale results at the START of a new load (owner review of #3095 §P2): while the request is in
    // flight, the section must NOT render the previous group's matrix under the new form values.
    data.value = null
    try {
      data.value = await fetchTeamAvailability({ groupId, from, to })
    } catch (e) {
      // CLEAR old results on any failure (403/404/network) — never show the previous group's table.
      data.value = null
      errorStatus.value = e instanceof TeamAvailabilityFetchError ? e.status : null
      errorMessage.value = e instanceof Error ? e.message : 'Failed to load team availability.'
    } finally {
      loading.value = false
    }
  }

  function reset(): void {
    data.value = null
    errorStatus.value = null
    errorMessage.value = null
  }

  return { data, loading, errorStatus, errorMessage, load, reset }
}
