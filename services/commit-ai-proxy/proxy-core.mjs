const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_BODY_BYTES = 14 * 1024;
const MAX_PROMPT_CHARS = 5500;
const MAX_OUTPUT_TOKENS = 64;
const MAX_SUGGESTION_LEN = 72;
const DEFAULT_RATE_LIMIT_PER_MIN = 20;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_TRACKED_IPS = 2000;

const SYSTEM_PROMPT = [
  'Write ONE concise conventional commit subject line (<=72 chars, e.g. feat(scope): summary or fix(scope): summary)',
  'strictly describing the provided changed files and diff excerpt.',
  'Plain text only: no markdown, no code fences, no quotes, no extra lines, no fabrication.',
].join(' ');

export function redactSecrets(text, knownSecrets = []) {
  let result = String(text ?? '');
  for (const secret of knownSecrets) {
    if (typeof secret === 'string' && secret.trim().length >= 6) {
      result = result.split(secret.trim()).join('[REDACTED]');
    }
  }
  return result
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:key|api[_-]?key|token|secret)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9_.~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/((?:token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:AQ\.[A-Za-z0-9._-]{12,}|AIza[0-9A-Za-z_-]{20,}|gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,})\b/g, '[REDACTED]')
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
}

export function cleanCommitLine(raw) {
  if (typeof raw !== 'string') return '';
  const firstLine = raw
    .replace(/^```[^\n]*\n?/, '')
    .replace(/```$/, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) || '';
  const stripped = firstLine.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!stripped || stripped.length < 4) return '';
  return stripped.length > MAX_SUGGESTION_LEN ? stripped.slice(0, MAX_SUGGESTION_LEN - 1).trimEnd() : stripped;
}

export function createRateLimiter(defaultLimit = DEFAULT_RATE_LIMIT_PER_MIN) {
  const buckets = new Map();
  return function checkLimit(ip, now = Date.now(), overrideLimit = null) {
    const key = String(ip || 'unknown').slice(0, 64);
    const maxReq = Math.max(1, Number(overrideLimit) || Number(defaultLimit) || DEFAULT_RATE_LIMIT_PER_MIN);
    if (buckets.size > MAX_TRACKED_IPS) {
      for (const [k, stamps] of buckets.entries()) {
        if (!stamps.some(ts => now - ts < RATE_WINDOW_MS)) buckets.delete(k);
      }
      if (buckets.size > MAX_TRACKED_IPS) buckets.clear();
    }
    const recent = (buckets.get(key) || []).filter(ts => now - ts < RATE_WINDOW_MS);
    if (recent.length >= maxReq) {
      buckets.set(key, recent);
      return { allowed: false, remaining: 0 };
    }
    recent.push(now);
    buckets.set(key, recent);
    return { allowed: true, remaining: maxReq - recent.length };
  };
}

function constantTimeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

function getHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? String(v[0] || '') : String(v || '');
  }
  return '';
}

const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Workstation-Client',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
});

function jsonResult(status, body) {
  return { status, headers: { ...CORS_HEADERS }, body: JSON.stringify(body) };
}

const defaultRateLimiter = createRateLimiter(DEFAULT_RATE_LIMIT_PER_MIN);

export async function handleCommitSuggestRequest({
  method = 'POST',
  pathname = '/suggest',
  headers = {},
  bodyText = '',
  clientIp = 'unknown',
  env = {},
  fetchImpl = globalThis.fetch,
  rateLimiter = null,
} = {}) {
  const upperMethod = String(method || 'GET').toUpperCase();
  if (upperMethod === 'OPTIONS') {
    return { status: 204, headers: { ...CORS_HEADERS }, body: '' };
  }

  const model = String(env.GEMINI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  if (upperMethod === 'GET' && (pathname === '/health' || pathname === '/api/health' || pathname === '/')) {
    return jsonResult(200, {
      ok: true,
      service: 'workstation-commit-ai-proxy',
      model,
      configured: Boolean(String(env.GEMINI_API_KEY || '').trim()),
    });
  }

  if (upperMethod !== 'POST') {
    return jsonResult(405, { ok: false, error: 'Method not allowed. Use POST /suggest.' });
  }

  const requiredClientToken = String(env.CLIENT_HEADER_TOKEN || '').trim();
  if (requiredClientToken) {
    const provided = getHeader(headers, 'x-workstation-client').trim();
    if (!provided || !constantTimeEqual(provided, requiredClientToken)) {
      return jsonResult(401, { ok: false, error: 'Unauthorized client.' });
    }
  }

  const envLimit = Number(env.RATE_LIMIT_PER_MIN);
  const limitCap = Number.isFinite(envLimit) && envLimit > 0 ? envLimit : null;
  const limiter = rateLimiter || defaultRateLimiter;
  const limitStatus = limiter(clientIp, Date.now(), limitCap);
  if (!limitStatus.allowed) {
    return jsonResult(429, { ok: false, error: 'Rate limit exceeded. Please wait a minute and retry.' });
  }

  const apiKey = String(env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    return jsonResult(503, { ok: false, error: 'Proxy server API key is not configured.' });
  }

  const rawBody = String(bodyText || '');
  if (rawBody.length > MAX_BODY_BYTES) {
    return jsonResult(413, { ok: false, error: 'Request payload is too large.' });
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody || '{}');
  } catch {
    return jsonResult(400, { ok: false, error: 'Request body must be valid JSON.' });
  }

  const userPrompt = redactSecrets(String(parsed?.userPrompt || '').trim(), [apiKey]).slice(0, MAX_PROMPT_CHARS);
  if (userPrompt.length < 4) {
    return jsonResult(400, { ok: false, error: 'Missing commit diff prompt.' });
  }

  const maxTokens = Math.max(8, Math.min(Number(parsed?.maxTokens) || MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS));
  const baseUrl = String(env.GEMINI_ENDPOINT || DEFAULT_GEMINI_BASE).trim().replace(/\/+$/, '');
  const modelPath = model.startsWith('models/') ? model.slice('models/'.length) : model;
  const upstreamUrl = `${baseUrl}/models/${encodeURIComponent(modelPath)}:generateContent`;

  let upstreamRes;
  try {
    upstreamRes = await fetchImpl(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0 },
      }),
    });
  } catch (error) {
    const safeMsg = redactSecrets(error?.message || 'Upstream network error', [apiKey]).slice(0, 160);
    return jsonResult(502, { ok: false, error: `Upstream AI request failed: ${safeMsg}` });
  }

  const rawUpstreamText = await upstreamRes.text();
  if (!upstreamRes.ok) {
    const safeStatus = Number(upstreamRes.status) || 502;
    const mappedStatus = safeStatus === 429 ? 429 : 502;
    return jsonResult(mappedStatus, {
      ok: false,
      error: safeStatus === 429
        ? 'Upstream AI quota temporarily reached.'
        : `Upstream AI service returned HTTP ${safeStatus}.`,
    });
  }

  let upstreamJson;
  try {
    upstreamJson = JSON.parse(rawUpstreamText || '{}');
  } catch {
    return jsonResult(502, { ok: false, error: 'Upstream AI returned invalid JSON.' });
  }

  const parts = upstreamJson?.candidates?.[0]?.content?.parts;
  const rawText = Array.isArray(parts)
    ? parts.map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
    : '';
  const suggestion = cleanCommitLine(redactSecrets(rawText, [apiKey]));
  if (!suggestion) {
    return jsonResult(502, { ok: false, error: 'Upstream AI returned an empty suggestion.' });
  }

  return jsonResult(200, { ok: true, text: suggestion, model });
}
