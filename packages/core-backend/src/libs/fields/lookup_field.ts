
import Joi from 'joi';
import { Field } from './field'; // Base Field
import { 
  BasicValueType, 
  FOperator,
  ICellValue, 
} from './types';

export class LookupField extends Field { // Extend Field directly
  static propertySchema = Joi.object({
    datasheetId: Joi.string().required(),
    relatedLinkFieldId: Joi.string().required(),
    lookUpTargetFieldId: Joi.string().required(),
  });

  get basicValueType(): BasicValueType {
    // In a real implementation, this depends on the target field type
    return BasicValueType.Array;
  }

  get apiMetaProperty(): any {
    return this.field.property
  }

  get acceptFilterOperators(): FOperator[] {
    return [FOperator.IsEmpty, FOperator.IsNotEmpty]
  }

  validateCellValue(cellValue: ICellValue): Joi.ValidationResult {
    // Computed field, usually read-only, but validation might check structure
    return Joi.any().validate(cellValue);
  }

  validateProperty(): Joi.ValidationResult {
    return LookupField.propertySchema.validate(this.field.property);
  }

  cellValueToString(cellValue: ICellValue): string | null {
    if (!cellValue) return null;
    return Array.isArray(cellValue) ? cellValue.join(', ') : String(cellValue);
  }

  // ... Implement other abstract methods similarly to LinkField ...
  
  cellValueToApiStandardValue(cellValue: ICellValue): any { return cellValue; }
  cellValueToApiStringValue(cellValue: ICellValue): string | null { return this.cellValueToString(cellValue); }
  cellValueToOpenValue(cellValue: ICellValue): any { return cellValue; }
  openWriteValueToCellValue(openWriteValue: any): ICellValue { return null; } // Read-only
  get openValueJsonSchema() { return { type: 'array', title: this.field.name }; }

  validateOpenWriteValue(openWriteValue: any): Joi.ValidationResult {
    return Joi.any().allow(null).validate(openWriteValue)
  }
}
