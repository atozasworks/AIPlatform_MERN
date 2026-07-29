/**
 * Operational application error carrying an HTTP status and machine-readable code.
 * Non-operational errors (bugs) are handled separately by the error middleware.
 */
export class AppError extends Error {
  constructor(statusCode, message, { code, details } = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code || httpCodeFor(statusCode);
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message, opts) {
    return new AppError(400, message, { code: 'BAD_REQUEST', ...opts });
  }
  static unauthorized(message = 'Authentication required', opts) {
    return new AppError(401, message, { code: 'UNAUTHORIZED', ...opts });
  }
  static forbidden(message = 'You do not have access to this resource', opts) {
    return new AppError(403, message, { code: 'FORBIDDEN', ...opts });
  }
  static notFound(message = 'Resource not found', opts) {
    return new AppError(404, message, { code: 'NOT_FOUND', ...opts });
  }
  static conflict(message, opts) {
    return new AppError(409, message, { code: 'CONFLICT', ...opts });
  }
  static tooMany(message = 'Too many requests', opts) {
    return new AppError(429, message, { code: 'RATE_LIMITED', ...opts });
  }
}

function httpCodeFor(status) {
  const map = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    429: 'RATE_LIMITED',
    500: 'INTERNAL_ERROR',
  };
  return map[status] || 'ERROR';
}

export default AppError;
