import ExcelJS from 'exceljs';
import type { IField } from '../fields/types';

export class ExportEngine {
  static async toExcel(sheetName: string, fields: IField[], rows: any[]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(sheetName);

    worksheet.columns = fields.map((f) => ({
      header: f.name,
      key: f.id,
      width: 20,
    }));

    worksheet.addRows(rows);

    return (await workbook.xlsx.writeBuffer()) as Buffer;
  }

  static toCSV(fields: IField[], rows: any[]): string {
    const header = fields.map((f) => this.escapeCSV(f.name)).join(',');

    const body = rows
      .map((row) => fields.map((f) => this.escapeCSV(row?.[f.id])).join(','))
      .join('\n');

    return body ? `${header}\n${body}` : header;
  }

  private static escapeCSV(value: unknown): string {
    if (value === null || value === undefined) return '';

    const str =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value);

    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }

    return str;
  }
}
