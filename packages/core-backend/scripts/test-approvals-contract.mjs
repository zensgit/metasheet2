#!/usr/bin/env node

/**
 * Approvals API Contract Tests
 *
 * Tests HTTP status codes, approval_records field validation, and transaction semantics
 *
 * Usage:
 *   DATABASE_URL=<connection-string> JWT_SECRET=<secret> API_ORIGIN=http://localhost:8900 node test-approvals-contract.mjs
 *
 * Exit codes:
 *   0: All tests passed
 *   1: One or more tests failed
 */

import pg from 'pg'
const { Pool } = pg

const BASE_URL = process.env.API_ORIGIN || 'http://localhost:8900'
const DATABASE_URL = process.env.DATABASE_URL
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret'

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable required')
  process.exit(1)
}

const pool = new Pool({ connectionString: DATABASE_URL })

let testsPassed = 0
let testsFailed = 0
const failures = []

/**
 * Generate a dev JWT token
 */
async function generateToken(userId = '00000000-0000-0000-0000-000000000001', roles = ['admin']) {
  // Simple JWT generation for testing
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    id: userId,
    roles,
    perms: [],
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 7200 // 2 hours
  })).toString('base64url')

  const { createHmac } = await import('crypto')
  const signature = createHmac('sha256', JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url')

  return `${header}.${payload}.${signature}`
}

/**
 * Make HTTP request
 */
async function request(method, path, body = null, headers = {}) {
  const url = `${BASE_URL}${path}`
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  }

  if (body) {
    options.body = JSON.stringify(body)
  }

  try {
    const response = await fetch(url, options)
    const text = await response.text()
    let data
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }

    return {
      status: response.status,
      data,
      ok: response.ok
    }
  } catch (error) {
    console.error(`Request failed: ${method} ${path}`, error.message)
    throw error
  }
}

/**
 * Test runner
 */
function test(name, fn) {
  return async () => {
    try {
      await fn()
      console.log(`✅ ${name}`)
      testsPassed++
    } catch (error) {
      console.error(`❌ ${name}`)
      console.error(`   ${error.message}`)
      testsFailed++
      failures.push({ test: name, error: error.message })
    }
  }
}

/**
 * Assertion helpers
 */
function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`Expected ${expected}, got ${actual}${message ? ': ' + message : ''}`)
  }
}

function assertTrue(condition, message = '') {
  if (!condition) {
    throw new Error(`Assertion failed${message ? ': ' + message : ''}`)
  }
}

function assertNotNull(value, message = '') {
  if (value === null || value === undefined) {
    throw new Error(`Expected non-null value${message ? ': ' + message : ''}`)
  }
}

/**
 * Setup test instance
 */
async function setupTestInstance(id, status = 'PENDING', version = 0) {
  await pool.query(
    'INSERT INTO approval_instances (id, status, version) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET status = $2, version = $3',
    [id, status, version]
  )
  // Clean up approval_records for this instance
  await pool.query('DELETE FROM approval_records WHERE instance_id = $1', [id])
}

/**
 * Cleanup test data
 */
async function cleanup() {
  await pool.query("DELETE FROM approval_records WHERE instance_id LIKE 'test-%'")
  await pool.query("DELETE FROM approval_instances WHERE id LIKE 'test-%'")
}

/**
 * Test Suite
 */

// Test 1: GET /api/approvals/:id - 200 OK
const test_get_200 = test('GET /api/approvals/:id returns 200 for existing instance', async () => {
  const token = await generateToken()
  await setupTestInstance('test-get-1', 'PENDING', 0)

  const res = await request('GET', '/api/approvals/test-get-1', null, { Authorization: `Bearer ${token}` })
  assertEqual(res.status, 200)
  assertTrue(res.data.ok, 'Response should have ok=true')
  assertEqual(res.data.data.id, 'test-get-1')
  assertEqual(res.data.data.status, 'PENDING')
  assertEqual(res.data.data.version, 0)
})

