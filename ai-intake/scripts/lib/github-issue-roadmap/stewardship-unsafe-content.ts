/**
 * The single secret-like content predicate for the roadmap sorter. Evidence
 * collection uses it to withhold an unsafe repository item and, through
 * assertStewardshipPacketSafe, to defer a whole packet; both must agree.
 */
export function stewardshipUnsafePatternId(value: unknown, configuredSensitiveValues: readonly string[] = []): "private_key" | "token_signature" | "credential_assignment" | "configured_value" | null {
  const text = JSON.stringify(value) ?? "";
  const texts = [text];
  // JSON escapes can hide a word boundary (e.g. newline + ghp_ becomes \\nghp_).
  // Keep the JSON screen and also inspect every decoded string and object key,
  // plus a variant with literal source escapes decoded to a bounded fixed point
  // (four-digit, braced code point, hex and octal escapes become the character;
  // backslash-n and the other single-character escapes become a space), so a
  // token written inside an escaped string literal is still recognised.
  const unescapeOnce = (value: string) => value
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (match: string, hex: string) => {
      const code = Number.parseInt(hex, 16); return code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\([0-3][0-7]{2}|[0-7]{1,2})(?![0-7])/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
    .replace(/\\[ntrfbv'"\\/]/g, " ");
  // Decoding can expose a further escape (an escaped backslash before a u-escape).
  const unescapeLiteral = (value: string) => {
    let current = value;
    for (let pass = 0; pass < 4 && current.includes("\\"); pass += 1) {
      const next = unescapeOnce(current);
      if (next === current) break;
      current = next;
    }
    return current;
  };
  const add = (value: string) => { texts.push(value); if (value.includes("\\")) texts.push(unescapeLiteral(value)); };
  const visit = (entry: unknown): void => {
    if (typeof entry === "string") add(entry);
    else if (typeof entry === "object" && entry !== null) {
      for (const [key, child] of Object.entries(entry)) { add(key); visit(child); }
    }
  };
  visit(value);
  const secretLike = [
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/,
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9]{24,})\b/,
  ];
  if (texts.some((candidate) => secretLike[0].test(candidate))) return "private_key";
  if (texts.some((candidate) => secretLike[1].test(candidate))) return "token_signature";
  // These exact code forms are types/references, not literal values. Change
  // only the property name for the assignment heuristic; keep the original
  // bytes for known secret signatures and configured-value screening.
  const assignments = texts.map((candidate) => candidate
    .replace(/\bpinnedTokens(?=\s*:\s*(?:(?:readonly\s+)?string\[\]|[A-Za-z_$][\w$]*\.pinnedTokens)(?=[\s,;|?})"\\]|$))/g, "pinnedValues")
    .replace(/\bmaxTokens(?=\s*:\s*[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?=[\s,;})"\\]|$))/g, "maxValues"));
  const credentialAssignment = /\b(?:[A-Z0-9_]*(?:TOKEN|API_?KEY|SECRET|PASSWORD|CREDENTIAL|PRIVATE_?KEY)[A-Z0-9_]*|DATABASE_URL)(?:\\?["'])?\s*[=:]\s*(?:\\?["'])?(?!process\.env\b|import\.meta\.env\b)[^\s,"'\\{}]{8,}/i;
  if (assignments.some((candidate) => credentialAssignment.test(candidate))) return "credential_assignment";
  if (configuredSensitiveValues.some((secret) => secret.length >= 8
      && (text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1))))) {
    return "configured_value";
  }
  return null;
}
