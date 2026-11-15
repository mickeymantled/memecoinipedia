import { BudgetExceededError } from '../sources/budget.js';
import { CodexGraphQLError, CodexResponseError } from '../sources/codex/client.js';
import { HttpError } from '../sources/http.js';

export interface CandleFailure {
  /** A short machine-readable reason. */
  reason: string;
  /** Whether trying the same coin again later can work. */
  retry: boolean;
  /** Human-readable, free of keys and headers. */
  message: string;
}

/**
 * Maps an error from the Codex.io client to a failure result, or null when the
 * error is not an expected provider failure (a bug or a database error), which
 * the caller should rethrow.
 *
 * - Network errors, 429 and 5xx (the client already retried them): `retry`.
 * - 401 and 403 (bad key), 402 (quota or billing): no retry until fixed.
 * - Budget ceiling reached: no retry with this budget.
 * - A response that is not JSON or not the expected shape: `retry`.
 * - A GraphQL error: no retry, except one that mentions a rate limit.
 */
export function classifyProviderError(err: unknown): CandleFailure | null {
  if (err instanceof BudgetExceededError) {
    return { reason: 'budget_exhausted', retry: false, message: err.message };
  }
  if (err instanceof HttpError) {
    const s = err.status;
    if (s === null || s === 429 || s >= 500) {
      return { reason: 'provider_unavailable', retry: true, message: err.message };
    }
    if (s === 401 || s === 403) {
      return { reason: 'provider_auth', retry: false, message: err.message };
    }
    if (s === 402) return { reason: 'provider_quota', retry: false, message: err.message };
    return { reason: 'provider_rejected', retry: false, message: err.message };
  }
  if (err instanceof CodexResponseError) {
    return { reason: 'bad_response', retry: true, message: err.message };
  }
  if (err instanceof CodexGraphQLError) {
    const limited = /rate|limit|quota|throttl/i.test(err.message);
    return { reason: 'provider_error', retry: limited, message: err.message };
  }
  if (err instanceof TypeError && /base58/.test(err.message)) {
    return { reason: 'invalid_address', retry: false, message: err.message };
  }
  return null;
}
