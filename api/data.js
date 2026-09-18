import { Redis } from '@upstash/redis';

let redis;
function getRedis(){
  if (!redis) redis = Redis.fromEnv();
  return redis;
}

function isAuthorized(req){
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return token && process.env.SHARED_TOKEN && token === process.env.SHARED_TOKEN;
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Not authorized.' });
  }

  const { key } = req.query;

  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: 'Missing "key" query parameter' });
  }

  try {
    const redis = getRedis();

    if (req.method === 'GET') {
      const value = await redis.get(key);
      return res.status(200).json({ value: value === undefined ? null : value });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const value = body ? body.value : undefined;
      await redis.set(key, value);
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      await redis.del(key);
      return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: 'Storage error', detail: String(err) });
  }
}
