import { db } from '../src/db/db'
import { sql } from 'kysely'

async function ensureExtensions() {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db!)
}

async function upsertDefaultKanban() {
  const viewId = 'board1'
  const name = 'Default Kanban'
  const config = {
    columns: [
      { id: 'todo', title: '待处理', cards: ['1', '2'], order: 1 },
      { id: 'in_progress', title: '进行中', cards: [], order: 2 },
      { id: 'done', title: '已完成', cards: [], order: 3 }
    ]
  }
  // Insert if not exists
  await sql`
    INSERT INTO views(id, type, name, config)
    VALUES(${viewId}::uuid, 'kanban', ${name}, ${JSON.stringify(config)}::jsonb)
    ON CONFLICT (id) DO NOTHING
  `.execute(db!)
}

async function main() {
  if (!db) {
    console.error('Database not configured (DATABASE_URL).')
    process.exit(1)
  }
  await ensureExtensions()
  await upsertDefaultKanban()
  console.log('Default Kanban view ensured (board1).')
  await db.destroy()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

