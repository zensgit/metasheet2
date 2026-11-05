// #6721 date matrix: record the order in which vitest actually ran the batch files
// (not the command-line order). Values-free: file path, timestamps, final state.
//   collectedAt   main-process time the file's collection was reported (always set,
//                 including files that failed to import)
//   runStartTime  the runner's own file-suite start time (null when the file never ran)
// Written to ATTENDANCE_DATE_MATRIX_ORDER_FILE on finish; no-op when it is unset.
import { writeFileSync } from 'node:fs'

type TaskLike = { filepath?: string; result?: { state?: string; startTime?: number } }

export default class AttendanceDateMatrixOrderReporter {
  private readonly collectedAt = new Map<string, number>()

  onCollected(files?: TaskLike[]): void {
    const at = Date.now()
    for (const file of files || []) {
      if (file.filepath && !this.collectedAt.has(file.filepath)) this.collectedAt.set(file.filepath, at)
    }
  }

  onFinished(files: TaskLike[] = []): void {
    const target = process.env.ATTENDANCE_DATE_MATRIX_ORDER_FILE
    if (!target) return
    const entries = files.filter(file => file.filepath).map(file => ({
      file: file.filepath as string,
      collectedAt: this.collectedAt.get(file.filepath as string) ?? null,
      runStartTime: Number.isFinite(file.result?.startTime) ? file.result?.startTime as number : null,
      state: file.result?.state ?? null,
    }))
    writeFileSync(target, JSON.stringify({ files: entries }, null, 2) + '\n')
  }
}
