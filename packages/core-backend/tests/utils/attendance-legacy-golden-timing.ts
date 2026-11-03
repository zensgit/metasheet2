export function assertLegacyGoldenCompletedJobTiming(job: Record<string, unknown>): void {
  const { elapsedMs, processedRows, throughputRowsPerSec } = job
  if (
    typeof elapsedMs !== 'number' || !Number.isInteger(elapsedMs) || elapsedMs < 0 ||
    typeof processedRows !== 'number' || !Number.isInteger(processedRows) || processedRows < 0 ||
    typeof throughputRowsPerSec !== 'number' || !Number.isFinite(throughputRowsPerSec) || throughputRowsPerSec < 0
  ) {
    throw new Error('LEGACY_GOLDEN_COMPLETED_TIMING_INVALID')
  }
  const expectedThroughput = elapsedMs > 0
    ? Number((processedRows / (elapsedMs / 1000)).toFixed(2))
    : 0
  if (throughputRowsPerSec !== expectedThroughput) {
    throw new Error('LEGACY_GOLDEN_COMPLETED_TIMING_INVALID')
  }
}
