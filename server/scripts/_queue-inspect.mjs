import { Queue } from 'bullmq';
import { getQueueConnection, getRedis, key, closeRedis } from '../src/config/redis.js';
import { LLM_QUEUE_NAME } from '../src/services/queue/llmQueue.js';

const queue = new Queue(LLM_QUEUE_NAME, { connection: getQueueConnection() });

const counts = await queue.getJobCounts();
console.log('counts:', JSON.stringify(counts));

const active = await queue.getJobs(['active'], 0, 20);
const now = Date.now();
for (const job of active) {
  const ageMs = now - (job.processedOn ?? job.timestamp ?? now);
  console.log(
    `ACTIVE ${job.id} | ageMs=${ageMs} (${Math.round(ageMs / 60000)}min) | attempts=${job.attemptsMade}`,
  );
}

const waiting = await queue.getJobs(['wait', 'delayed'], 0, 20);
for (const job of waiting) console.log(`WAITING ${job.id}`);

const redis = getRedis();
let cursor = '0';
const slots = [];
do {
  const [next, batch] = await redis.scan(cursor, 'MATCH', key('active', '*'), 'COUNT', 200);
  cursor = next;
  slots.push(...batch);
} while (cursor !== '0');
for (const k of slots) console.log(`SLOT ${k} -> [${(await redis.smembers(k)).join(', ')}]`);
if (!slots.length) console.log('SLOT none');

await queue.close();
await closeRedis();
process.exit(0);
