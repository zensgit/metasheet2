
import Joi from 'joi';
import { Field } from './field'; // Base Field
import { BasicValueType, FOperator, ICellValue } from './types';

export class LinkField extends Field {
  static propertySchema = Joi.object({
    foreignDatasheetId: Joi.string().required(),
    brotherFieldId: Joi.string().optional(),
    limitSingleRecord: Joi.boolean().optional(),
  });

  get basicValueType(): BasicValueType {
    return BasicValueType.Array;
  }

  get innerBasicValueType(): BasicValueType {
    return BasicValueType.String;
  }

  validateCellValue(cellValue: ICellValue): Joi.ValidationResult {
    return Joi.array().items(Joi.string().required()).allow(null).validate(cellValue);
  }

  validateProperty(): Joi.ValidationResult {
    return LinkField.propertySchema.validate(this.field.property);
  }

  get apiMetaProperty(): any {
    return this.field.property;
  }

  get acceptFilterOperators(): FOperator[] {
    return [FOperator.IsEmpty, FOperator.IsNotEmpty];
  }

  cellValueToString(cellValue: ICellValue): string | null {
    if (!cellValue || !Array.isArray(cellValue)) return null;
    return cellValue.join(', ');
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
    if (openWriteValue == null) return null;
    return Array.isArray(openWriteValue) ? openWriteValue : [openWriteValue];
  }

  validateOpenWriteValue(openWriteValue: any): Joi.ValidationResult {
    return Joi.array().items(Joi.string().required()).allow(null).validate(openWriteValue);
  }

  get openValueJsonSchema() {
    return {
      type: 'array',
      items: { type: 'string' },
      title: this.field.name,
    };
  }
}
