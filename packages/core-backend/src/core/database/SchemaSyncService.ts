import { Kysely, sql } from 'kysely';
import { CollectionDefinition, FieldDefinition, FieldType } from '../../types/collection';
import { Logger } from '../logger';

export class SchemaSyncService {
  private logger = new Logger('SchemaSyncService');

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private db: Kysely<any>
  ) {}

  async sync(collections: CollectionDefinition[]): Promise<void> {
    for (const collection of collections) {
      await this.syncCollection(collection);
    }
  }

  private async syncCollection(collection: CollectionDefinition): Promise<void> {
    const tableName = collection.tableName;
    const exists = await this.tableExists(tableName);

    if (!exists) {
      await this.createTable(collection);
    } else {
      await this.alterTable(collection);
    }
  }

  private async tableExists(tableName: string): Promise<boolean> {
    const result = await sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = ${tableName}
      )
    `.execute(this.db);
    return (result.rows[0] as any).exists;
  }

  private async createTable(collection: CollectionDefinition): Promise<void> {
    this.logger.info(`Creating table: ${collection.tableName}`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let builder: any = this.db.schema.createTable(collection.tableName);

    // Standard columns
    // We assume every table has an 'id' or we use the defined PK
    // If no PK defined in fields, we might auto-add one, but for now we trust the definition.

    for (const field of collection.fields) {
      builder = this.addColumnToBuilder(builder, field);
    }

    // Default system columns if not present? 
    // For now, stick to definition.

    await builder.execute();
    this.logger.info(`Table ${collection.tableName} created successfully.`);
  }

  private async alterTable(collection: CollectionDefinition): Promise<void> {
    const tableName = collection.tableName;
    const existingColumns = await this.getExistingColumns(tableName);

    let hasChanges = false;

    for (const field of collection.fields) {
      if (!existingColumns.has(field.name)) {
        this.logger.info(`Adding column ${field.name} to table ${tableName}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let builder: any = this.db.schema.alterTable(tableName);
        builder = this.addColumnToAlterBuilder(builder, field);
        await builder.execute();
        hasChanges = true;
      }
      // TODO: Handle column modification (type change) - complex and risky
    }

    if (!hasChanges) {
      this.logger.debug(`Table ${tableName} is up to date.`);
    }
  }

  private async getExistingColumns(tableName: string): Promise<Set<string>> {
    const result = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = ${tableName}
    `.execute(this.db);

    const columns = new Set<string>();
    result.rows.forEach((row: any) => columns.add(row.column_name));
    return columns;
  }

  // Helper for CREATE TABLE
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private addColumnToBuilder(builder: any, field: FieldDefinition): any {
    const type = this.mapFieldType(field.type);
    let colBuilder = builder.addColumn(field.name, type);

    if (field.primaryKey) colBuilder = colBuilder.primaryKey();
    if (!field.nullable && !field.primaryKey) colBuilder = colBuilder.notNull();
    // Default value handling requires raw sql often
    if (field.defaultValue !== undefined) {
       // Simple strings/numbers work, complex types might need casting
       colBuilder = colBuilder.defaultTo(field.defaultValue);
    }

    return colBuilder;
  }

  // Helper for ALTER TABLE ADD COLUMN
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private addColumnToAlterBuilder(builder: any, field: FieldDefinition): any {
    const type = this.mapFieldType(field.type);
    let colBuilder = builder.addColumn(field.name, type);

    if (!field.nullable) colBuilder = colBuilder.notNull();
    if (field.defaultValue !== undefined) {
       colBuilder = colBuilder.defaultTo(field.defaultValue);
    }

    return colBuilder;
  }

  private mapFieldType(type: FieldType): string {
    switch (type) {
      case FieldType.UID: return 'uuid'; // Assuming UUID PKs
      case FieldType.String: return 'varchar(255)';
      case FieldType.Text: return 'text';
      case FieldType.Number: return 'numeric'; // Safe default
      case FieldType.Boolean: return 'boolean';
      case FieldType.Date: return 'date';
      case FieldType.DateTime: return 'timestamptz';
      case FieldType.Json: 
      case FieldType.Select:
      case FieldType.MultiSelect:
      case FieldType.Attachment:
        return 'jsonb'; // Store complex types as JSONB
      case FieldType.Link: return 'uuid'; // FK is usually UUID
      default: return 'text';
    }
  }
}
