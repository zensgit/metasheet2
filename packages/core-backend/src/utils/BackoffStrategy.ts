export type BackoffType = 'fixed' | 'linear' | 'exponential'

export interface BackoffOptions {
  type: BackoffType
  initialDelay: number
  maxDelay?: number
  factor?: number // For exponential
  jitter?: boolean
}

export class BackoffStrategy {
  static calculate(attempt: number, options: BackoffOptions): number {
    let delay = 0

    switch (options.type) {
      case 'fixed':
        delay = options.initialDelay
        break
      case 'linear':
        delay = options.initialDelay * attempt
        break
      case 'exponential': {
        const factor = options.factor || 2
        delay = options.initialDelay * Math.pow(factor, attempt - 1)
        break
      }
    }

    if (options.maxDelay) {
      delay = Math.min(delay, options.maxDelay)
    }

    if (options.jitter) {
      // Add random jitter between 0 and 20% of delay
      const jitterAmount = delay * 0.2 * Math.random()
      delay = delay + jitterAmount
    }

    return Math.floor(delay)
  }
}
