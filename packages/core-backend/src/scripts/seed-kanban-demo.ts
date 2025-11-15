#!/usr/bin/env tsx
import { query } from '../db/pg'

async function main() {
  const id = '00000000-0000-0000-0000-00000000b001'
  const config = {
    columns: [
      { id: 'todo', title: 'Todo', cards: [], order: 1 },
      { id: 'doing', title: 'Doing', cards: [], order: 2 },
      { id: 'done', title: 'Done', cards: [], order: 3 }
    ]
  }
  await query(
    `INSERT INTO views(id, table_id, type, name, config)
     VALUES ($1, NULL, 'kanban', 'Board1', $2::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [id, JSON.stringify(config)]
  )
  console.log('Seeded kanban demo view:', id)
}

main().catch((e) => {
  console.error('Seed failed:', e)
  process.exit(1)
})

