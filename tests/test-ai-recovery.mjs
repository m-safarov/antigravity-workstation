import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { handleCommitSuggestRequest, createRateLimiter } from '../services/commit-ai-proxy/proxy-core.mjs';

const require = createRequire(import.meta.url);
const ai = require('../extensions/workstation-stability/ai-assistant.cjs');
const recovery = require('../lib/ai-recovery');

const EXACT_PLACEHOLDER = '[<YOUR_AI_API_KEY>]';

function createMockIde({ settings = {}, inspected = {}, persistedSecrets = new Map(), quickPickQueue = [], inputQueue = [] } = {}) {
  const infoMessages = [];
  const warningMessages = [];
  const outputLines = [];
  const output = { appendLine(line) { outputLines.push(String(line)); } };
  const context = {
    subscriptions: [],
    secrets: {
      async get(key) { return persistedSecrets.get(key); },
      async store(key, value) { persistedSecrets.set(key, value); },
      async delete(key) { persistedSecrets.delete(key); },
    },
  };
  const vscode = {
    workspace: {
      getConfiguration(section) {
        assert.equal(section, 'workstationStability');
        return {
          get(key, fallback) {
            return Object.hasOwn(settings, key) ? settings[key] : fallback;
          },
          inspect(key) {
            return Object.hasOwn(inspected, key) ? inspected[key] : undefined;
          },
        };
      },
    },
    window: {
      async showQuickPick(items) {
        const next = quickPickQueue.shift();
        if (typeof next === 'function') return next(items);
        if (typeof next === 'string') return items.find(item => item.action === next || item.label === next);
        return next;
      },
      async showInputBox(opts) {
        assert.equal(opts.password, true, 'API key input must always be masked');
        return inputQueue.shift();
      },
      async showInformationMessage(msg) { infoMessages.push(msg); },
      async showWarningMessage(msg) { warningMessages.push(msg); },
    },
    commands: {
      registerCommand() { return { dispose() {} }; },
    },
  };
  return { vscode, context, output, infoMessages, warningMessages, outputLines, persistedSecrets };
}

test('Documented README placeholder forms are treated as unset both wrapped and unwrapped', () => {
  assert.equal(ai.isPlaceholderApiKey(EXACT_PLACEHOLDER), true);
  assert.equal(ai.isPlaceholderApiKey(EXACT_PLACEHOLDER.slice(1, -1)), true);
  assert.equal(ai.isPlaceholderApiKey('YOUR_API_KEY'), true);
  assert.equal(ai.isUsableApiKey(EXACT_PLACEHOLDER), false);
  assert.equal(ai.isUsableApiKey('   '), false);
  assert.equal(ai.isUsableApiKey('test-personal-local-key-998877'), true);
  assert.equal(ai.isPlaceholderApiKey('test-personal-local-key-998877'), false);
});

