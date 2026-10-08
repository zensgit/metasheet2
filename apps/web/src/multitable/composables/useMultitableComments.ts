// S3a (comments shared FE kit extraction): the real implementation moved to
// shared/comments/composables/useMultitableComments.ts, which now depends on the
// CommentsApiClient interface instead of the concrete MultitableApiClient class and takes its
// client as a REQUIRED parameter (no default). This file is the multitable-side adapter that
// restores the original external contract byte-for-byte: `useMultitableComments(client?)`,
// defaulting to the multitableClient singleton when the caller (MultitableWorkbench.vue, and the
// frozen multitable-comments.spec.ts) omits it or passes an explicit MultitableApiClient /
// partial stub.
import { useMultitableComments as useSharedMultitableComments } from '../../shared/comments/composables/useMultitableComments'
import { MultitableApiClient, multitableClient } from '../api/client'

export function useMultitableComments(client?: MultitableApiClient) {
  return useSharedMultitableComments(client ?? multitableClient)
}
