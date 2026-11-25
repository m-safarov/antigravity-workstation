import { handleCommitSuggestRequest } from '../proxy-core.mjs';

function readNodeBody(req, maxBytes = 16 * 1024) {
  if (typeof req.body === 'string') return Promise.resolve(req.body);
  if (req.body && typeof req.body === 'object') return Promise.resolve(JSON.stringify(req.body));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total <= maxBytes) chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  const url = new URL(req.url || '/suggest', 'http://localhost');
  const bodyText = req.method === 'POST' ? await readNodeBody(req) : '';
  const forwarded = String(req.headers?.['x-forwarded-for'] || '');
  const clientIp = forwarded.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  const result = await handleCommitSuggestRequest({
    method: req.method,
    pathname: url.pathname,
    headers: req.headers,
    bodyText,
    clientIp,
    env: process.env,
    fetchImpl: globalThis.fetch,
  });
  for (const [k, v] of Object.entries(result.headers)) {
    res.setHeader(k, v);
  }
  res.statusCode = result.status;
  res.end(result.body);
}
