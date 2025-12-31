import { IField, FieldType } from './types';
import { Field } from './field';
import { NumberField } from './number_field';
import { SingleTextField } from './single_text_field';
import { LinkField } from './link_field';
import { LookupField } from './lookup_field';
import { RatingField } from './rating_field'; // 新增
import { CurrencyField } from './currency_field'; // 新增

export class FieldFactory {
  static create(fieldDef: IField): Field {
    switch (fieldDef.type) {
      case FieldType.Number:
        return new NumberField(fieldDef);
      case FieldType.Link:
        return new LinkField(fieldDef);
      case FieldType.Lookup:
        return new LookupField(fieldDef);
      case FieldType.Rating: // 新增
        return new RatingField(fieldDef);
      case FieldType.Currency: // 新增
        return new CurrencyField(fieldDef);
      case FieldType.String:
      case FieldType.Text:
      default:
        // Default to SingleText for string-like types or unknown types for now
        return new SingleTextField(fieldDef);
    }
  }
}