test('Configure AI API Key supports save, persist across restart, cancel preserve, placeholder rejection, replace and clear', async () => {
  const store = new Map();
  const keyA = 'local-dev-key-alpha-123456';
  const keyB = 'local-dev-key-beta-654321';

  // 1. Reject literal placeholder cleanly
  const ide1 = createMockIde({ persistedSecrets: store, inputQueue: [EXACT_PLACEHOLDER] });
  const rPlaceholder = await ai.configureAiApiKey(ide1.vscode, ide1.context, ide1.output);
  assert.equal(rPlaceholder.action, 'placeholder_rejected');
  assert.equal(store.has(ai.SECRET_KEY), false);

  // 2. Cancel when empty leaves unset
  const ide2 = createMockIde({ persistedSecrets: store, inputQueue: [undefined] });
  const rCancelEmpty = await ai.configureAiApiKey(ide2.vscode, ide2.context, ide2.output);
  assert.equal(rCancelEmpty.action, 'cancelled');
  assert.equal(store.has(ai.SECRET_KEY), false);

  // 3. Save masked key in SecretStorage (never logged)
  const ide3 = createMockIde({ persistedSecrets: store, inputQueue: [keyA] });
  const rSave = await ai.configureAiApiKey(ide3.vscode, ide3.context, ide3.output);
  assert.equal(rSave.action, 'saved');
  assert.equal(store.get(ai.SECRET_KEY), keyA);
  assert.equal(ide3.outputLines.join('\n').includes(keyA), false, 'secret must never appear in output channel');
  assert.equal(ide3.infoMessages.join('\n').includes(keyA), false, 'secret must never appear in toast');

  // 4. Simulate IDE restart (fresh context pointing to same SecretStorage): cancel at QuickPick preserves key
  const ideRestartCancel = createMockIde({ persistedSecrets: store, quickPickQueue: [undefined] });
  const rCancelPick = await ai.configureAiApiKey(ideRestartCancel.vscode, ideRestartCancel.context, ideRestartCancel.output);
  assert.equal(rCancelPick.action, 'cancelled');
  assert.equal(store.get(ai.SECRET_KEY), keyA);

  // 5. Replace -> Cancel inside InputBox preserves existing key
  const ideCancelReplace = createMockIde({ persistedSecrets: store, quickPickQueue: ['replace'], inputQueue: [undefined] });
  const rCancelReplace = await ai.configureAiApiKey(ideCancelReplace.vscode, ideCancelReplace.context, ideCancelReplace.output);
  assert.equal(rCancelReplace.action, 'cancelled');
  assert.equal(store.get(ai.SECRET_KEY), keyA);

  // 6. Replace with new valid key updates SecretStorage
  const ideReplace = createMockIde({ persistedSecrets: store, quickPickQueue: ['replace'], inputQueue: [keyB] });
  const rReplace = await ai.configureAiApiKey(ideReplace.vscode, ideReplace.context, ideReplace.output);
  assert.equal(rReplace.action, 'replaced');
  assert.equal(store.get(ai.SECRET_KEY), keyB);

  // 7. Clear removes saved key
  const ideClear = createMockIde({ persistedSecrets: store, quickPickQueue: ['clear'] });
  const rClear = await ai.configureAiApiKey(ideClear.vscode, ideClear.context, ideClear.output);
  assert.equal(rClear.action, 'cleared');
  assert.equal(store.has(ai.SECRET_KEY), false);
});

