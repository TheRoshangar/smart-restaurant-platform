/**
 * Errors (Part C: "validation at the boundary, and errors that fail closed")
 *
 * Two rules:
 *
 * 1. Fail closed. An unrecognised error is a 500 with an opaque body and a full
 *    server-side log. Nothing reaches the client that was not deliberately put
 *    in an AppError — no driver messages, no constraint names, no stack.
 *
 * 2. A 409 is not a dead end. Every conflict response carries the *current*
 *    state of the thing that conflicted, because the client's next move is to
 *    re-render, and making it issue another round trip over an unreliable
 *    connection to find out what happened is how you get a stuck waiter.
 */

export type ErrorCode =
  | 'validation_failed'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'stale_version'
  | 'order_not_open'
  | 'table_occupied'
  | 'idempotency_mismatch'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  stale_version: 409,
  order_not_open: 409,
  table_occupied: 409,
  idempotency_mismatch: 409,
  rate_limited: 429,
  provider_unavailable: 503,
  internal: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Persian message, safe to show a waiter mid-shift. */
  readonly messageFa: string;
  /** Current server-side state, so a 409 is actionable without a second request. */
  readonly current?: unknown;

  constructor(code: ErrorCode, messageFa: string, opts: { current?: unknown; cause?: unknown } = {}) {
    super(`${code}: ${messageFa}`);
    this.code = code;
    this.status = STATUS[code];
    this.messageFa = messageFa;
    this.current = opts.current;
    if (opts.cause) this.cause = opts.cause;
  }
}

export const errors = {
  validation: (messageFa = 'اطلاعات ارسالی معتبر نیست.', detail?: unknown) =>
    new AppError('validation_failed', messageFa, { current: detail }),

  unauthenticated: () => new AppError('unauthenticated', 'ابتدا وارد شوید.'),

  forbidden: (messageFa = 'شما اجازه انجام این کار را ندارید.') =>
    new AppError('forbidden', messageFa),

  notFound: (what = 'مورد') => new AppError('not_found', `${what} یافت نشد.`),

  /** Someone else moved this line first. `current` carries where it actually is now. */
  lineMoved: (current: unknown) =>
    new AppError('conflict', 'وضعیت این آیتم توسط شخص دیگری تغییر کرده است.', { current }),

  staleVersion: (current: unknown) =>
    new AppError('stale_version', 'این فاکتور در این فاصله تغییر کرده است. لطفاً دوباره بررسی کنید.', {
      current,
    }),

  /** The bill was settled while someone was still adding to it. */
  orderNotOpen: (current: unknown) =>
    new AppError('order_not_open', 'این فاکتور بسته شده است و قابل تغییر نیست.', { current }),

  tableOccupied: (current: unknown) =>
    new AppError('table_occupied', 'برای این میز فاکتور بازی وجود دارد.', { current }),

  idempotencyMismatch: () =>
    new AppError(
      'idempotency_mismatch',
      'این درخواست قبلاً با محتوای متفاوتی ثبت شده است.',
    ),

  rateLimited: () => new AppError('rate_limited', 'تعداد تلاش‌ها بیش از حد مجاز است. کمی صبر کنید.'),

  providerUnavailable: () =>
    new AppError('provider_unavailable', 'سرویس هوشمند در دسترس نیست. می‌توانید دستی وارد کنید.'),
};

export interface ErrorBody {
  error: { code: ErrorCode; message_fa: string; current?: unknown; request_id?: string };
}

export function toErrorBody(err: AppError, requestId?: string): ErrorBody {
  return {
    error: {
      code: err.code,
      message_fa: err.messageFa,
      ...(err.current !== undefined ? { current: err.current } : {}),
      ...(requestId ? { request_id: requestId } : {}),
    },
  };
}
