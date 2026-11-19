/** A business rule refused the request; shown to the user as a 422 with this message. */
export class BusinessRuleError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'BusinessRuleError';
  }
}
