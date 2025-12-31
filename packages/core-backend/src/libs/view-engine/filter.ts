
import { IFilterInfo, FilterConjunction, IField, FOperator } from '../fields/types';
import { FieldFactory } from '../fields/factory';

export class ViewFilter {
  constructor(private fieldMap: Map<string, IField>) {}

  public apply(rows: any[], filterInfo: IFilterInfo | undefined): any[] {
    if (!filterInfo || !filterInfo.conditions || filterInfo.conditions.length === 0) {
      return rows;
    }

    const { conjunction, conditions } = filterInfo;

    return rows.filter(row => {
      if (conjunction === FilterConjunction.And) {
        return conditions.every(condition => this.checkCondition(row, condition));
      } else {
        return conditions.some(condition => this.checkCondition(row, condition));
      }
    });
  }

  private checkCondition(row: any, condition: any): boolean {
    const { fieldId, operator, value } = condition;
    
    // If operator is IsRepeat, we might need a separate pass (not implemented in this simple filter)
    if (operator === FOperator.IsRepeat) {
        return false; // Not supported in this pass
    }

    const fieldDef = this.fieldMap.get(fieldId);
    if (!fieldDef) {
      // If field not found, treat as mismatch or ignore? 
      // Default to false (filtered out) if we strictly require fields.
      return false;
    }

    const fieldInstance = FieldFactory.create(fieldDef);
    const cellValue = row[fieldId];

    return fieldInstance.isMeetFilter(operator, cellValue, value);
  }
}
