// @ts-nocheck
import mysql from 'mysql2/promise';
import { BaseDataAdapter } from './BaseAdapter';
export class MySQLAdapter extends BaseDataAdapter {
    pool = null;
    async connect() {
        if (this.connected) {
            return;
        }
        try {
            this.pool = mysql.createPool({
                host: this.config.connection.host,
                port: this.config.connection.port || 3306,
                database: this.config.connection.database,
                user: this.config.credentials?.username,
                password: this.config.credentials?.password,
                ssl: this.config.connection.ssl,
                connectionLimit: this.config.poolConfig?.max || 20,
                waitForConnections: true,
                queueLimit: 0,
                enableKeepAlive: true,
                keepAliveInitialDelay: 0,
                ...this.config.options
            });
            // Test connection
            const connection = await this.pool.getConnection();
            await connection.ping();
            connection.release();
            this.connected = true;
            await this.onConnect();
        }
        catch (error) {
            await this.onError(error);
            throw new Error(`Failed to connect to MySQL: ${error}`);
        }
    }
    async disconnect() {
        if (!this.connected || !this.pool) {
            return;
        }
        try {
            await this.pool.end();
            this.pool = null;
            this.connected = false;
            await this.onDisconnect();
        }
        catch (error) {
            await this.onError(error);
            throw new Error(`Failed to disconnect from MySQL: ${error}`);
        }
    }
    isConnected() {
        return this.connected && this.pool !== null;
    }
    async testConnection() {
        if (!this.pool) {
            return false;
        }
        try {
            const connection = await this.pool.getConnection();
            await connection.ping();
            connection.release();
            return true;
        }
        catch {
            return false;
        }
    }
    async query(sql, params) {
        if (!this.pool) {
            throw new Error('Not connected to database');
        }
        try {
            const [rows, fields] = await this.pool.execute(sql, params);
            return {
                data: rows,
                metadata: {
                    totalCount: Array.isArray(rows) ? rows.length : 0,
                    columns: fields?.map((field) => ({
                        name: field.name,
                        type: this.mapMySQLType(field.type),
                        nullable: !!(field.flags & 1)
                    }))
                }
            };
        }
        catch (error) {
            return {
                data: [],
                error: error
            };
        }
    }
    async select(table, options = {}) {
        const selectClause = options.select?.length
            ? options.select.map(col => `\`${col}\``).join(', ')
            : '*';
        let sql = `SELECT ${selectClause} FROM \`${table}\``;
        const params = [];
        // Add joins
        if (options.joins?.length) {
            for (const join of options.joins) {
                const joinType = join.type?.toUpperCase() || 'INNER';
                sql += ` ${joinType} JOIN \`${join.table}\` ON ${join.on}`;
            }
        }
        // Add where clause
        if (options.where && Object.keys(options.where).length > 0) {
            const conditions = [];
            for (const [key, value] of Object.entries(options.where)) {
                if (value === null) {
                    conditions.push(`\`${key}\` IS NULL`);
                }
                else if (Array.isArray(value)) {
                    const placeholders = value.map(() => '?').join(', ');
                    conditions.push(`\`${key}\` IN (${placeholders})`);
                    params.push(...value);
                }
                else {
                    conditions.push(`\`${key}\` = ?`);
                    params.push(value);
                }
            }
            if (conditions.length > 0) {
                sql += ` WHERE ${conditions.join(' AND ')}`;
            }
        }
        // Add order by
        if (options.orderBy?.length) {
            const orderClauses = options.orderBy.map(order => `\`${order.column}\` ${order.direction.toUpperCase()}`);
            sql += ` ORDER BY ${orderClauses.join(', ')}`;
        }
        // Add limit and offset
        if (options.limit) {
            sql += ` LIMIT ${options.limit}`;
        }
        if (options.offset) {
            sql += ` OFFSET ${options.offset}`;
        }
        return this.query(sql, params);
    }
    async insert(table, data) {
        const records = Array.isArray(data) ? data : [data];
        if (records.length === 0) {
            return { data: [] };
        }
        const columns = Object.keys(records[0]);
        const columnNames = columns.map(col => `\`${col}\``).join(', ');
        const values = [];
        const valuePlaceholders = [];
        for (const record of records) {
            const recordPlaceholders = columns.map(() => '?');
            valuePlaceholders.push(`(${recordPlaceholders.join(', ')})`);
            for (const column of columns) {
                values.push(record[column]);
            }
        }
        const sql = `
      INSERT INTO \`${table}\` (${columnNames})
      VALUES ${valuePlaceholders.join(', ')}
    `;
        const result = await this.query(sql, values);
        // MySQL doesn't return inserted rows by default
        // We need to query them separately if needed
        if (result.insertId) {
            const selectSql = `SELECT * FROM \`${table}\` WHERE id >= ? LIMIT ?`;
            return this.query(selectSql, [result.insertId, records.length]);
        }
        return result;
    }
    async update(table, data, where) {
        const setClause = [];
        const values = [];
        for (const [key, value] of Object.entries(data)) {
            setClause.push(`\`${key}\` = ?`);
            values.push(value);
        }
        const whereConditions = [];
        for (const [key, value] of Object.entries(where)) {
            if (value === null) {
                whereConditions.push(`\`${key}\` IS NULL`);
            }
            else {
                whereConditions.push(`\`${key}\` = ?`);
                values.push(value);
            }
        }
        const sql = `
      UPDATE \`${table}\`
      SET ${setClause.join(', ')}
      WHERE ${whereConditions.join(' AND ')}
    `;
        return this.query(sql, values);
    }
    async delete(table, where) {
        const conditions = [];
        const values = [];
        for (const [key, value] of Object.entries(where)) {
            if (value === null) {
                conditions.push(`\`${key}\` IS NULL`);
            }
            else {
                conditions.push(`\`${key}\` = ?`);
                values.push(value);
            }
        }
        const sql = `
      DELETE FROM \`${table}\`
      WHERE ${conditions.join(' AND ')}
    `;
        return this.query(sql, values);
    }
    async getSchema(schema) {
        const database = schema || this.config.connection.database;
        const tablesQuery = `
      SELECT
        TABLE_NAME as table_name,
        TABLE_SCHEMA as table_schema
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
        AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME
    `;
        const viewsQuery = `
      SELECT
        TABLE_NAME as view_name,
        TABLE_SCHEMA as view_schema,
        VIEW_DEFINITION as view_definition
      FROM information_schema.VIEWS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME
    `;
        const [tablesResult, viewsResult] = await Promise.all([
            this.query(tablesQuery, [database]),
            this.query(viewsQuery, [database])
        ]);
        const tables = [];
        for (const row of tablesResult.data) {
            const tableInfo = await this.getTableInfo(row.table_name, row.table_schema);
            tables.push(tableInfo);
        }
        const views = viewsResult.data.map(row => ({
            name: row.view_name,
            schema: row.view_schema,
            definition: row.view_definition,
            columns: [] // Would need additional query to get column info
        }));
        return { tables, views };
    }
    async getTableInfo(table, schema) {
        const database = schema || this.config.connection.database;
        const columns = await this.getColumns(table, database);
        // Get primary key info
        const pkQuery = `
      SELECT COLUMN_NAME as column_name
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND CONSTRAINT_NAME = 'PRIMARY'
      ORDER BY ORDINAL_POSITION
    `;
        const pkResult = await this.query(pkQuery, [database, table]);
        const primaryKey = pkResult.data.map(row => row.column_name);
        // Get indexes
        const indexQuery = `
      SELECT
        INDEX_NAME as index_name,
        NON_UNIQUE = 0 as is_unique,
        GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) as columns
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND INDEX_NAME != 'PRIMARY'
      GROUP BY INDEX_NAME, NON_UNIQUE
    `;
        const indexResult = await this.query(indexQuery, [database, table]);
        const indexes = indexResult.data.map(row => ({
            name: row.index_name,
            columns: row.columns.split(','),
            unique: row.is_unique
        }));
        // Get foreign keys
        const fkQuery = `
      SELECT
        CONSTRAINT_NAME as constraint_name,
        COLUMN_NAME as column_name,
        REFERENCED_TABLE_NAME as referenced_table,
        REFERENCED_COLUMN_NAME as referenced_column
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND REFERENCED_TABLE_NAME IS NOT NULL
    `;
        const fkResult = await this.query(fkQuery, [database, table]);
        const foreignKeys = fkResult.data.map(row => ({
            name: row.constraint_name,
            column: row.column_name,
            referencedTable: row.referenced_table,
            referencedColumn: row.referenced_column
        }));
        return {
            name: table,
            schema: database,
            columns,
            primaryKey,
            indexes,
            foreignKeys
        };
    }
    async getColumns(table, schema) {
        const database = schema || this.config.connection.database;
        const query = `
      SELECT
        COLUMN_NAME as column_name,
        DATA_TYPE as data_type,
        IS_NULLABLE as is_nullable,
        COLUMN_DEFAULT as column_default,
        CHARACTER_MAXIMUM_LENGTH as max_length,
        NUMERIC_PRECISION as precision,
        NUMERIC_SCALE as scale,
        COLUMN_COMMENT as comment,
        EXTRA as extra
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `;
        const result = await this.query(query, [database, table]);
        return result.data.map(row => ({
            name: row.column_name,
            type: this.formatColumnType(row),
            nullable: row.is_nullable === 'YES',
            defaultValue: row.column_default,
            autoIncrement: row.extra.includes('auto_increment'),
            comment: row.comment || undefined
        }));
    }
    async tableExists(table, schema) {
        const database = schema || this.config.connection.database;
        const query = `
      SELECT COUNT(*) as count
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND TABLE_TYPE = 'BASE TABLE'
    `;
        const result = await this.query(query, [database, table]);
        return result.data[0]?.count > 0;
    }
    async beginTransaction() {
        if (!this.pool) {
            throw new Error('Not connected to database');
        }
        const connection = await this.pool.getConnection();
        await connection.beginTransaction();
        return connection;
    }
    async commit(transaction) {
        try {
            await transaction.commit();
        }
        finally {
            transaction.release();
        }
    }
    async rollback(transaction) {
        try {
            await transaction.rollback();
        }
        finally {
            transaction.release();
        }
    }
    async inTransaction(transaction, callback) {
        try {
            const result = await callback();
            await this.commit(transaction);
            return result;
        }
        catch (error) {
            await this.rollback(transaction);
            throw error;
        }
    }
    async *stream(sql, params, options) {
        if (!this.pool) {
            throw new Error('Not connected to database');
        }
        const connection = await this.pool.getConnection();
        try {
            const stream = connection.execute(sql, params).stream();
            for await (const row of stream) {
                yield row;
            }
        }
        finally {
            connection.release();
        }
    }
    mapMySQLType(type) {
        const typeMap = {
            1: 'tinyint',
            2: 'smallint',
            3: 'int',
            4: 'float',
            5: 'double',
            6: 'null',
            7: 'timestamp',
            8: 'bigint',
            9: 'mediumint',
            10: 'date',
            11: 'time',
            12: 'datetime',
            13: 'year',
            252: 'text',
            253: 'varchar',
            254: 'char'
        };
        return typeMap[type] || 'unknown';
    }
    formatColumnType(column) {
        let type = column.data_type;
        if (column.max_length && ['varchar', 'char'].includes(column.data_type)) {
            type += `(${column.max_length})`;
        }
        else if (column.precision && ['decimal', 'numeric'].includes(column.data_type)) {
            type += `(${column.precision}`;
            if (column.scale) {
                type += `,${column.scale}`;
            }
            type += ')';
        }
        return type;
    }
}
// @ts-nocheck
//# sourceMappingURL=MySQLAdapter.js.map