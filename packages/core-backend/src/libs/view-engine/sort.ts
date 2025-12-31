
import { ISortInfo, IField } from '../fields/types';
import { FieldFactory } from '../fields/factory';

export class ViewSort {
  constructor(private fieldMap: Map<string, IField>) {}

  public apply(rows: any[], sortInfo: ISortInfo | undefined): any[] {
    if (!sortInfo || !sortInfo.rules || sortInfo.rules.length === 0) {
      return rows;
    }

    // Clone rows to avoid mutating original array
    const sortedRows = [...rows];

    sortedRows.sort((rowA, rowB) => {
      for (const rule of sortInfo.rules) {
        const { fieldId, desc } = rule;
        const fieldDef = this.fieldMap.get(fieldId);
        
        if (!fieldDef) continue;

        const fieldInstance = FieldFactory.create(fieldDef);
        const valA = rowA[fieldId];
        const valB = rowB[fieldId];

        const compareResult = fieldInstance.compare(valA, valB);

        if (compareResult !== 0) {
          return desc ? -compareResult : compareResult;
        }
      }
      return 0;
    });

    return sortedRows;
  }
}
