import { CollectionDefinition, FieldDefinition } from '../../types/collection';
import { Repository } from './Repository';
import { db } from '../../db/db'; // Ensure this points to your Kysely instance
import { Logger } from '../logger';

export class CollectionManager {
  private repositories = new Map<string, Repository>();
  private logger = new Logger('CollectionManager');

  constructor() {}

  /**
   * Loads the spreadsheet schema (Fields) from the database.
   */
  async getDefinition(sheetId: string): Promise<CollectionDefinition | null> {
    // 1. Fetch Sheet Metadata
    const sheet = await db
      .selectFrom('meta_sheets')
      .selectAll()
      .where('id', '=', sheetId)
      .executeTakeFirst();

    if (!sheet) return null;

    // 2. Fetch Fields
    const fields = await db
      .selectFrom('meta_fields')
      .selectAll()
      .where('sheet_id', '=', sheetId)
      .orderBy('order', 'asc')
      .execute();

    // 3. Construct Definition
    const fieldDefs: FieldDefinition[] = fields.map(f => ({
      name: f.id, // Use the unique field ID as the name in FieldDefinition
      type: f.type as any,
      title: f.name, // Use f.name for display title
      ...((f.property as any) || {}) 
    }));

    return {
      name: sheet.id,
      tableName: 'meta_records', // Fixed table for JSONB approach
      title: sheet.name,
      fields: fieldDefs
    };
  }

  getRepository(sheetId: string): Repository {
    // Return a repository bound to the specific sheetId
    // We cache it, but the definition inside might need refreshing if schema changes.
    // For MVP, we assume schema is stable during the request.
    if (!this.repositories.has(sheetId)) {
      this.repositories.set(sheetId, new Repository(sheetId, db));
    }
    return this.repositories.get(sheetId)!;
  }

  // Deprecated: register() is no longer needed as we load from DB
  register(definition: CollectionDefinition) {
    this.logger.warn('CollectionManager.register is deprecated. Schema is now loaded from DB.');
  }

  async sync(): Promise<void> {
    // No-op: schema is loaded on-demand from DB.
  }
}
