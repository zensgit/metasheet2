import { describe, expect, it, vi } from "vitest";
import {
  APPROVAL_FORM_FIELD_MOVE_MIME,
  APPROVAL_FORM_FIELD_TYPE_LABELS,
  APPROVAL_FORM_PALETTE_MIME,
  APPROVAL_FORM_PALETTE_TYPES,
  approvalFormPaletteTypes,
  readMovedFieldIndex,
  readPaletteFieldType,
} from "../src/approvals/formPalette";
import { AUTHORABLE_FIELD_TYPES } from "../src/approvals/templateAuthoring";

function transfer(entries: Record<string, string>): DataTransfer {
  return {
    getData: vi.fn((type: string) => entries[type] ?? ""),
  } as unknown as DataTransfer;
}

describe("approval form palette drag payload", () => {
  it("derives the rendered palette from the schema authoring allowlist", () => {
    expect(APPROVAL_FORM_PALETTE_TYPES).toEqual(AUTHORABLE_FIELD_TYPES);
    expect(Object.keys(APPROVAL_FORM_FIELD_TYPE_LABELS).sort()).toEqual(
      [...AUTHORABLE_FIELD_TYPES, "attachment"].sort(),
    );
    expect(approvalFormPaletteTypes(false)).toEqual(AUTHORABLE_FIELD_TYPES);
    expect(approvalFormPaletteTypes(true)).toEqual([
      ...AUTHORABLE_FIELD_TYPES,
      "attachment",
    ]);
  });

  it("accepts only field types supported by the existing authoring schema", () => {
    expect(
      readPaletteFieldType(
        transfer({
          [APPROVAL_FORM_PALETTE_MIME]: "record-link",
        }),
      ),
    ).toBe("record-link");
    expect(
      readPaletteFieldType(
        transfer({
          [APPROVAL_FORM_PALETTE_MIME]: "attachment",
        }),
      ),
    ).toBeNull();
    expect(
      readPaletteFieldType(
        transfer({
          [APPROVAL_FORM_PALETTE_MIME]: "attachment",
        }),
        true,
      ),
    ).toBe("attachment");
    expect(
      readPaletteFieldType(
        transfer({
          [APPROVAL_FORM_PALETTE_MIME]: "__proto__",
        }),
      ),
    ).toBeNull();
    expect(readPaletteFieldType(null)).toBeNull();
  });

  it("accepts only non-negative safe integer field indices", () => {
    expect(
      readMovedFieldIndex(
        transfer({
          [APPROVAL_FORM_FIELD_MOVE_MIME]: "0",
        }),
      ),
    ).toBe(0);
    expect(
      readMovedFieldIndex(
        transfer({
          [APPROVAL_FORM_FIELD_MOVE_MIME]: "12",
        }),
      ),
    ).toBe(12);
    expect(
      readMovedFieldIndex(
        transfer({
          [APPROVAL_FORM_FIELD_MOVE_MIME]: "-1",
        }),
      ),
    ).toBeNull();
    expect(
      readMovedFieldIndex(
        transfer({
          [APPROVAL_FORM_FIELD_MOVE_MIME]: "1.5",
        }),
      ),
    ).toBeNull();
    expect(
      readMovedFieldIndex(
        transfer({
          [APPROVAL_FORM_FIELD_MOVE_MIME]: "9007199254740992",
        }),
      ),
    ).toBeNull();
  });
});
