import { describe, expect, it } from 'vitest';
import { classifyProviderError } from '../../src/candles/errors.js';
import { BudgetExceededError } from '../../src/sources/budget.js';
import { CodexGraphQLError, CodexResponseError } from '../../src/sources/codex/client.js';
import { HttpError } from '../../src/sources/http.js';

describe('classifyProviderError', () => {
  it.each([
    [new HttpError('HTTP 503 from graph.codex.io', 503, 3), 'provider_unavailable', true],
    [new HttpError('HTTP 429 from graph.codex.io', 429, 3), 'provider_unavailable', true],
    [new HttpError('network error calling graph.codex.io', null, 3), 'provider_unavailable', true],
    [new HttpError('HTTP 401 from graph.codex.io', 401, 1), 'provider_auth', false],
    [new HttpError('HTTP 403 from graph.codex.io', 403, 1), 'provider_auth', false],
    [new HttpError('HTTP 402 from graph.codex.io', 402, 1), 'provider_quota', false],
    [new HttpError('HTTP 400 from graph.codex.io', 400, 1), 'provider_rejected', false],
    [new BudgetExceededError('codex', 90, 4, 92), 'budget_exhausted', false],
    [new CodexResponseError('bars', ['t: Required']), 'bad_response', true],
    [new CodexGraphQLError(['Rate limit exceeded'], []), 'provider_error', true],
    [new CodexGraphQLError(['Field "x" not found'], []), 'provider_error', false],
    [new TypeError('mint is not a base58 Solana address'), 'invalid_address', false],
  ])('%s', (err, reason, retry) => {
    expect(classifyProviderError(err)).toMatchObject({ reason, retry });
  });

  it('leaves other errors to the caller', () => {
    expect(classifyProviderError(new Error('connection to database lost'))).toBeNull();
    expect(classifyProviderError(new TypeError('x is undefined'))).toBeNull();
    expect(classifyProviderError('nope')).toBeNull();
  });
});
