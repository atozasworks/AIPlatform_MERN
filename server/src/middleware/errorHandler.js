import { AppError } from '../utils/AppError.js';
import { sendError } from '../utils/ApiResponse.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';

/** 404 handler for unmatched routes. */
export function notFoundHandler(req, _res, next) {
  next(AppError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

/**
 * Centralized error handler (§24, §31).
 * Normalizes Mongoose / JWT / operational errors into the standard envelope
 * and never leaks stack traces or internals in production.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let status = err.statusCode || 500;
  let code = err.code || 'INTERNAL_ERROR';
  let message = err.message || 'Something went wrong';
  let details = err.details;

  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    status = 400;
    code = 'BAD_REQUEST';
    message = `Invalid value for "${err.path}"`;
  }
  // Mongoose validation
  if (err.name === 'ValidationError') {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Validation failed';
    details = Object.values(err.errors).map((e) => ({ path: e.path, message: e.message }));
  }
  // Duplicate key
  if (err.code === 11000) {
    status = 409;
    code = 'CONFLICT';
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    message = `A record with that ${field} already exists`;
  }
  // JWT
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    status = 401;
    code = 'UNAUTHORIZED';
    message = 'Invalid or expired token';
  }

  const isServerError = status >= 500;
  const logPayload = { err, requestId: req.id, status, code };
  if (isServerError) logger.error(logPayload, message);
  else logger.warn(logPayload, message);

  // Hide internal messages for unexpected server errors in production.
  if (isServerError && env.isProd && !(err instanceof AppError)) {
    message = 'Internal server error';
    details = undefined;
  }

  return sendError(res, { status, code, message, details, requestId: req.id });
}
