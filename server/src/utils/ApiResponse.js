/**
 * Standardized API response envelope (§24).
 * Success: { success: true, data, meta? }
 * Error:   { success: false, error: { code, message, details? }, requestId }
 */
export function sendSuccess(res, data = null, { status = 200, meta } = {}) {
  const body = { success: true, data };
  if (meta) body.meta = meta;
  return res.status(status).json(body);
}

export function sendError(res, { status = 500, code = 'INTERNAL_ERROR', message, details, requestId }) {
  const error = { code, message };
  if (details) error.details = details;
  const body = { success: false, error };
  if (requestId) body.requestId = requestId;
  return res.status(status).json(body);
}
