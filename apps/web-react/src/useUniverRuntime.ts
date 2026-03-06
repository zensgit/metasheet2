import { useEffect, useRef } from 'react'
import type { IWorkbookData } from '@univerjs/core'
import {
  createUniverRuntime,
  disposeUniverRuntime,
  renderWorkbook,
  type UniverRuntime,
} from './univerRuntime'

export const UNIVER_CONTAINER_ID = 'univer-container'

export function useUniverRuntime(workbookData: IWorkbookData) {
  const runtimeRef = useRef<UniverRuntime | null>(null)

  useEffect(() => {
    const container = document.getElementById(UNIVER_CONTAINER_ID)
    if (!container) {
      return undefined
    }

    const runtime = createUniverRuntime(container)
    runtimeRef.current = runtime

    return () => {
      if (runtimeRef.current) {
        disposeUniverRuntime(runtimeRef.current)
        runtimeRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!runtimeRef.current) return

    renderWorkbook(runtimeRef.current, workbookData)
  }, [workbookData])

  return {
    containerId: UNIVER_CONTAINER_ID,
  }
}
