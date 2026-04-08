export async function resolveMultitableAuthToken({
  apiBase,
  envToken = process.env.AUTH_TOKEN || '',
  fetchJson,
  record = () => {},
  perms = '',
  userId = 'dev-admin',
  roles = 'admin',
}) {
  const trimmedToken = String(envToken || '').trim()
  if (trimmedToken) {
    record('api.auth-token', true, { source: 'AUTH_TOKEN' })
    return trimmedToken
  }

  const url = `${apiBase}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`
  const result = await fetchJson(url)
  const token = result?.json?.token || ''
  record('api.dev-token', Boolean(result?.res?.ok && token), {
    status: result?.res?.status ?? 0,
  })
  if (!result?.res?.ok || !token) {
    throw new Error('Dev token unavailable')
  }
  return token
}
