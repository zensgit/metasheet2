import { Kysely, sql } from 'kysely';

export interface FindOptions {
  filter?: Record<string, any>;
  sort?: string[]; 
  limit?: number;
  offset?: number;
}

export class Repository {
  constructor(
    private sheetId: string,
    private db: Kysely<any> 
  ) {}

  get name() {
    return this.sheetId;
  }

  async find(options: FindOptions = {}) {
    let query = this.db
      .selectFrom('meta_records')
      .selectAll()
      .where('sheet_id', '=', this.sheetId); // Filter by Sheet ID

    // JSONB Filter: data->>'field' = 'value'
    if (options.filter) {
      Object.entries(options.filter).forEach(([key, value]) => {
        query = query.where(sql`data->>${sql.lit(key)}`, '=', value);
      });
    }

    if (options.limit) query = query.limit(options.limit);
    if (options.offset) query = query.offset(options.offset);

    // JSONB Sort: ORDER BY data->>'field'
    if (options.sort) {
      options.sort.forEach(sortField => {
        const direction = sortField.startsWith('-') ? 'desc' : 'asc';
        const field = sortField.replace(/^-/, '');
        query = query.orderBy(sql`data->>${sql.lit(field)}`, direction);
      });
    }

    const rows = await query.execute();
    
    // Unpack: { id, data: { ... } } -> { id, ... }
    return rows.map((r: any) => ({ id: r.id, ...r.data, _meta: { created_at: r.created_at } }));
  }

  async update(recordId: string | number, data: Record<string, any>) {
    // JSONB Update: data || new_data (Merge)
    // Note: Kysely might need raw SQL for jsonb_set or || operator depending on dialect
    // Here using a simple merge approach assuming Postgres
    
    return await this.db
      .updateTable('meta_records')
      .set({
        data: sql`data || ${JSON.stringify(data)}::jsonb`,
        updated_at: sql`now()`
      })
      .where('id', '=', recordId)
      .where('sheet_id', '=', this.sheetId) // Safety check
      .returningAll()
      .executeTakeFirst();
  }

  // Create & Delete implementations would follow similar pattern...
}
