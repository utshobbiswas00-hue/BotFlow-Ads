import { AppError } from './errors';
import { ERROR_CODES } from '../config/constants';

/**
 * Error types that belong to the escrow/delivery domain.
 * Kept separate from utils/errors so the escrow module does not depend on
 * the HTTP layer's full error catalogue.
 */

export class BadRequestAppError extends AppError {
  constructor(message = 'Invalid request', details?: unknown) {
    super(message, 400, ERROR_CODES.VALIDATION_ERROR, details);
  }
}

export class DeliveryBlockedError extends AppError {
  constructor(message = 'Delivery blocked by a business rule', details?: unknown) {
    super(message, 409, ERROR_CODES.CONFLICT, details);
  }
}
