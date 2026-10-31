const assert = require('node:assert/strict')

async function main() {
  const base = 'http://backend:8900'
  const web = 'http://web'
  const json = async (url, options, status = 200) => {
    const r = await fetch(url, options)
    assert.equal(r.status, status)
    return status === 200 ? r.json() : null
  }
  const health = await json(base + '/health')
  assert.equal(health.build.commit, process.env.EXPECTED_REVISION)
  const build = await json(web + '/build-info.json')
  assert.equal(build.commit, process.env.EXPECTED_REVISION)
  const sessions = {}
  for (const id of ['candidate-admin', 'candidate-a', 'candidate-b']) {
    const login = await json(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: id, password: process.env.SYNTHETIC_PASSWORD }) })
    assert.equal(login.success, true)
    assert.equal(login.data.user.id, id)
    assert(login.data.token)
    sessions[id] = login.data.token
  }
  const auth = id => ({ headers: { Authorization: 'Bearer ' + sessions[id] } })
  for (const origin of [base, web]) {
    const list = await json(origin + '/api/admin/directory/integrations', auth('candidate-admin'))
    const items = list.data?.items || list.items
    assert.equal(items.length, 3)
    assert(items.every(i => i.syncEnabled === false))
    assert.equal(items.find(i => i.name === 'Synthetic E4').config.identityStatus, 'mismatch')
    assert.equal(items.find(i => i.name === 'Synthetic Canary').config.identityStatus, 'verified')
    assert.equal(items.find(i => i.name === 'Synthetic UAT').config.identityStatus, 'verified')
    await json(origin + '/api/admin/directory/integrations', auth('candidate-a'), 403)
    for (const [id, count] of [['candidate-a',5], ['candidate-b',4]]) {
      const todo = await json(origin + '/api/todo/items', auth(id))
      assert.equal(todo.items.length, count)
      assert(todo.items.every(i => i.actionable))
    }
  }
  console.log('QA_RESULT=' + JSON.stringify({ revision: build.commit, directAndProxiedDirectory: true,
    integrationCount: 3, mismatchPreserved: true, nonAdminDenied: true, passwordLoginUsers: 3, todoCounts: [5,4],
    adminToken: sessions['candidate-admin'] }))
  process.exit(0)
}
main().catch(() => { console.error('SYNTHETIC_RUNTIME_FAILED'); process.exit(1) })
