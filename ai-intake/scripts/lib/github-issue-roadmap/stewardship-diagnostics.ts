import type { StewardshipSeat } from "./stewardship-assessment";
import type { StewardshipAstraStartupCheck } from "./stewardship-astra-seat";

/** Only host-owned codes, schema paths and validated protocol names may leave a failure boundary. */
export interface StewardshipDiagnostic {
  readonly seat: StewardshipSeat["family"] | null;
  readonly stage: "evidence" | "comparison" | "input" | "credential" | "startup" | "transport" | "runtime" | "response_json" | "response_safety" | "schema" | "binding" | "citations" | "clauses" | "archive" | "reservation" | "expansion";
  readonly code: "local_path" | "refused" | "invalid_json" | "runtime_not_tool_free" | "tool_event" | "schema_invalid" | "binding_mismatch" | "absent_evidence" | "unknown_fact" | "incomplete_clauses" | "unknown_clause" | "invalid_code_quote" | "archive_hash_mismatch" | "assessment_timeout" | "assessment_output_limit" | "assessment_cleanup_failed" | "assessment_spawn_failed" | "assessment_input_failed" | "assessment_exit_failed" | "assessment_deadline" | "seat_unavailable" | "seat_startup_timeout";
  readonly field: string;
  readonly method?: string;
  /** The Astra seat's failed host-owned startup or qualification predicate, recorded in the run report. */
  readonly check?: StewardshipAstraStartupCheck;
}

const methodToken = /^[A-Za-z][A-Za-z0-9/._-]{0,63}$/;
const diagnosticMethod = /^(?:[A-Za-z][A-Za-z0-9/._-]{0,63}|\(none\)|\(unrecognized\)|item\/(?:started|completed):(?:[A-Za-z][A-Za-z0-9/._-]{0,63}|\(unrecognized\)))$/;
export function isStewardshipDiagnosticMethod(value: string): boolean {
  // Full-match equality is defense in depth for the anchored method pattern.
  return diagnosticMethod.exec(value)?.[0] === value;
}
function safeToken(value: unknown): string {
  return typeof value === "string" && methodToken.exec(value)?.[0] === value ? value : "(unrecognized)";
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function stewardshipMessageMethod(message: Record<string, unknown>): string {
  if (typeof message.method !== "string") return "(none)";
  const method = safeToken(message.method);
  return message.method === "item/started" || message.method === "item/completed"
    ? `${method}:${safeToken(object(object(message.params).item).type)}` : method;
}

// An arbitrary error's message, cause, keys or values must never become diagnostics.
export class StewardshipAssessmentError extends Error {
  readonly detail: Omit<StewardshipDiagnostic, "seat">;
  constructor(detail: Omit<StewardshipDiagnostic, "seat">) {
    super(`Stewardship model assessment failed: ${detail.code}`);
    this.detail = detail.method === undefined ? detail : { ...detail,
      method: typeof detail.method === "string" && isStewardshipDiagnosticMethod(detail.method) ? detail.method : "(unrecognized)",
    };
  }
}

export function stewardshipDiagnostic(error: unknown, seat: StewardshipDiagnostic["seat"], stage: StewardshipDiagnostic["stage"]): StewardshipDiagnostic {
  return { seat, ...(error instanceof StewardshipAssessmentError ? error.detail : { stage, code: "refused" as const, field: "$" }) };
}