// Test 2: GET /api/approvals/:id - 404 Not Found
const test_get_404 = test('GET /api/approvals/:id returns 404 for non-existent instance', async () => {
  const token = await generateToken()

  const res = await request('GET', '/api/approvals/non-existent', null, { Authorization: `Bearer ${token}` })
  assertEqual(res.status, 404)
  assertEqual(res.data.ok, false)
  assertEqual(res.data.error.code, 'NOT_FOUND')
})

// Test 3: POST /api/approvals/:id/approve - 200 OK
const test_approve_200 = test('POST /api/approvals/:id/approve returns 200 for valid PENDING instance', async () => {
  const token = await generateToken()
  await setupTestInstance('test-approve-1', 'PENDING', 0)

  const res = await request('POST', '/api/approvals/test-approve-1/approve', { version: 0 }, { Authorization: `Bearer ${token}` })
  assertEqual(res.status, 200)
  assertTrue(res.data.ok)
  assertEqual(res.data.data.status, 'APPROVED')
  assertEqual(res.data.data.version, 1)
})

// Test 4: POST /api/approvals/:id/approve - 409 Conflict (version mismatch)
const test_approve_409 = test('POST /api/approvals/:id/approve returns 409 on version conflict', async () => {
  const token = await generateToken()
  await setupTestInstance('test-approve-2', 'PENDING', 5)

  const res = await request('POST', '/api/approvals/test-approve-2/approve', { version: 0 }, { Authorization: `Bearer ${token}` })
  assertEqual(res.status, 409)
  assertEqual(res.data.ok, false)
  assertEqual(res.data.error.code, 'APPROVAL_VERSION_CONFLICT')
  assertEqual(res.data.error.currentVersion, 5)
})

// Test 5: POST /api/approvals/:id/approve - 422 Invalid State Transition
const test_approve_422 = test('POST /api/approvals/:id/approve returns 422 for non-PENDING status', async () => {
  const token = await generateToken()
  await setupTestInstance('test-approve-3', 'APPROVED', 0)

  const res = await request('POST', '/api/approvals/test-approve-3/approve', { version: 0 }, { Authorization: `Bearer ${token}` })
  assertEqual(res.status, 422)
  assertEqual(res.data.ok, false)
  assertEqual(res.data.error.code, 'INVALID_STATE_TRANSITION')
  assertTrue(res.data.error.message.includes('Cannot approve from APPROVED'))
})

// Test 6: approval_records field validation
const test_approval_records_fields = test('Approval creates approval_records entry with all required fields', async () => {
  const token = await generateToken()
  const userId = '00000000-0000-0000-0000-000000000001'
  await setupTestInstance('test-records-1', 'PENDING', 0)

  const res = await request('POST', '/api/approvals/test-records-1/approve', { version: 0, comment: 'Test approval' }, { Authorization: `Bearer ${token}` })
  assertEqual(res.status, 200)

  // Query approval_records to verify fields
  const { rows } = await pool.query(
    'SELECT instance_id, action, actor_id, comment, from_status, to_status, from_version, to_version, created_at FROM approval_records WHERE instance_id = $1 ORDER BY created_at DESC LIMIT 1',
    ['test-records-1']
  )

  assertTrue(rows.length === 1, 'approval_records entry should exist')
  const record = rows[0]

  assertEqual(record.instance_id, 'test-records-1')
  assertEqual(record.action, 'approve')
  assertEqual(record.actor_id, userId)
  assertEqual(record.comment, 'Test approval')
  assertEqual(record.from_status, 'PENDING')
  assertEqual(record.to_status, 'APPROVED')
  assertEqual(record.from_version, 0)
  assertEqual(record.to_version, 1)
  assertNotNull(record.created_at)
})

// Test 7: POST /api/approvals/:id/reject - 200 OK
const test_reject_200 = test('POST /api/approvals/:id/reject returns 200 for valid PENDING instance', async () => {
  const token = await generateToken()
  await setupTestInstance('test-reject-1', 'PENDING', 0)

  const res = await request('POST', '/api/approvals/test-reject-1/reject', { version: 0 }, { Authorization: `Bearer ${token}` })
  assertEqual(res.status, 200)
  assertTrue(res.data.ok)
  assertEqual(res.data.data.status, 'REJECTED')
  assertEqual(res.data.data.version, 1)
})

