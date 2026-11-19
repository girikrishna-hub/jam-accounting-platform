/**
 * The workspace runtime reports action failures with generic codes. The executor port records
 * the server's own message here, so panels can show the user what actually went wrong
 * (for example, the line numbers of a bad import file).
 */
export interface ActionFeedback {
  readonly ok: boolean;
  readonly message?: string;
  readonly details?: unknown;
  readonly result?: unknown;
}

const latest = new Map<string, ActionFeedback>();

export function recordFeedback(idempotencyKey: string, feedback: ActionFeedback): void {
  latest.set(idempotencyKey, feedback);
  if (latest.size > 50) latest.delete(latest.keys().next().value!);
}

export function takeFeedback(idempotencyKey: string): ActionFeedback | undefined {
  const value = latest.get(idempotencyKey);
  latest.delete(idempotencyKey);
  return value;
}
