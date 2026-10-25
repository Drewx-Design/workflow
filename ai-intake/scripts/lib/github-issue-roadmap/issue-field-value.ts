type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

/** Frozen v1 identity precedence shared by every read-only roadmap consumer. */
export function issueFieldValueIdentity(raw: unknown): {
  readonly name: string | null;
  readonly value: string | null;
} {
  const item = object(raw);
  const field = object(item.field);
  const issueField = object(item.issue_field);
  const option = isObject(item.single_select_option)
    ? item.single_select_option
    : isObject(item.option)
      ? item.option
      : object(item.value);
  const name = typeof field.name === "string"
    ? field.name
    : typeof issueField.name === "string"
      ? issueField.name
      : typeof item.issue_field_name === "string"
        ? item.issue_field_name
        : typeof item.field_name === "string"
          ? item.field_name
          : null;
  const value = typeof item.value === "string"
    ? item.value
    : typeof option.name === "string"
      ? option.name
      : typeof item.name === "string"
        ? item.name
        : null;
  return { name, value };
}
