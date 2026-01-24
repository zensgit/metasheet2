
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { FieldType } from '../fields/types';

export interface ImportResult {
  sheetName: string;
  fields: Array<{ name: string; type: FieldType }>;
  rows: Array<Record<string, any>>;
}

export class ImportEngine {
  
  /**
   * Parse CSV Buffer
   */
  static parseCSV(buffer: Buffer): ImportResult {
    const content = buffer.toString('utf-8');
    const records = parse(content, {
      columns: true,
      skip_empty_lines: true
    }) as Array<Record<string, unknown>>;

    if (records.length === 0) {
      return { sheetName: 'Imported', fields: [], rows: [] };
    }

    // Infer fields from first row
    const fields = Object.keys(records[0] ?? {}).map(key => ({
      name: key,
      type: this.inferType((records[0] as Record<string, unknown>)[key])
    }));

    return {
      sheetName: 'CSV Import',
      fields,
      rows: records as Array<Record<string, any>>
    };
  }

  /**
   * Parse Excel Buffer
   */
  static async parseExcel(buffer: Buffer): Promise<ImportResult[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const results: ImportResult[] = [];

    workbook.eachSheet((worksheet: ExcelJS.Worksheet) => {
      const rows: Array<Record<string, any>> = [];
      let headers: string[] = [];

      worksheet.eachRow((row: ExcelJS.Row, rowNumber: number) => {
        const rowValues = row.values as any[]; // ExcelJS values start at index 1
        // Shift to index 0
        const values = rowValues.slice(1);

        if (rowNumber === 1) {
          headers = values.map(v => String(v));
        } else {
          const rowData: Record<string, any> = {};
          headers.forEach((header, index) => {
            let val = values[index];
            if (val && typeof val === 'object' && 'text' in val) {
                val = val.text; // Handle hyperlinks
            }
            rowData[header] = val;
          });
          rows.push(rowData);
        }
      });

      if (headers.length > 0) {
        // Infer type from first data row
        const firstRow = rows[0] || {};
        const fields = headers.map(h => ({
          name: h,
          type: this.inferType(firstRow[h])
        }));

        results.push({
          sheetName: worksheet.name,
          fields,
          rows
        });
      }
    });

    return results;
  }

  private static inferType(value: any): FieldType {
    if (typeof value === 'number') return FieldType.Number;
    // Simple heuristic
    if (typeof value === 'string') {
        if (!isNaN(Number(value)) && value.trim() !== '') return FieldType.Number;
    }
    return FieldType.String;
  }
}
