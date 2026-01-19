#!/usr/bin/env node
import { Client } from 'pg'

const DEFAULT_EMAILS = [
  'attn-login3@example.com',
  'attn-login4@example.com',
  'attn-ui-verify-1768822476@example.com',
]

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const argEmails = args.filter((arg) => !arg.startsWith('--'))
const envEmails = (process.env.ATTENDANCE_TEST_EMAILS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const emails = argEmails.length ? argEmails : (envEmails.length ? envEmails : DEFAULT_EMAILS)

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL not set')
  process.exit(1)
}

const tables = [
  { name: 'user_permissions', column: 'user_id' },
  { name: 'user_roles', column: 'user_id' },
  { name: 'user_orgs', column: 'user_id' },
  { name: 'attendance_events', column: 'user_id' },
  { name: 'attendance_records', column: 'user_id' },
  { name: 'attendance_requests', column: 'user_id' },
  { name: 'attendance_shift_assignments', column: 'user_id' },
]

const run = async () => {
  if (!emails.length) {
    console.log('No emails provided')
    return
  }

  const client = new Client({ connectionString: url })
  await client.connect()

  const { rows } = await client.query(
    'SELECT id, email FROM users WHERE email = ANY($1::text[])',
    [emails],
  )

  if (!rows.length) {
    console.log('No matching users found')
    await client.end()
    return
  }

  const ids = rows.map((row) => row.id)
  console.log('Target users:', rows)

  for (const { name, column } of tables) {
    const reg = await client.query('SELECT to_regclass($1) as reg', [`public.${name}`])
    if (!reg.rows[0]?.reg) {
      console.log(`skip ${name} (missing)`)
      continue
    }

    const sql = `DELETE FROM ${name} WHERE ${column} = ANY($1::text[])`
    if (dryRun) {
      console.log(`dry-run: ${sql}`)
      continue
    }

    const res = await client.query(sql, [ids])
    console.log(`deleted ${res.rowCount} from ${name}`)
  }

  const updateSql = [
    "UPDATE users SET",
    "email = CONCAT('deleted+', id, '@example.com'),",
    "name = 'deleted',",
    "role = 'disabled',",
    'permissions = $2::jsonb,',
    'is_active = false,',
    'is_admin = false,',
    'updated_at = now()',
    'WHERE id = ANY($1::text[])',
  ].join(' ')

  if (dryRun) {
    console.log(`dry-run: ${updateSql}`)
    await client.end()
    return
  }

  const update = await client.query(updateSql, [ids, '[]'])
  console.log(`updated ${update.rowCount} users`)

  await client.end()
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
