import { nanoid } from 'nanoid';

/**
 * Attaches a stable request id to each request for correlation across logs (§26).
 * Honors an inbound X-Request-Id (e.g. from Nginx) when present.
 */
export function requestId(req, res, next) {
  const id = req.headers['x-request-id'] || nanoid(16);
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

export default requestId;
