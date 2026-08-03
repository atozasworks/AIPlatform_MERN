import { asyncHandler } from '../utils/asyncHandler.js';
import { readinessReport } from '../services/health/probes.js';

/**
 * GET /api/health/live
 *
 * Liveness only: the event loop is turning and the process can answer HTTP.
 * It deliberately touches no dependency — if this returned 503 because Redis
 * blipped, systemd/PM2 would restart a perfectly healthy API process and turn
 * a partial outage into a full one.
 */
export const live = (_req, res) =>
  res.status(200).json({
    success: true,
    data: { status: 'live', uptimeSeconds: Math.round(process.uptime()), pid: process.pid },
  });

/**
 * GET /api/health/ready
 *
 * Readiness: every dependency needed to serve a chat request is usable.
 * Returns 503 when not ready so a load balancer stops sending traffic here.
 */
export const ready = asyncHandler(async (_req, res) => {
  const report = await readinessReport();
  return res.status(report.ready ? 200 : 503).json({ success: report.ready, data: report });
});

export default { live, ready };
