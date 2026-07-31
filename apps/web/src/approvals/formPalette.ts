import {
  AUTHORABLE_FIELD_TYPES,
  type AuthorableFieldType,
  type FormAuthoringFieldType,
} from "./templateAuthoring";

export const APPROVAL_FORM_PALETTE_MIME =
  "application/x-metasheet-approval-field-type";
export const APPROVAL_FORM_FIELD_MOVE_MIME =
  "application/x-metasheet-approval-field-index";

export const APPROVAL_FORM_FIELD_TYPE_LABELS: Record<
  FormAuthoringFieldType,
  string
> = {
  text: "单行文本",
  textarea: "多行文本",
  number: "数字",
  date: "日期",
  datetime: "日期时间",
  select: "单选",
  "multi-select": "多选",
  user: "用户",
  detail: "明细",
  "record-link": "关联记录",
  attachment: "附件",
};

export const APPROVAL_FORM_PALETTE_TYPES: readonly AuthorableFieldType[] =
  AUTHORABLE_FIELD_TYPES;

const AUTHORABLE_FIELD_TYPE_SET = new Set<string>(AUTHORABLE_FIELD_TYPES);

/** Attachment is opt-in even when the canvas itself is enabled. */
export function approvalFormPaletteTypes(
  attachmentAuthoringEnabled: boolean,
): readonly FormAuthoringFieldType[] {
  return attachmentAuthoringEnabled
    ? [...APPROVAL_FORM_PALETTE_TYPES, "attachment"]
    : APPROVAL_FORM_PALETTE_TYPES;
}

export function readPaletteFieldType(
  dataTransfer: DataTransfer | null,
  attachmentAuthoringEnabled = false,
): FormAuthoringFieldType | null {
  const value = dataTransfer?.getData(APPROVAL_FORM_PALETTE_MIME) ?? "";
  if (value === "attachment") {
    return attachmentAuthoringEnabled ? "attachment" : null;
  }
  return AUTHORABLE_FIELD_TYPE_SET.has(value)
    ? (value as AuthorableFieldType)
    : null;
}

export function readMovedFieldIndex(
  dataTransfer: DataTransfer | null,
): number | null {
  const value = dataTransfer?.getData(APPROVAL_FORM_FIELD_MOVE_MIME) ?? "";
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const index = Number(value);
  return Number.isSafeInteger(index) ? index : null;
}
