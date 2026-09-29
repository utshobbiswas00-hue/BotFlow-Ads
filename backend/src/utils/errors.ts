import { ERROR_CODES } from '../config/constants';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode = 400,
    code: string = ERROR_CODES.VALIDATION_ERROR,
    details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: unknown) {
    super(message, 422, ERROR_CODES.VALIDATION_ERROR, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', details?: unknown) {
    super(message, 401, ERROR_CODES.UNAUTHORIZED, details);
  }
}

export class InvalidTelegramAuthError extends AppError {
  constructor(message = 'Invalid Telegram authentication data', details?: unknown) {
    super(message, 401, ERROR_CODES.INVALID_TELEGRAM_AUTH, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do this', details?: unknown) {
    super(message, 403, ERROR_CODES.FORBIDDEN, details);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource', details?: unknown) {
    super(`${resource} not found`, 404, ERROR_CODES.NOT_FOUND, details);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists', details?: unknown) {
    super(message, 409, ERROR_CODES.CONFLICT, details);
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests, please slow down', retryAfterSeconds = 60, details?: unknown) {
    super(message, 429, ERROR_CODES.RATE_LIMITED, { retryAfterSeconds, ...((details as object) ?? {}) });
  }
}

export class InsufficientBalanceError extends AppError {
  constructor(
    message = 'Insufficient available balance',
    details?: { requiredCents: number; availableCents: number },
  ) {
    super(message, 400, ERROR_CODES.INSUFFICIENT_BALANCE, details);
  }
}

export class BotPermissionError extends AppError {
  constructor(message = 'BotFlow Bot is missing required permissions in this channel', details?: unknown) {
    super(message, 400, ERROR_CODES.BOT_PERMISSION_MISSING, details);
  }
}

export class ChannelNotEligibleError extends AppError {
  constructor(message = 'This channel is not eligible for ad delivery', details?: unknown) {
    super(message, 400, ERROR_CODES.CHANNEL_NOT_ELIGIBLE, details);
  }
}

export class MaintenanceError extends AppError {
  constructor(message = 'BotFlow Ads is temporarily under maintenance.', details?: unknown) {
    super(message, 503, ERROR_CODES.MAINTENANCE, details);
  }
}

export class DuplicatePaymentError extends AppError {
  constructor(message = 'This payment has already been processed', details?: unknown) {
    super(message, 409, ERROR_CODES.PAYMENT_DUPLICATE, details);
  }
}

export class InternalError extends AppError {
  constructor(message = 'Something went wrong on our side', details?: unknown) {
    super(message, 500, ERROR_CODES.INTERNAL_ERROR, details);
    (this as { isOperational: boolean }).isOperational = false;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
