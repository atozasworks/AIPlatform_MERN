import { AppError } from '../utils/AppError.js';

/**
 * Validates and coerces req.body / req.query / req.params against zod schemas.
 * Replaces the request parts with the parsed (sanitized) values (§21, §24).
 *
 * Usage: router.post('/', validate({ body: schema }), handler)
 */
export function validate(schemas) {
  return (req, _res, next) => {
    try {
      for (const key of ['body', 'query', 'params']) {
        if (schemas[key]) {
          const result = schemas[key].safeParse(req[key]);
          if (!result.success) {
            const details = result.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            }));
            throw AppError.badRequest('Validation failed', { code: 'VALIDATION_ERROR', details });
          }
          req[key] = result.data;
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export default validate;
