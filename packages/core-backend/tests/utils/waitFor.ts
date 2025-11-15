export async function waitForHealth(baseUrl: string, timeoutMs = 2000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: any
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`)
      if (res.ok) return
      lastErr = new Error(`Health returned ${res.status}`)
    } catch (e: any) {
      lastErr = e
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw lastErr || new Error('Health check timeout')
}