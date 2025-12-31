
import Joi from 'joi';
import { TextBaseField } from './text_base_field';
import { ISegment, SegmentType } from './types';

export class SingleTextField extends TextBaseField {
  static override propertySchema = Joi.object({
    defaultValue: Joi.string().allow('')
  });

  override get apiMetaProperty() {
    return {
      defaultValue: this.field.property.defaultValue,
    };
  }

  override validateProperty() {
    return SingleTextField.propertySchema.validate(this.field.property);
  }

  override defaultValue(): ISegment[] {
    const defaultValue = this.field.property.defaultValue;
    if (!defaultValue || !defaultValue.trim().length) {
      return null as any;
    }
    return [{ type: SegmentType.Text, text: defaultValue }];
  }
}
