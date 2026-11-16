/** The contract's error shape and status mapping (api/README.md section 2). */
export type ErrorCode =
  | 'invalid_parameter'
  | 'invalid_cursor'
  | 'not_found'
  | 'rate_limited'
  | 'not_ready'
  | 'upstream_unavailable'
  | 'internal';

export type NotFoundReason =
  'unknown_route' | 'unknown_coin' | 'not_listed' | 'not_pump_fun' | 'unknown_narrative';

const STATUS: Record<ErrorCode, 400 | 404 | 429 | 500 | 503> = {
  invalid_parameter: 400,
  invalid_cursor: 400,
  not_found: 404,
  rate_limited: 429,
  not_ready: 503,
  upstream_unavailable: 503,
  internal: 500,
};

export interface ErrorBody {
  error: { code: ErrorCode; message: string; param: string | null; reason: NotFoundReason | null };
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly param: string | null;
  readonly reason: NotFoundReason | null;
  readonly headers: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      param?: string;
      reason?: NotFoundReason;
      headers?: Record<string, string>;
    } = {},
  ) {
    super(message);
    this.code = code;
    this.param = options.param ?? null;
    this.reason = options.reason ?? null;
    this.headers = options.headers ?? {};
  }

  get status(): 400 | 404 | 429 | 500 | 503 {
    return STATUS[this.code];
  }

  body(): ErrorBody {
    return {
      error: { code: this.code, message: this.message, param: this.param, reason: this.reason },
    };
  }
}

export const invalidParameter = (param: string, message: string) =>
  new ApiError('invalid_parameter', message, { param });

export const notFound = (reason: NotFoundReason, message: string) =>
  new ApiError('not_found', message, { reason });
