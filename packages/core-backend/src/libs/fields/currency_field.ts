import Joi from 'joi';
import { NumberBaseField } from './number_base_field';
import { CurrencyFieldProperty } from './properties';
import { ICellValue } from './types';
import { numberToShow } from './number_utils';

export class CurrencyField extends NumberBaseField {
  static propertySchema = Joi.object({
    precision: Joi.number().min(0).max(4).default(2),
    symbol: Joi.string().default('$'),
    symbolPosition: Joi.string().valid('prefix', 'suffix').default('prefix'),
  }).required();

  get apiMetaProperty() {
    const property = this.field.property as CurrencyFieldProperty;
    return {
      precision: property.precision ?? 2,
      symbol: property.symbol ?? '$',
      symbolPosition: property.symbolPosition ?? 'prefix',
    };
  }

  validateProperty(): Joi.ValidationResult {
    return CurrencyField.propertySchema.validate(this.field.property);
  }

  override cellValueToString(cellValue: ICellValue): string | null {
    if (cellValue == null) return null;
    if (typeof cellValue !== 'number' || isNaN(cellValue)) {
        return String(cellValue); // Return as string for non-numeric types
    }
    
    const property = this.field.property as CurrencyFieldProperty;
    const precision = property.precision ?? 2;
    const symbol = property.symbol ?? '$';
    const symbolPosition = property.symbolPosition ?? 'prefix';

    const formattedNumber = numberToShow(cellValue, precision); // Reusing numberToShow

    if (symbolPosition === 'prefix') {
      return `${symbol}${formattedNumber}`;
    } else {
      return `${formattedNumber}${symbol}`;
    }
  }

  get openValueJsonSchema() {
    const property = this.field.property as CurrencyFieldProperty;
    return {
      type: 'number',
      title: this.field.name,
      format: 'currency', // Custom format for OpenAPI/frontend
      'x-currency-symbol': property.symbol,
      'x-currency-position': property.symbolPosition,
      'x-precision': property.precision,
    };
  }
}
