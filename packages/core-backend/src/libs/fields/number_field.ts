
import Joi from 'joi';
import { NumberBaseField } from './number_base_field';
import { ICellValue, SymbolAlign } from './types';
import { numberToShow, str2Currency, str2number } from './number_utils';

export class NumberField extends NumberBaseField {
  static propertySchema = Joi.object({
    precision: Joi.number().min(0).max(1000).required(),
    defaultValue: Joi.string().allow(''),
    commaStyle: Joi.string().allow(''),
    symbol: Joi.string().allow(''),
    symbolAlign: Joi.valid(SymbolAlign.left, SymbolAlign.right),
  }).required();

  override cellValueToString(cellValue: ICellValue, cellToStringOption?: any): string | null {
    if (this.validate(cellValue)) {
      const { symbol, precision, symbolAlign = SymbolAlign.right, commaStyle } = this.field.property;
      const cellString = numberToShow(cellValue, precision);
      const { hideUnit } = cellToStringOption || {};
      
      if ((!symbol && !commaStyle) || hideUnit) {
        return cellString;
      }
      if (!commaStyle) {
        return `${cellString}${symbol}`;
      }

      return str2Currency(cellString, symbol, 3, commaStyle, symbolAlign);
    }
    return null;
  }

  override compare(cellValue1: number, cellValue2: number): number {
    return NumberBaseField._compare(
      this.compareCellValue(cellValue1),
      this.compareCellValue(cellValue2),
    );
  }

  compareCellValue(cellValue: ICellValue): number | null {
    const cellValue2Str = this.cellValueToString(cellValue, { hideUnit: true });
    return cellValue2Str === null ? null : str2number(cellValue2Str as string);
  }

  override defaultValue(): ICellValue {
    const { defaultValue } = this.field.property;
    return defaultValue ? str2number(defaultValue) : null;
  }

  validateProperty() {
    return NumberField.propertySchema.validate(this.field.property);
  }

  override get apiMetaProperty() {
    const { defaultValue, precision = 0, commaStyle, symbol } = this.field.property;
    return {
      defaultValue: defaultValue || undefined,
      precision,
      commaStyle: commaStyle || undefined,
      symbol: symbol || undefined
    };
  }
}