// Test 8: POST /api/approvals/:id/return - 200 OK
const test_return_200 = test('POST /api/approvals/:id/return returns 200 for valid APPROVED instance', async () => {
  const token = await generateToken()
  await setupTestInstance('test-return-1', 'APPROVED', 1)

  const res = await request('POST', '/api/approvals/test-return-1/return', { version: 1 }, { Authorization: `Bearer ${token}` })
  assertEqual(res.status, 200)
  assertTrue(res.data.ok)
  assertEqual(res.data.data.status, 'RETURNED')
  assertEqual(res.data.data.version, 2)
})

// Test 9: POST /api/approvals/:id/return - 422 Invalid State Transition
const test_return_422 = test('POST /api/approvals/:id/return returns 422 for non-APPROVED status', async () => {
  const token = await generateToken()
  await setupTestInstance('test-return-2', 'PENDING', 0)

  const res = await request('POST', '/api/approvals/test-return-2/return', { version: 0 }, { Authorization: `Bearer ${token}` })
  assertEqual(res.status, 422)
  assertEqual(res.data.ok, false)
  assertEqual(res.data.error.code, 'INVALID_STATE_TRANSITION')
})

// Test 10: POST /api/approvals/:id/revoke - 200 OK
const test_revoke_200 = test('POST /api/approvals/:id/revoke returns 200 for valid APPROVED instance', async () => {
  const token = await generateToken()
  await setupTestInstance('test-revoke-1', 'APPROVED', 1)

  const res = await request('POST', '/api/approvals/test-revoke-1/revoke', { version: 1 }, { Authorization: `Bearer ${token}` })
  assertEqual(res.status, 200)
  assertTrue(res.data.ok)
  assertEqual(res.data.data.status, 'REVOKED')
  assertEqual(res.data.data.version, 2)
})

// Test 11: Transaction semantics - atomic update
const test_transaction_atomic = test('Approval update and record insert are atomic', async () => {
  const token = await generateToken()
  await setupTestInstance('test-tx-1', 'PENDING', 0)

  // Approve the instance
  const res = await request('POST', '/api/approvals/test-tx-1/approve', { version: 0 }, { Authorization: `Bearer ${token}` })
  assertEqual(res.status, 200)

  // Verify both instance and record exist
  const { rows: instanceRows } = await pool.query('SELECT status, version FROM approval_instances WHERE id = $1', ['test-tx-1'])
  assertTrue(instanceRows.length === 1)
  assertEqual(instanceRows[0].status, 'APPROVED')
  assertEqual(instanceRows[0].version, 1)

  const { rows: recordRows } = await pool.query('SELECT COUNT(*) as count FROM approval_records WHERE instance_id = $1', ['test-tx-1'])
  assertEqual(parseInt(recordRows[0].count), 1, 'Should have exactly one approval_record')
})

/**
 * Main test runner
 */
async function main() {
  console.log('🧪 Starting Approvals API Contract Tests\n')
  console.log(`📍 API Origin: ${BASE_URL}`)
  console.log(`📍 Database: ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}\n`)

  try {
    // Cleanup before tests
    await cleanup()

    // Run all tests
    await test_get_200()
    await test_get_404()
    await test_approve_200()
    await test_approve_409()
    await test_approve_422()
    await test_approval_records_fields()
    await test_reject_200()
    await test_return_200()
    await test_return_422()
    await test_revoke_200()
    await test_transaction_atomic()

    // Cleanup after tests
    await cleanup()

    // Summary
    console.log('\n' + '='.repeat(50))
    console.log(`✅ Tests Passed: ${testsPassed}`)
    console.log(`❌ Tests Failed: ${testsFailed}`)
    console.log('='.repeat(50))

    if (testsFailed > 0) {
      console.log('\n❌ Failed Tests:')
      failures.forEach(({ test, error }) => {
        console.log(`  - ${test}`)
        console.log(`    ${error}`)
      })
      await pool.end()
      process.exit(1)
    }

    console.log('\n🎉 All contract tests passed!')
    await pool.end()
    process.exit(0)
  } catch (error) {
    console.error('\n❌ Test suite failed:', error.message)
    console.error(error.stack)
    await pool.end()
    process.exit(1)
  }
}

main()
