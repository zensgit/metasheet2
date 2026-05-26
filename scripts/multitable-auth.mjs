export async function resolveMultitableAuthToken({
  apiBase,
  envToken = process.env.AUTH_TOKEN || '',
  fetchJson,
  record = () => {},
  perms = '',
  userId = 'dev-admin',
  roles = 'admin',
  loginEmail = process.env.LOGIN_EMAIL || process.env.AUTH_EMAIL || '',
  loginPassword = process.env.LOGIN_PASSWORD || process.env.AUTH_PASSWORD || '',
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
  if (result?.res?.ok && token) {
    return token
  }

  const trimmedLoginEmail = String(loginEmail || '').trim()
  const trimmedLoginPassword = String(loginPassword || '').trim()
  if (trimmedLoginEmail && trimmedLoginPassword) {
    const loginUrl = `${apiBase}/api/auth/login`
    const loginResult = await fetchJson(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: trimmedLoginEmail,
        password: trimmedLoginPassword,
      }),
    })
    const loginToken = loginResult?.json?.data?.token || loginResult?.json?.token || ''
    record('api.login-token', Boolean(loginResult?.res?.ok && loginToken), {
      status: loginResult?.res?.status ?? 0,
      email: trimmedLoginEmail,
    })
    if (!loginResult?.res?.ok || !loginToken) {
      throw new Error('Login token unavailable')
    }
    return loginToken
  }

  throw new Error('Dev token unavailable')
}
