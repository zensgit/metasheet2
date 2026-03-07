export interface TimeoutDriver<T> {
  clear(id: T): void
  schedule(callback: () => void, delayMs: number): T
}

export function replaceCopyStatusResetTimer<T>(
  currentTimer: T | null,
  driver: TimeoutDriver<T>,
  onReset: () => void,
  delayMs: number,
) {
  if (currentTimer !== null) {
    driver.clear(currentTimer)
  }

  return driver.schedule(onReset, delayMs)
}

export function clearCopyStatusResetTimer<T>(
  currentTimer: T | null,
  driver: Pick<TimeoutDriver<T>, 'clear'>,
) {
  if (currentTimer !== null) {
    driver.clear(currentTimer)
  }

  return null
}
