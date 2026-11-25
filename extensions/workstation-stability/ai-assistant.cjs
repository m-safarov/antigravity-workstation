'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');

const SECRET_KEY = 'workstationStability.aiApiKey';
const DEFAULT_PROVIDER = 'gemini';
const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const ALLOWED_PROVIDERS = new Set(['gemini', 'openai-compatible']);
// SHA-256 of the documented README placeholder value (unwrapped from optional [...]).
const PLACEHOLDER_KEY_SHA256 = 'd60d2e1944677c592222013c0a49146c6e0891ec3384b866810598816f0f14c7';

function normalizeSecretInput(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function unwrapPlaceholderCandidate(value) {
  const trimmed = normalizeSecretInput(value);
  if (trimmed.startsWith('[') && trimmed.endsWith(']') && trimmed.length > 2) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isPlaceholderApiKey(value) {
  const candidate = unwrapPlaceholderCandidate(value);
  if (!candidate) return false;
  if (/^<[^>]+>$/.test(candidate) || /^YOUR_[A-Z0-9_]+$/i.test(candidate)) return true;
  const digest = crypto.createHash('sha256').update(candidate, 'utf8').digest('hex');
  return digest === PLACEHOLDER_KEY_SHA256;
}

function isUsableApiKey(value) {
  const trimmed = normalizeSecretInput(value);
  if (!trimmed || isPlaceholderApiKey(trimmed)) return false;
  return true;
}

function redactSecrets(text, knownSecrets = [], maxLength = 512) {
  let result = String(text ?? '');
  for (const secret of knownSecrets) {
    if (typeof secret === 'string' && secret.trim().length >= 6) {
      result = result.split(secret.trim()).join('[REDACTED]');
    }
  }
  result = result
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:key|api[_-]?key|token|secret)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9_.~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/((?<![\w-])["']?[\w-]*(?:token|secret|password|api[_-]?key|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:AQ\.[A-Za-z0-9._-]{12,}|AIza[0-9A-Za-z_-]{20,}|gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,})\b/g, '[REDACTED]');
  return result.length > maxLength ? result.slice(0, maxLength) + '...' : result;
}

function validateEndpoint(rawEndpoint) {
  const value = typeof rawEndpoint === 'string' && rawEndpoint.trim() ? rawEndpoint.trim() : DEFAULT_ENDPOINT;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { valid: false, reason: 'Invalid AI endpoint URL.' };
  }
  if (parsed.username || parsed.password) {
    return { valid: false, reason: 'AI endpoint URL must not contain embedded credentials.' };
  }
  const isHttps = parsed.protocol === 'https:';
  const isLocalHttp = parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1');
  if (!isHttps && !isLocalHttp) {
    return { valid: false, reason: 'AI endpoint must use HTTPS (or http://127.0.0.1 / http://localhost for local testing).' };
  }
  return { valid: true, url: parsed.toString().replace(/\/+$/, ''), parsed };
}

function readAiSettings(vscode) {
  const config = vscode.workspace?.getConfiguration ? vscode.workspace.getConfiguration('workstationStability') : null;
  const enabled = Boolean(config?.get?.('ai.enabled', false));
  const rawProvider = String(config?.get?.('ai.provider', DEFAULT_PROVIDER) || DEFAULT_PROVIDER).trim().toLowerCase();
  const provider = ALLOWED_PROVIDERS.has(rawProvider) ? rawProvider : DEFAULT_PROVIDER;
  const endpoint = String(config?.get?.('ai.endpoint', DEFAULT_ENDPOINT) || DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT;
  const model = String(config?.get?.('ai.model', DEFAULT_MODEL) || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  return { enabled, provider, endpoint, model };
}

function defaultHttpRequest(urlString, options) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const transport = parsed.protocol === 'http:' ? http : https;
    const req = transport.request(parsed, {
      method: options.method || 'POST',
      headers: options.headers || {},
      timeout: options.timeoutMs || 12000,
    }, res => {
      const chunks = [];
      let total = 0;
      const limit = 256 * 1024;
      res.on('data', chunk => {
        total += chunk.length;
        if (total <= limit) chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function buildProviderRequest({ provider, endpoint, model, apiKey, systemPrompt, userPrompt, maxTokens = 16 }) {
  const checked = validateEndpoint(endpoint);
  if (!checked.valid) {
    return { error: checked.reason };
  }
  if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(model)) {
    return { error: 'Invalid AI model identifier.' };
  }
  const safeMaxTokens = Math.max(1, Math.min(Number(maxTokens) || 16, 256));
  if (provider === 'openai-compatible') {
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: String(systemPrompt) });
    messages.push({ role: 'user', content: String(userPrompt || 'ping') });
    const payload = JSON.stringify({
      model,
      messages,
      max_tokens: safeMaxTokens,
      temperature: 0,
    });
    const base = checked.url.endsWith('/chat/completions') ? checked.url : checked.url + '/chat/completions';
    return {
      url: base,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(payload),
      },
      body: payload,
    };
  }
  // Gemini API (key strictly in header x-goog-api-key, never in URL query string).
  const bodyObj = {
    contents: [{ role: 'user', parts: [{ text: String(userPrompt || 'ping') }] }],
    generationConfig: { maxOutputTokens: safeMaxTokens, temperature: 0 },
  };
  if (systemPrompt) {
    bodyObj.systemInstruction = { parts: [{ text: String(systemPrompt) }] };
  }
  const payload = JSON.stringify(bodyObj);
  const modelPath = model.startsWith('models/') ? model.slice('models/'.length) : model;
  return {
    url: `${checked.url}/models/${encodeURIComponent(modelPath)}:generateContent`,
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
      'Content-Length': Buffer.byteLength(payload),
    },
    body: payload,
  };
}

function extractTextFromResponse(provider, parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  if (provider === 'openai-compatible') {
    const content = parsed.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content.trim() : '';
  }
  const parts = parsed.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(part => (typeof part?.text === 'string' ? part.text : '')).join('').trim();
}

function classifyHttpFailure(statusCode, rawBody, apiKey) {
  let detail = '';
  let errorCode = '';
  try {
    const parsed = JSON.parse(rawBody || '{}');
    detail = parsed?.error?.message || parsed?.message || '';
    errorCode = String(parsed?.error?.status || parsed?.error?.code || parsed?.error?.type || '');
  } catch {
    detail = String(rawBody || '').slice(0, 200);
  }
  const combined = `${errorCode} ${detail}`.toLowerCase();
  const safeDetail = redactSecrets(detail || `HTTP ${statusCode}`, [apiKey], 180);

  if (statusCode === 401 || statusCode === 403 || /api[_ ]?key[_ ]?invalid|invalid[_ ]?api[_ ]?key|permission[_ ]?denied|unauthorized|unauthenticated/.test(combined)) {
    return {
      ok: false,
      status: 'rejected_credential',
      httpStatus: statusCode,
      message: `API key rejected (HTTP ${statusCode}): ${safeDetail}`,
    };
  }
  if (statusCode === 404 || (statusCode === 400 && /model|not[_ ]?found|unsupported/.test(combined))) {
    return {
      ok: false,
      status: 'unavailable_model',
      httpStatus: statusCode,
      message: `Configured model is unavailable (HTTP ${statusCode}): ${safeDetail}`,
    };
  }
  return {
    ok: false,
    status: 'connection_failure',
    httpStatus: statusCode,
    message: `AI provider request failed (HTTP ${statusCode}): ${safeDetail}`,
  };
}

async function performProviderCall({ provider, endpoint, model, apiKey, systemPrompt, userPrompt, maxTokens, timeoutMs = 12000, request = defaultHttpRequest }) {
  if (!isUsableApiKey(apiKey)) {
    return {
      ok: false,
      status: 'missing_key',
      message: isPlaceholderApiKey(apiKey)
        ? 'API key is still set to the example placeholder. Run "Workstation: Configure AI API Key" to enter your own key.'
        : 'AI API key is not configured. Run "Workstation: Configure AI API Key" first.',
    };
  }
  const reqSpec = buildProviderRequest({ provider, endpoint, model, apiKey: apiKey.trim(), systemPrompt, userPrompt, maxTokens });
  if (reqSpec.error) {
    return {
      ok: false,
      status: 'connection_failure',
      message: reqSpec.error,
    };
  }
  let response;
  try {
    response = await request(reqSpec.url, {
      method: 'POST',
      headers: reqSpec.headers,
      body: reqSpec.body,
      timeoutMs,
    });
  } catch (error) {
    return {
      ok: false,
      status: 'connection_failure',
      message: 'Connection failed: ' + redactSecrets(error?.message || error?.code || 'network error', [apiKey], 180),
    };
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    return classifyHttpFailure(response.statusCode, response.body, apiKey);
  }
  let parsed;
  try {
    parsed = JSON.parse(response.body || '{}');
  } catch {
    return {
      ok: false,
      status: 'connection_failure',
      httpStatus: response.statusCode,
      message: 'Provider returned an unexpected non-JSON response.',
    };
  }
  return {
    ok: true,
    status: 'ok',
    httpStatus: response.statusCode,
    text: extractTextFromResponse(provider, parsed),
    provider,
    model,
    message: `AI connection verified (${provider} / ${model}).`,
  };
}

async function configureAiApiKey(vscode, context, output) {
  if (!context?.secrets || typeof context.secrets.get !== 'function') {
    const result = { action: 'unavailable', saved: false, message: 'IDE SecretStorage is unavailable in this environment.' };
    await vscode.window.showWarningMessage(result.message);
    return result;
  }
  const existing = await context.secrets.get(SECRET_KEY);
  const hasExisting = isUsableApiKey(existing);
  if (hasExisting) {
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Replace API Key', action: 'replace', description: 'Enter a new masked API key for SecretStorage' },
        { label: 'Clear Saved API Key', action: 'clear', description: 'Remove the stored key from SecretStorage' },
        { label: 'Cancel', action: 'cancel', description: 'Keep the current saved API key unchanged' },
      ],
      { placeHolder: 'An AI API key is already saved in IDE SecretStorage', ignoreFocusOut: true }
    );
    if (!choice || choice.action === 'cancel') {
      return { action: 'cancelled', saved: true };
    }
    if (choice.action === 'clear') {
      await context.secrets.delete(SECRET_KEY);
      output?.appendLine('AI API key cleared from IDE SecretStorage.');
      await vscode.window.showInformationMessage('Saved AI API key cleared from IDE SecretStorage.');
      return { action: 'cleared', saved: false };
    }
  }
  const entered = await vscode.window.showInputBox({
    title: 'Configure AI API Key',
    prompt: 'Paste your personal AI provider API key (stored only in IDE SecretStorage; never written to workspace or Git). Press Escape to cancel.',
    placeHolder: 'Enter API key...',
    password: true,
    ignoreFocusOut: true,
  });
  if (entered === undefined) {
    return { action: 'cancelled', saved: hasExisting };
  }
  const trimmed = normalizeSecretInput(entered);
  if (!trimmed) {
    await vscode.window.showWarningMessage(hasExisting ? 'Empty input ignored; existing API key was preserved.' : 'No API key entered; key remains unset.');
    return { action: 'empty', saved: hasExisting };
  }
  if (isPlaceholderApiKey(trimmed)) {
    const message = 'The example placeholder from README cannot be used as an API key; key remains unchanged.';
    await vscode.window.showWarningMessage(message);
    return { action: 'placeholder_rejected', saved: hasExisting, message };
  }
  await context.secrets.store(SECRET_KEY, trimmed);
  output?.appendLine('AI API key saved to IDE SecretStorage (value redacted).');
  await vscode.window.showInformationMessage('AI API key saved securely in IDE SecretStorage.');
  return { action: hasExisting ? 'replaced' : 'saved', saved: true };
}

async function testAiConnection(vscode, context, output, options = {}) {
  const settings = readAiSettings(vscode);
  const apiKey = context?.secrets?.get ? await context.secrets.get(SECRET_KEY) : '';
  const result = await performProviderCall({
    provider: settings.provider,
    endpoint: settings.endpoint,
    model: settings.model,
    apiKey,
    userPrompt: 'Reply with OK.',
    maxTokens: 4,
    timeoutMs: options.timeoutMs || 12000,
    request: options.request || defaultHttpRequest,
  });
  output?.appendLine('AI connection test: ' + JSON.stringify({
    ok: result.ok,
    status: result.status,
    provider: settings.provider,
    model: settings.model,
    httpStatus: result.httpStatus || null,
    message: result.message,
  }));
  if (result.ok) {
    await vscode.window.showInformationMessage(result.message);
  } else {
    await vscode.window.showWarningMessage(result.message);
  }
  return result;
}

async function generateText(vscode, context, output, payload = {}, options = {}) {
  const settings = readAiSettings(vscode);
  if (!settings.enabled && !options.ignoreEnabled) {
    return { ok: false, status: 'disabled', message: 'Optional local AI assistance is disabled.' };
  }
  const apiKey = context?.secrets?.get ? await context.secrets.get(SECRET_KEY) : '';
  if (!isUsableApiKey(apiKey)) {
    return { ok: false, status: 'missing_key', message: 'AI API key is not configured.' };
  }
  const safeSystem = redactSecrets(payload.systemPrompt || '', [apiKey], 2000);
  const safeUser = redactSecrets(payload.userPrompt || '', [apiKey], 8000);
  const result = await performProviderCall({
    provider: settings.provider,
    endpoint: settings.endpoint,
    model: settings.model,
    apiKey,
    systemPrompt: safeSystem,
    userPrompt: safeUser,
    maxTokens: Math.min(Number(payload.maxTokens) || 96, 256),
    timeoutMs: Math.min(Number(payload.timeoutMs) || options.timeoutMs || 10000, 15000),
    request: options.request || defaultHttpRequest,
  });
  output?.appendLine('AI text request: ' + JSON.stringify({ ok: result.ok, status: result.status, provider: settings.provider, model: settings.model }));
  return result;
}

function registerAiCommands(vscode, context, output, options = {}) {
  context.subscriptions.push(
    vscode.commands.registerCommand('workstationStability.configureAiApiKey', () => configureAiApiKey(vscode, context, output)),
    vscode.commands.registerCommand('workstationStability.testAiConnection', () => testAiConnection(vscode, context, output, options)),
    vscode.commands.registerCommand('workstationStability.generateText', payload => generateText(vscode, context, output, payload, options))
  );
}

module.exports = {
  SECRET_KEY,
  DEFAULT_PROVIDER,
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  PLACEHOLDER_KEY_SHA256,
  isPlaceholderApiKey,
  isUsableApiKey,
  redactSecrets,
  validateEndpoint,
  readAiSettings,
  buildProviderRequest,
  classifyHttpFailure,
  performProviderCall,
  configureAiApiKey,
  testAiConnection,
  generateText,
  registerAiCommands,
};