test('Test AI Connection distinguishes missing_key, rejected_credential, unavailable_model, connection_failure and ok over real loopback HTTP', async (t) => {
  let mode = 'ok';
  let lastRequest = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      lastRequest = { url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      if (mode === 'ok') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }));
      } else if (mode === 'rejected') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'API_KEY_INVALID for key local-secret-xyz-999' } }));
      } else if (mode === 'bad_model') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: 'models/missing-model is not found for API version v1beta' } }));
      } else if (mode === 'server_err') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 503, message: 'Service temporarily unavailable' } }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/v1beta`;
  const apiKey = 'local-secret-xyz-999';

  // 1. Missing key (isolated from host env, user private .env, and default proxy URL)
  const ideMissing = createMockIde({ settings: { 'ai.endpoint': endpoint, 'ai.model': 'gemini-3.5-flash-lite' } });
  const resMissing = await ai.testAiConnection(ideMissing.vscode, ideMissing.context, ideMissing.output, { env: {}, envFile: null, proxyUrl: '' });
  assert.equal(resMissing.ok, false);
  assert.equal(resMissing.status, 'missing_key');

  // 2. Placeholder key treated as missing_key
  const idePlaceholder = createMockIde({
    settings: { 'ai.endpoint': endpoint, 'ai.model': 'gemini-3.5-flash-lite' },
    persistedSecrets: new Map([[ai.SECRET_KEY, EXACT_PLACEHOLDER]]),
  });
  const resPlaceholder = await ai.testAiConnection(idePlaceholder.vscode, idePlaceholder.context, idePlaceholder.output, { env: {}, envFile: null, proxyUrl: '' });
  assert.equal(resPlaceholder.ok, false);
  assert.equal(resPlaceholder.status, 'missing_key');

  // 3. Valid key -> ok, and key is passed via header, NOT URL query string
  mode = 'ok';
  const store = new Map([[ai.SECRET_KEY, apiKey]]);
  const ideOk = createMockIde({ settings: { 'ai.endpoint': endpoint, 'ai.model': 'gemini-3.5-flash-lite' }, persistedSecrets: store });
  const resOk = await ai.testAiConnection(ideOk.vscode, ideOk.context, ideOk.output, { env: {}, envFile: null });
  assert.equal(resOk.ok, true);
  assert.equal(resOk.status, 'ok');
  assert.equal(lastRequest.headers['x-goog-api-key'], apiKey);
  assert.equal(lastRequest.url.includes(apiKey), false, 'API key must not be sent in query string');
  assert.equal(ideOk.outputLines.join('\n').includes(apiKey), false, 'API key must never appear in logs');

  // 4. Rejected credential (401) -> redacted message
  mode = 'rejected';
  const resRejected = await ai.testAiConnection(ideOk.vscode, ideOk.context, ideOk.output, { env: {}, envFile: null });
  assert.equal(resRejected.ok, false);
  assert.equal(resRejected.status, 'rejected_credential');
  assert.equal(resRejected.message.includes(apiKey), false, 'provider error echoing secret must be redacted');

  // 5. Unavailable model (404)
  mode = 'bad_model';
  const ideBadModel = createMockIde({ settings: { 'ai.endpoint': endpoint, 'ai.model': 'missing-model' }, persistedSecrets: store });
  const resBadModel = await ai.testAiConnection(ideBadModel.vscode, ideBadModel.context, ideBadModel.output, { env: {}, envFile: null });
  assert.equal(resBadModel.ok, false);
  assert.equal(resBadModel.status, 'unavailable_model');

  // 6. Connection failure (HTTP 503 + unreachable port)
  mode = 'server_err';
  const res503 = await ai.testAiConnection(ideOk.vscode, ideOk.context, ideOk.output, { env: {}, envFile: null });
  assert.equal(res503.ok, false);
  assert.equal(res503.status, 'connection_failure');

  const ideUnreachable = createMockIde({ settings: { 'ai.endpoint': 'http://127.0.0.1:1/v1beta', 'ai.model': 'gemini-3.5-flash-lite' }, persistedSecrets: store });
  const resConn = await ai.testAiConnection(ideUnreachable.vscode, ideUnreachable.context, ideUnreachable.output, { timeoutMs: 1500, env: {}, envFile: null });
  assert.equal(resConn.ok, false);
  assert.equal(resConn.status, 'connection_failure');

  // 7. Private local .env fallback & allowWhenKeyConfigured for GitHub panel commit suggestions (with explicit disable guard)
  mode = 'ok';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-ai-env-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const envFile = path.join(tmpDir, '.env');
  fs.writeFileSync(envFile, '# private local key\nWORKSTATION_AI_API_KEY="local-env-file-key-778899"\n');
  const ideEnvOnly = createMockIde({ settings: { 'ai.endpoint': endpoint, 'ai.model': 'gemini-3.5-flash-lite' } });
  const resEnvTest = await ai.testAiConnection(ideEnvOnly.vscode, ideEnvOnly.context, ideEnvOnly.output, { env: {}, envFile });
  assert.equal(resEnvTest.ok, true);
  assert.equal(resEnvTest.keySource, 'privateEnvFile');
  assert.equal(lastRequest.headers['x-goog-api-key'], 'local-env-file-key-778899');
  assert.equal(ideEnvOnly.outputLines.join('\n').includes('local-env-file-key-778899'), false, 'env key must never be logged');

  const resCommitAi = await ai.generateText(ideEnvOnly.vscode, ideEnvOnly.context, ideEnvOnly.output,
    { userPrompt: 'Summarize diff', allowWhenKeyConfigured: true }, { env: {}, envFile });
  assert.equal(resCommitAi.ok, true);

  // Explicit user disable in settings must block AI calls even when a private .env key exists.
  const ideDisabled = createMockIde({
    settings: { 'ai.enabled': false, 'ai.endpoint': endpoint, 'ai.model': 'gemini-3.5-flash-lite' },
    inspected: { 'ai.enabled': { globalValue: false } },
  });
  const resBlocked = await ai.generateText(ideDisabled.vscode, ideDisabled.context, ideDisabled.output,
    { userPrompt: 'Summarize diff', allowWhenKeyConfigured: true }, { env: {}, envFile });
  assert.equal(resBlocked.ok, false);
  assert.equal(resBlocked.status, 'disabled');
});

test('Bounded recovery handles transient download, corrupt archive, permanent 404, external terminal without SecretStorage, and rejects unsafe AI proposals', async () => {
  // 1. Deterministic transient download recovery succeeds without invoking AI
  let retries = 0;
  const rDownload = await recovery.runBoundedRecovery(
    { stage: 'download', httpStatus: 503, message: 'HTTP 503 transient failure' },
    {
      executors: { retry_download: async () => { retries++; return { ok: true }; } },
      verify: async () => ({ ok: true }),
      ai: { enabled: true, getApiKey: async () => { throw new Error('AI should not be called when deterministic succeeds'); } },
    }
  );
  assert.equal(rDownload.recovered, true);
  assert.equal(rDownload.usedAi, false);
  assert.equal(retries, 1);

  // 2. Corrupt archive cleans staging and retries deterministically
  let cleaned = 0;
  const rCorrupt = await recovery.runBoundedRecovery(
    { stage: 'extract', code: 'CORRUPT_ARCHIVE', message: 'ZIP checksum mismatch' },
    {
      executors: { clean_staging_and_retry: async () => { cleaned++; return { ok: true }; } },
      verify: async () => ({ ok: true }),
    }
  );
  assert.equal(rCorrupt.recovered, true);
  assert.equal(rCorrupt.usedAi, false);
  assert.equal(cleaned, 1);

  // 3. Permanent HTTP 404 stops immediately without retry loop
  const r404 = await recovery.runBoundedRecovery(
    { stage: 'download', httpStatus: 404, message: 'HTTP 404 Not Found' },
    { executors: { retry_download: async () => { throw new Error('must not retry 404'); } } }
  );
  assert.equal(r404.recovered, false);
  assert.equal(r404.attempts, 1);

  // 4. External terminal without SecretStorage stays cleanly deterministic without exporting secrets
  const rTerminal = await recovery.runBoundedRecovery(
    { stage: 'unknown', code: 'UNUSUAL_LOCK', message: 'Unclassified local setup error' },
    { ai: { enabled: true, getApiKey: null } }
  );
  assert.equal(rTerminal.recovered, false);
  assert.equal(rTerminal.usedAi, false);
  assert.equal(rTerminal.aiStatus, 'no_secret_storage_in_terminal');

  // 5. Unsafe AI proposal proposing free-form shell command is rejected strictly
  const rUnsafe = await recovery.runBoundedRecovery(
    { stage: 'unknown', code: 'UNUSUAL_STATE', message: 'Bearer secret-token-abc123 failed step' },
    {
      ai: {
        enabled: true,
        getApiKey: async () => 'personal-runtime-key-12345',
        request: async (_url, opts) => {
          assert.equal(opts.body.includes('secret-token-abc123'), false, 'diagnostic sent to AI must redact secrets');
          return {
            statusCode: 200,
            body: JSON.stringify({
              candidates: [{ content: { parts: [{ text: '{"action":"retry_download","command":"powershell -c rm -rf /"}' }] } }],
            }),
          };
        },
      },
    }
  );
  assert.equal(rUnsafe.recovered, false);
  assert.equal(rUnsafe.usedAi, true);
  assert.equal(rUnsafe.aiStatus, 'rejected_unsafe_proposal');

  // 6. Valid allowlisted AI proposal executes safe local executor, verifies, and recovers
  let repairedTarget = null;
  const rAllowlisted = await recovery.runBoundedRecovery(
    { stage: 'unknown', code: 'UNUSUAL_STATE', message: 'Unclassified component drift' },
    {
      executors: {
        repair_missing_component: async ({ target }) => { repairedTarget = target; return { ok: true }; },
      },
      verify: async () => ({ ok: true }),
      ai: {
        enabled: true,
        getApiKey: async () => 'personal-runtime-key-12345',
        request: async () => ({
          statusCode: 200,
          body: JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"action":"repair_missing_component","target":"settings.json","reason":"Restore missing settings file"}' }] } }],
          }),
        }),
      },
    }
  );
  assert.equal(rAllowlisted.recovered, true);
  assert.equal(rAllowlisted.usedAi, true);
  assert.equal(rAllowlisted.aiStatus, 'proposal_accepted');
  assert.equal(repairedTarget, 'settings.json');
});

test('Shared commit AI proxy keeps GEMINI_API_KEY strictly server-side, enforces rate limits/redaction, and integrates cleanly with workstationStability.ai.proxyUrl', async (t) => {
  const serverKey = ['AQ', 'ServerOnlySecretKey9988776655'].join('.');
  let lastUpstreamCall = null;
  const mockFetch = async (url, opts) => {
    lastUpstreamCall = { url, headers: opts.headers, body: JSON.parse(opts.body) };
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          candidates: [{ content: { parts: [{ text: '```text\nfeat(auth): add session cookie guard\n```' }] } }],
        });
      },
    };
  };

  // 1. Health endpoint reports status without exposing secret
  const health = await handleCommitSuggestRequest({
    method: 'GET',
    pathname: '/health',
    env: { GEMINI_API_KEY: serverKey, GEMINI_MODEL: 'gemini-3.5-flash-lite' },
    fetchImpl: mockFetch,
  });
  assert.equal(health.status, 200);
  assert.equal(health.body.includes(serverKey), false);
  assert.equal(JSON.parse(health.body).configured, true);

  // 2. Proxy core enforces rate limits, size limits, secret redaction, and commit-only system prompt
  const limiter = createRateLimiter(2);
  const proxyEnv = { GEMINI_API_KEY: serverKey, GEMINI_MODEL: 'gemini-3.5-flash-lite' };
  const clientSecret = 'sk-client-secret-token-1234567890';

  const r1 = await handleCommitSuggestRequest({
    method: 'POST',
    pathname: '/suggest',
    bodyText: JSON.stringify({ userPrompt: `Files:\nM auth.ts\n+const k = "${clientSecret}";`, maxTokens: 500 }),
    clientIp: '198.51.100.10',
    env: proxyEnv,
    fetchImpl: mockFetch,
    rateLimiter: limiter,
  });
  assert.equal(r1.status, 200);
  assert.equal(JSON.parse(r1.body).text, 'feat(auth): add session cookie guard');
  assert.equal(lastUpstreamCall.headers['x-goog-api-key'], serverKey);
  assert.equal(lastUpstreamCall.body.generationConfig.maxOutputTokens, 64, 'proxy must clamp maxOutputTokens to <=64');
  assert.equal(JSON.stringify(lastUpstreamCall.body).includes(clientSecret), false, 'proxy must redact incoming secrets');
  assert.match(lastUpstreamCall.body.systemInstruction.parts[0].text, /conventional commit/i);

  // Second request allowed, third hits 429 rate limit
  const r2 = await handleCommitSuggestRequest({
    method: 'POST', pathname: '/suggest', bodyText: JSON.stringify({ userPrompt: 'Files:\nM a.ts\n+export const x = 1;' }),
    clientIp: '198.51.100.10', env: proxyEnv, fetchImpl: mockFetch, rateLimiter: limiter,
  });
  assert.equal(r2.status, 200);
  const r3 = await handleCommitSuggestRequest({
    method: 'POST', pathname: '/suggest', bodyText: JSON.stringify({ userPrompt: 'Files:\nM a.ts\n+export const x = 2;' }),
    clientIp: '198.51.100.10', env: proxyEnv, fetchImpl: mockFetch, rateLimiter: limiter,
  });
  assert.equal(r3.status, 429);

  // Oversized payload rejected with 413
  const rBig = await handleCommitSuggestRequest({
    method: 'POST', pathname: '/suggest', bodyText: 'x'.repeat(20000),
    clientIp: '198.51.100.11', env: proxyEnv, fetchImpl: mockFetch, rateLimiter: limiter,
  });
  assert.equal(rBig.status, 413);

  // Missing server key returns 503 cleanly
  const rNoKey = await handleCommitSuggestRequest({
    method: 'POST', pathname: '/suggest', bodyText: JSON.stringify({ userPrompt: 'Files:\nM a.ts' }),
    clientIp: '198.51.100.12', env: {}, fetchImpl: mockFetch, rateLimiter: limiter,
  });
  assert.equal(rNoKey.status, 503);

  // 3. Full loopback HTTP integration: client has ZERO API key, only ai.proxyUrl set
  let receivedClientHeaders = null;
  const liveLimiter = createRateLimiter(20);
  const proxyServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      receivedClientHeaders = req.headers;
      const out = await handleCommitSuggestRequest({
        method: req.method,
        pathname: req.url,
        headers: req.headers,
        bodyText: Buffer.concat(chunks).toString('utf8'),
        clientIp: '127.0.0.1',
        env: proxyEnv,
        fetchImpl: mockFetch,
        rateLimiter: liveLimiter,
      });
      res.writeHead(out.status, out.headers);
      res.end(out.body);
    });
  });
  await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
  t.after(() => proxyServer.close());
  const proxyUrl = `http://127.0.0.1:${proxyServer.address().port}/suggest`;

  const ideProxy = createMockIde({ settings: { 'ai.proxyUrl': proxyUrl } });
  const genRes = await ai.generateText(
    ideProxy.vscode, ideProxy.context, ideProxy.output,
    { userPrompt: 'Files:\nM auth.ts\n+if (!session) return null;', allowWhenKeyConfigured: true, allowProxy: true },
    { env: {}, envFile: null },
  );
  assert.equal(genRes.ok, true);
  assert.equal(genRes.provider, 'proxy');
  assert.equal(genRes.text, 'feat(auth): add session cookie guard');
  assert.equal(receivedClientHeaders['x-goog-api-key'], undefined, 'client must never hold or send upstream Gemini API key');
  assert.equal(receivedClientHeaders.authorization, undefined);

  // testAiConnection also verifies proxyUrl cleanly when no personal key is configured
  const testRes = await ai.testAiConnection(ideProxy.vscode, ideProxy.context, ideProxy.output, { env: {}, envFile: null });
  assert.equal(testRes.ok, true);
  assert.equal(testRes.keySource, 'proxy');

  // Explicit ai.enabled: false still blocks proxy calls cleanly
  const ideProxyDisabled = createMockIde({
    settings: { 'ai.enabled': false, 'ai.proxyUrl': proxyUrl },
    inspected: { 'ai.enabled': { globalValue: false } },
  });
  const blockedRes = await ai.generateText(
    ideProxyDisabled.vscode, ideProxyDisabled.context, ideProxyDisabled.output,
    { userPrompt: 'Files:\nM a.ts', allowWhenKeyConfigured: true, allowProxy: true },
    { env: {}, envFile: null },
  );
  assert.equal(blockedRes.ok, false);
  assert.equal(blockedRes.status, 'disabled');

  // Default proxy URL is pre-wired for out-of-the-box users and can be explicitly cleared with ""
  assert.equal(ai.DEFAULT_PROXY_URL, 'https://workstation-commit-ai.safarovmancho.workers.dev/suggest');
  const ideDefaultProxy = createMockIde();
  assert.equal(ai.readAiSettings(ideDefaultProxy.vscode).proxyUrl, ai.DEFAULT_PROXY_URL);
  const ideClearedProxy = createMockIde({ settings: { 'ai.proxyUrl': '' } });
  assert.equal(ai.readAiSettings(ideClearedProxy.vscode).proxyUrl, '');
});
