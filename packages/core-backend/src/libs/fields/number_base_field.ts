import Joi from 'joi';
import { Field } from './field';
import { 
  BasicValueType, 
  FOperator, 
  StatType, 
  ICellValue, 
  IStandardValue,
  FieldType,
  SymbolAlign
} from './types';
import { isNumber } from 'lodash';
import { str2number, str2NumericStr, numberToShow, str2Currency } from './number_utils';

export abstract class NumberBaseField extends Field {
  static _statTypeList = [
    StatType.None,
    StatType.CountAll,
    StatType.Sum,
    StatType.Average,
    StatType.Max,
    StatType.Min,
    StatType.Empty,
    StatType.Filled,
    StatType.Unique,
    StatType.PercentEmpty,
    StatType.PercentFilled,
    StatType.PercentUnique,
  ];

  static _acceptFilterOperators = [
    FOperator.Is,
    FOperator.IsNot,
    FOperator.Greater,
    FOperator.GreaterEqual,
    FOperator.Less,
    FOperator.LessEqual,
    FOperator.IsEmpty,
    FOperator.IsNotEmpty,
    FOperator.IsRepeat,
  ];

  static cellValueSchema = Joi.number().unsafe().allow(null).required();
  static openWriteValueSchema = Joi.number().allow(null).required();

  get acceptFilterOperators(): FOperator[] {
    return NumberBaseField._acceptFilterOperators;
  }

  get statTypeList(): StatType[] {
    return NumberBaseField._statTypeList;
  }

  get basicValueType(): BasicValueType {
    return BasicValueType.Number;
  }

  static _compare(cellValue1: number | null, cellValue2: number | null): number {
    if (cellValue1 === null && cellValue2 === null) return 0;
    if (cellValue1 === null) return -1;
    if (cellValue2 === null) return 1;
    return cellValue1 === cellValue2 ? 0 : (cellValue1 > cellValue2 ? 1 : -1);
  }

  override compare(cellValue1: number, cellValue2: number): number {
    return NumberBaseField._compare(cellValue1, cellValue2);
  }

  static _isMeetFilter(operator: FOperator, cellValue: number | null, conditionValue: any) {
    if (operator === FOperator.IsEmpty) {
      return cellValue == null;
    }
    if (operator === FOperator.IsNotEmpty) {
      return cellValue != null;
    }

    if (conditionValue == null) return true;
    
    // Normalize condition value (support both array from legacy and direct number)
    let filterValue: number | null;
    if (Array.isArray(conditionValue)) {
        filterValue = conditionValue[0]?.trim() === '' ? null : Number(conditionValue[0]);
    } else {
        filterValue = Number(conditionValue);
    }

    if (filterValue == null || isNaN(filterValue)) {
      return true;
    }

    switch (operator) {
      case FOperator.Is:
        return cellValue != null && cellValue === filterValue;
      case FOperator.IsNot:
        return cellValue == null || cellValue !== filterValue;
      case FOperator.Greater:
        return cellValue != null && cellValue > filterValue;
      case FOperator.GreaterEqual:
        return cellValue != null && cellValue >= filterValue;
      case FOperator.Less:
        return cellValue != null && cellValue < filterValue;
      case FOperator.LessEqual:
        return cellValue != null && cellValue <= filterValue;
      default:
        return false;
    }
  }

  override isMeetFilter(operator: FOperator, cellValue: number | null, conditionValue: any) {
    return NumberBaseField._isMeetFilter(operator, cellValue, conditionValue);
  }

  cellValueToStdValue(val: number | null): IStandardValue {
    const stdVal: IStandardValue = {
      sourceType: this.field.type,
      data: [],
    };

    if (val != null) {
      stdVal.data.push({
        text: this.cellValueToString(val) || '',
        value: val,
      });
    }

    return stdVal;
  }

  stdValueToCellValue(stdVal: IStandardValue): number | null {
    const { data } = stdVal;
    if (data.length === 0) return null;
    const { text, value } = data[0]!;
    
    if (this.validate(value)) {
      return value;
    }
    const cellValue = str2NumericStr(text);
    return cellValue == null ? null : str2number(cellValue);
  }

  validate(value: any): value is number {
    return isNumber(value) && !Number.isNaN(value);
  }

  cellValueToApiStandardValue(cellValue: ICellValue): ICellValue {
    return cellValue;
  }

  cellValueToApiStringValue(cellValue: ICellValue): string | null {
    return this.cellValueToString(cellValue);
  }

  cellValueToOpenValue(cellValue: ICellValue): number | null {
    return cellValue as number;
  }

  openWriteValueToCellValue(openWriteValue: number | null) {
    if (openWriteValue === null || openWriteValue === undefined) {
      return null;
    }
    return openWriteValue;
  }

  validateCellValue(cellValue: ICellValue) {
    return NumberBaseField.cellValueSchema.validate(cellValue);
  }

  validateOpenWriteValue(owv: number | null) {
    return NumberBaseField.openWriteValueSchema.validate(owv);
  }

  get openValueJsonSchema() {
    return {
      type: 'number',
      title: this.field.name,
    };
  }
}