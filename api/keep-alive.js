// api/keep-alive.js
// Scheduled by Vercel Cron (see the "crons" entry in vercel.json) to write
// to Redis once a day, so the free-tier Upstash database is never idle
// long enough to be auto-archived. Upstash archives Free databases after
// 14 days with no read/write commands — a daily write keeps it well
// inside that window. Pinging the endpoint alone wouldn't count; Upstash
// only tracks actual data operations (SET, GET, EXPIRE, etc.), which is
// why this does a real SET rather than just opening a connection.
import { Redis } from "@upstash/redis";

export default async function handler(req, res) {
  // Vercel signs cron-triggered requests with this header whenever the
  // CRON_SECRET env var is set, so only Vercel's own scheduler can
  // trigger the write, not a random visitor hitting this URL.
  const auth = req.headers["authorization"];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(500).json({ error: "Upstash env vars not set" });
  }

  try {
    const redis = Redis.fromEnv();
    await redis.set("meridian:keepalive", new Date().toISOString(), {
      ex: 60 * 60 * 24 * 30, // 30 days — plenty of buffer if a single run is ever skipped
    });
    return res.status(200).json({ ok: true, at: new Date().toISOString() });
  } catch (err) {
    console.error("Keep-alive write failed:", err);
    return res.status(500).json({ error: "Keep-alive write failed" });
  }
}
