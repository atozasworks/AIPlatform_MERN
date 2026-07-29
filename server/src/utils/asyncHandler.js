/**
 * Wraps an async Express handler so rejected promises are forwarded to the
 * centralized error middleware. Ensures no async error goes unhandled (§31).
 */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export default asyncHandler;
