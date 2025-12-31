import Joi from 'joi';
import { Field } from './field';
import { RatingFieldProperty } from './properties';
import { BasicValueType, FOperator, ICellValue } from './types';

export class RatingField extends Field {
  static propertySchema = Joi.object({
    max: Joi.number().min(1).max(10).default(5),
    icon: Joi.string().valid('star', 'heart', 'thumbs', 'flag').default('star'),
  }).required();

  static cellValueSchema = Joi.number().min(0).allow(null).required();

  get basicValueType(): BasicValueType {
    return BasicValueType.Number;
  }

  get apiMetaProperty(): any {
    const { max = 5, icon = 'star' } = this.field.property as RatingFieldProperty
    return { max, icon }
  }

  get acceptFilterOperators(): FOperator[] {
    return [
      FOperator.Is,
      FOperator.IsNot,
      FOperator.Greater,
      FOperator.GreaterEqual,
      FOperator.Less,
      FOperator.LessEqual,
      FOperator.IsEmpty,
      FOperator.IsNotEmpty,
    ]
  }

  validateProperty(): Joi.ValidationResult {
    return RatingField.propertySchema.validate(this.field.property);
  }

  validateCellValue(cellValue: ICellValue): Joi.ValidationResult {
    const { max } = (this.field.property as RatingFieldProperty);
    return RatingField.cellValueSchema.max(max).validate(cellValue);
  }

  cellValueToString(cellValue: ICellValue): string | null {
    if (cellValue == null) return null;
    const { icon = 'star' } = (this.field.property as RatingFieldProperty);
    // Render as '★' for stars
    return `${icon === 'star' ? '★' : icon}: ${cellValue}`;
  }

  cellValueToApiStandardValue(cellValue: ICellValue): any {
    return cellValue;
  }

  cellValueToApiStringValue(cellValue: ICellValue): string | null {
    return this.cellValueToString(cellValue);
  }

  cellValueToOpenValue(cellValue: ICellValue): any {
    return cellValue;
  }

  openWriteValueToCellValue(openWriteValue: any): ICellValue {
    const num = Number(openWriteValue);
    if (isNaN(num)) return null;
    const { max } = (this.field.property as RatingFieldProperty);
    return Math.min(Math.max(0, num), max);
  }

  validateOpenWriteValue(openWriteValue: any): Joi.ValidationResult {
    return this.validateCellValue(openWriteValue)
  }

  get openValueJsonSchema() {
    const { max } = (this.field.property as RatingFieldProperty);
    return {
      type: 'number',
      title: this.field.name,
      minimum: 0,
      maximum: max,
    };
  }
}
