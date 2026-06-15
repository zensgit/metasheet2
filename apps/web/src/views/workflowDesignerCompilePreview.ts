import { ref } from 'vue'
import { compileWorkflowPreview, type WorkflowCompilePreview } from './workflowDesignerPersistence'

export type CompileWorkflowPreviewFetcher = (workflowId: string) => Promise<WorkflowCompilePreview>

/**
 * Read-only compile-preview state machine for the Workflow Designer.
 *
 * Guards against the stale-response overwrite race (rapid re-clicks, or a draft
 * switch/save in flight): each `run` captures a monotonic request id, clears the
 * previous result eagerly, and only writes result/error/loading when its id is
 * still the latest. A late response from a superseded request is dropped.
 *
 * The fetcher is injected for testability; it defaults to the real read-only
 * `compileWorkflowPreview` client (POSTs the A6-4b route, no writes).
 */
export function useWorkflowCompilePreview(
  fetcher: CompileWorkflowPreviewFetcher = compileWorkflowPreview,
) {
  const visible = ref(false)
  const loading = ref(false)
  const error = ref('')
  const result = ref<WorkflowCompilePreview | null>(null)
  let latestRequestId = 0

  async function run(workflowId: string): Promise<void> {
    const requestId = ++latestRequestId
    visible.value = true
    loading.value = true
    error.value = ''
    // Clear the previous result eagerly so a slow new request never shows stale data.
    result.value = null

    try {
      const preview = await fetcher(workflowId)
      if (requestId !== latestRequestId) return
      result.value = preview
    } catch (err) {
      if (requestId !== latestRequestId) return
      result.value = null
      error.value = err instanceof Error ? err.message : '编译预览失败'
    } finally {
      // Only the latest request owns the loading flag.
      if (requestId === latestRequestId) {
        loading.value = false
      }
    }
  }

  return { visible, loading, error, result, run }
}
