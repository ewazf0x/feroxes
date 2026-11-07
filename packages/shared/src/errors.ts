/**
 * Base error with a stable machine-readable code. The API layer maps codes to HTTP statuses,
 * and logs/audit entries record the code rather than parsing messages.
 */
export class FeroxesError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FeroxesError';
    this.code = code;
    this.details = details;
  }
}

export class AbortedError extends FeroxesError {
  constructor(reason = 'aborted') {
    super('aborted', `Operation aborted: ${reason}`, { reason });
    this.name = 'AbortedError';
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof AbortedError) return true;
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
