/**
 * Explicit orchestration claims.
 *
 * A claim is identity: an orchestrator that starts an explorer or fixer agent
 * states, in the same synchronous call that captures the result, which task and
 * role the result belongs to. Pane metadata, state labels, workspace/tab/pane
 * ids, session ids, timestamps, and prompt text are never identity sources, so
 * nothing here derives a claim from them.
 */

/** The role a claimed result was captured for. */
export type OrchestrationRole = "explorer" | "fixer";

/** Every accepted role, in the order the capture protocol advertises them. */
export const ORCHESTRATION_ROLES: readonly OrchestrationRole[] = ["explorer", "fixer"];

/** One explicit claim: the task id, its display label, and the agent's role. */
export interface OrchestrationClaim {
  id: string;
  label: string;
  role: OrchestrationRole;
}

/**
 * Longest accepted label, counted in code points so a Unicode label is never
 * rejected for the byte length of its characters.
 */
export const MAX_ORCHESTRATION_LABEL_CODE_POINTS = 256;

/**
 * Canonical lowercase UUIDv4. Prefix-style tokens such as `orch_7f3a` are
 * deliberately rejected: only the explicit claim is authoritative identity, and
 * a loose id format would make a label or pane token look claimable.
 */
const ORCHESTRATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Exact, case-sensitive role check: `Explorer` is not `explorer`. */
export function isOrchestrationRole(value: unknown): value is OrchestrationRole {
  return value === "explorer" || value === "fixer";
}

/** Canonical UUIDv4 only, with no `orch_` prefix. */
export function isOrchestrationId(value: unknown): value is string {
  return typeof value === "string" && ORCHESTRATION_ID_PATTERN.test(value);
}

/**
 * A label is valid when it is non-blank after trimming and at most
 * {@link MAX_ORCHESTRATION_LABEL_CODE_POINTS} code points. The value itself is
 * preserved exactly as given, whitespace and Unicode included.
 */
export function isOrchestrationLabel(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  return [...value].length <= MAX_ORCHESTRATION_LABEL_CODE_POINTS;
}
