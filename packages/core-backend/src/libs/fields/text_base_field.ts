
import Joi from 'joi';
import { Field } from './field';
import { 
  BasicValueType, 
  FOperator, 
  StatType, 
  ICellValue, 
  IStandardValue,
  ISegment,
  SegmentType,
  FieldType
} from './types';
import { isNumber, isString } from 'lodash';

export abstract class TextBaseField extends Field {
  static _acceptFilterOperators = [
    FOperator.Is,
    FOperator.IsNot,
    FOperator.Contains,
    FOperator.DoesNotContain,
    FOperator.IsEmpty,
    FOperator.IsNotEmpty,
    FOperator.IsRepeat,
  ];

  static cellValueSchema = Joi.array().items(Joi.object({
    text: Joi.string().allow('').required(),
    type: Joi.number().required(),
    link: Joi.string(),
  }).required()).allow(null).required();

  static openWriteValueSchema = Joi.string().allow(null).required();

  static propertySchema = Joi.any();

  get acceptFilterOperators(): FOperator[] {
    return TextBaseField._acceptFilterOperators;
  }

  get basicValueType(): BasicValueType {
    return BasicValueType.String;
  }

  cellValueToStdValue(cellValue: ISegment[] | null): IStandardValue {
    const stdValue: IStandardValue = {
      sourceType: FieldType.Text,
      data: []
    };

    if (cellValue) {
      stdValue.data = JSON.parse(JSON.stringify(cellValue));
    }
    return stdValue;
  }

  cellValueToString(cellValue: ISegment[] | null): string | null {
    if (cellValue == null) {
      return null;
    }
    return cellValue.map(seg => seg.text).join('') || null;
  }

  validateCellValue(cv: ICellValue): Joi.ValidationResult {
    return TextBaseField.cellValueSchema.validate(cv);
  }

  validateOpenWriteValue(owv: any): Joi.ValidationResult {
    return TextBaseField.openWriteValueSchema.validate(owv);
  }

  validateProperty(): Joi.ValidationResult {
    return TextBaseField.propertySchema.validate(this.field.property);
  }

  get openValueJsonSchema() {
    return {
      type: 'string',
      title: this.field.name,
    };
  }

  cellValueToApiStandardValue(cellValue: ICellValue): any {
    return this.cellValueToString(cellValue);
  }

  cellValueToApiStringValue(cellValue: ICellValue): string | null {
    return this.cellValueToString(cellValue);
  }

  cellValueToOpenValue(cellValue: ICellValue): any {
    return this.cellValueToString(cellValue);
  }

  openWriteValueToCellValue(openWriteValue: any): ICellValue {
    if (openWriteValue === null || openWriteValue === undefined) {
      return null;
    }
    return [{ type: SegmentType.Text, text: String(openWriteValue) }];
  }

  override isMeetFilter(operator: FOperator, cellValue: ICellValue, conditionValue: any): boolean {
    const cellText = this.cellValueToString(cellValue);
    
    if (operator === FOperator.IsEmpty) return cellText == null;
    if (operator === FOperator.IsNotEmpty) return cellText != null;
    
    if (conditionValue === null) return true;
    const filterValue = Array.isArray(conditionValue) ? conditionValue[0] : String(conditionValue);

    switch (operator) {
      case FOperator.Is:
        return cellText != null && cellText.trim().toLowerCase() === filterValue.trim().toLowerCase();
      case FOperator.IsNot:
        return cellText == null || cellText.trim().toLowerCase() !== filterValue.trim().toLowerCase();
      case FOperator.Contains:
        return cellText != null && this.stringInclude(cellText, filterValue);
      case FOperator.DoesNotContain:
        return cellText == null || !this.stringInclude(cellText, filterValue);
      default:
        return false;
    }
  }
}
