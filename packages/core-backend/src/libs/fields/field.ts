
import Joi from 'joi';
import { isEqual } from 'lodash';
import { 
  FieldType, 
  BasicValueType, 
  FOperator, 
  StatType, 
  IField, 
  IFieldProperty, 
  ICellValue, 
  IStandardValue,
  IJsonSchema,
  IFilterCondition
} from './types';

export interface IBindFieldContext {
  (field: IField, context: any): Field;
}

export abstract class Field {
  static bindContext: IBindFieldContext;

  constructor(public field: IField, public context: any = {}) {}

  /**
   * Field Property returned by API
   */
  abstract get apiMetaProperty(): any;

  /**
   * Basic value type of the field
   */
  abstract get basicValueType(): BasicValueType;

  /**
   * Supported filter operators
   */
  abstract get acceptFilterOperators(): FOperator[];

  /**
   * Convert cell value to string
   */
  abstract cellValueToString(cellValue: ICellValue): string | null;

  /**
   * Convert cell value to standard value (for API)
   */
  abstract cellValueToApiStandardValue(cellValue: ICellValue): any;

  /**
   * Convert cell value to string value (for API)
   */
  abstract cellValueToApiStringValue(cellValue: ICellValue): string | null;

  /**
   * Validate cell value
   */
  abstract validateCellValue(cellValue: ICellValue): Joi.ValidationResult;

  /**
   * Validate field property
   */
  abstract validateProperty(): Joi.ValidationResult;
  
  /**
   * Open Value Schema
   */
  abstract get openValueJsonSchema(): IJsonSchema;

  /**
   * Convert to Open Value
   */
  abstract cellValueToOpenValue(cellValue: ICellValue): any;

  /**
   * Convert from Open Value
   */
  abstract openWriteValueToCellValue(openWriteValue: any): ICellValue;

  /**
   * Validate Open Write Value
   */
  abstract validateOpenWriteValue(openWriteValue: any): Joi.ValidationResult;


  get valueType(): Omit<BasicValueType, BasicValueType.Array> {
    if (this.basicValueType === BasicValueType.Array) {
      return this.innerBasicValueType;
    }
    return this.basicValueType;
  }

  get innerBasicValueType(): BasicValueType {
    return BasicValueType.String;
  }

  get canGroup(): boolean {
    return true;
  }

  get canFilter(): boolean {
    return true;
  }

  get statTypeList(): StatType[] {
    return [
      StatType.None,
      StatType.CountAll,
      StatType.Empty,
      StatType.Filled,
      StatType.Unique,
      StatType.PercentEmpty,
      StatType.PercentFilled,
      StatType.PercentUnique,
    ];
  }

  isMultiValueField(): boolean {
    return false;
  }

  defaultValue(): ICellValue {
    return null as any;
  }

  eq(cv1: ICellValue, cv2: ICellValue): boolean {
    return isEqual(cv1, cv2);
  }

  compare(cv1: ICellValue, cv2: ICellValue): number {
    if (cv1 == null && cv2 == null) return 0;
    if (cv1 == null) return 1;
    if (cv2 == null) return -1;

    const n1 = typeof cv1 === 'number' ? cv1 : Number(cv1);
    const n2 = typeof cv2 === 'number' ? cv2 : Number(cv2);
    if (Number.isFinite(n1) && Number.isFinite(n2)) {
      return n1 === n2 ? 0 : n1 > n2 ? 1 : -1;
    }

    return String(cv1).localeCompare(String(cv2), undefined, { numeric: true, sensitivity: 'base' });
  }

  isEmptyOrNot(operator: FOperator.IsEmpty | FOperator.IsNotEmpty, cellValue: ICellValue) {
    switch (operator) {
      case FOperator.IsEmpty:
        return cellValue == null;
      case FOperator.IsNotEmpty:
        return cellValue != null;
      default:
        throw new Error('compare operator type error');
    }
  }

  isMeetFilter(operator: FOperator, cellValue: ICellValue, conditionValue: any): boolean {
    switch (operator) {
      case FOperator.IsEmpty:
      case FOperator.IsNotEmpty:
        return this.isEmptyOrNot(operator, cellValue);
      default:
        console.warn('Method should be overwritten!');
        return true;
    }
  }

  protected stringInclude(str: string, searchStr: string) {
    return str.toLowerCase().includes(searchStr.trim().toLowerCase());
  }
}
