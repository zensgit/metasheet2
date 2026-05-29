import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'users')
  if (!exists) {
    return
  }

  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS employee_no TEXT,
    ADD COLUMN IF NOT EXISTS department TEXT,
    ADD COLUMN IF NOT EXISTS position TEXT,
    ADD COLUMN IF NOT EXISTS hire_date DATE
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_users_employee_no
    ON users (lower(employee_no))
    WHERE employee_no IS NOT NULL
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_users_department
    ON users (lower(department))
    WHERE department IS NOT NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'users')
  if (!exists) {
    return
  }

  await sql`
    DROP INDEX IF EXISTS idx_users_department
  `.execute(db)

  await sql`
    DROP INDEX IF EXISTS idx_users_employee_no
  `.execute(db)

  await sql`
    ALTER TABLE users
    DROP COLUMN IF EXISTS hire_date,
    DROP COLUMN IF EXISTS position,
    DROP COLUMN IF EXISTS department,
    DROP COLUMN IF EXISTS employee_no
  `.execute(db)
}
