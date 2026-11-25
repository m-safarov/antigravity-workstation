'use strict';

const ai = require('../extensions/workstation-stability/ai-assistant.cjs');

const ALLOWED_ACTIONS = Object.freeze([
  'retry_download',
  'clean_staging_and_retry',
  'reverify_archive_and_retry',
  'repair_missing_component',
  'retry_extension_install',
  'abort_with_guidance',
]);

const ALLOWED_ACTION_SET = new Set(ALLOWED_ACTIONS);

const SHELL_RISK_PATTERN = /\b(?:powershell|pwsh|cmd\.exe|bash|sh|curl|wget|iex|invoke-expression|invoke-webrequest|rm\s+-rf|del\s+\/|chmod|chown|sudo)\b|[|;&`$><]/i;

function classifyDeterministicAction(failure = {}) {
  const stage = String(failure.stage || '').toLowerCase();
  const code = String(failure.code || '').toUpperCase();
  const httpStatus = Number(failure.httpStatus || 0);
  const message = String(failure.message || '');

  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404 || code === 'PERMANENT_HTTP') {
    return { action: 'abort_with_guidance', reason: 'Permanent HTTP error cannot be fixed by retrying automatically.' };
  }
  if (/corrupt|checksum|sha-?256|zip|archive|unexpected eof|invalid payload/i.test(message) || code === 'CORRUPT_ARCHIVE') {
    return { action: 'clean_staging_and_retry', reason: 'Corrupt or incomplete archive detected; clean owned staging and download fresh copy.' };
  }
  if (/staged|staging|leftover|partial extract/i.test(message) || code === 'STAGING_DIRTY') {
    return { action: 'clean_staging_and_retry', reason: 'Interrupted staging state detected; clean owned staging directory before retrying.' };
  }
  if (stage === 'download' && (httpStatus === 429 || httpStatus >= 500 || /timeout|timed out|econnreset|enotfound|eai_again|transient/i.test(message) || code === 'TRANSIENT_DOWNLOAD')) {
    return { action: 'retry_download', reason: 'Transient download failure; retry within bounded backoff limits.' };
  }
  if (stage === 'extension' || /extension .* failed|vsix/i.test(message) || code === 'EXTENSION_FAILED') {
    return { action: 'retry_extension_install', target: sanitizeTarget(failure.target), reason: 'Extension installation failed; retry the affected extension only.' };
  }
  if (stage === 'completeness' || /missing required|missing component/i.test(message) || code === 'MISSING_COMPONENT') {
    return { action: 'repair_missing_component', target: sanitizeTarget(failure.target), reason: 'Required profile component is missing; repair only that component.' };
  }
  return null;
}

function sanitizeTarget(target) {
  if (typeof target !== 'string') return undefined;
  const trimmed = target.trim();
  if (!trimmed || trimmed.length > 120) return undefined;
  if (/\.\.|[\\/]/.test(trimmed) || !/^[A-Za-z0-9._:@-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

function validateAiProposal(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { valid: false, reason: 'AI returned an empty recovery proposal.' };
  }
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { valid: false, reason: 'AI recovery response was not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, reason: 'AI recovery proposal must be a JSON object.' };
  }
  for (const forbidden of ['command', 'commands', 'shell', 'script', 'exec', 'url', 'powershell']) {
    if (Object.hasOwn(parsed, forbidden)) {
      return { valid: false, reason: `Rejected unsafe field "${forbidden}" from AI recovery proposal.` };
    }
  }
  if (typeof parsed.action !== 'string' || !ALLOWED_ACTION_SET.has(parsed.action)) {
    return { valid: false, reason: `Rejected disallowed AI recovery action "${String(parsed.action || '')}".` };
  }
  if (typeof parsed.reason === 'string' && SHELL_RISK_PATTERN.test(parsed.reason)) {
    return { valid: false, reason: 'Rejected AI recovery proposal containing shell syntax.' };
  }
  const target = parsed.target === undefined ? undefined : sanitizeTarget(parsed.target);
  if (parsed.target !== undefined && !target) {
    return { valid: false, reason: 'Rejected invalid target identifier in AI recovery proposal.' };
  }
  return {
    valid: true,
    proposal: {
      action: parsed.action,
      target,
      reason: ai.redactSecrets(String(parsed.reason || ''), [], 200),
    },
  };
}

function buildRedactedDiagnostic(failure = {}, attemptedActions = [], secrets = []) {
  return {
    stage: String(failure.stage || 'unknown').slice(0, 40),
    code: String(failure.code || 'UNKNOWN').slice(0, 64),
    httpStatus: Number.isInteger(failure.httpStatus) ? failure.httpStatus : null,
    target: sanitizeTarget(failure.target) || null,
    message: ai.redactSecrets(String(failure.message || ''), secrets, 360),
    attemptedActions: attemptedActions.slice(0, 6),
    allowedActions: ALLOWED_ACTIONS,
  };
}

async function runBoundedRecovery(failure, options = {}) {
  const maxAttempts = Math.max(1, Math.min(Number(options.maxAttempts) || 3, 4));
  const maxAiCalls = Math.max(0, Math.min(Number(options.maxAiCalls ?? 1), 2));
  const timeoutMs = Math.max(500, Math.min(Number(options.timeoutMs) || 10000, 15000));
  const executors = options.executors || {};
  const verify = typeof options.verify === 'function' ? options.verify : async () => ({ ok: true });
  const history = [];
  let aiCalls = 0;
  let currentFailure = failure || {};
  let aiStatus = 'not_needed';

  async function applyAction(source, plan) {
    if (plan.action === 'abort_with_guidance') {
      history.push({ source, action: plan.action, reason: plan.reason, outcome: 'aborted' });
      return { done: true, recovered: false, guidance: plan.reason };
    }
    const executor = executors[plan.action];
    if (typeof executor !== 'function') {
      history.push({ source, action: plan.action, reason: plan.reason, outcome: 'unsupported_executor' });
      return { done: false, recovered: false, error: `No local executor for action "${plan.action}"` };
    }
    try {
      const execResult = await executor({ target: plan.target, failure: currentFailure });
      if (execResult && execResult.ok === false) {
        currentFailure = {
          ...currentFailure,
          code: execResult.code || currentFailure.code,
          httpStatus: execResult.httpStatus ?? currentFailure.httpStatus,
          message: ai.redactSecrets(execResult.message || 'Recovery action failed', [], 300),
        };
        history.push({ source, action: plan.action, outcome: 'action_failed', message: currentFailure.message });
        return { done: false, recovered: false };
      }
      const check = await verify({ action: plan.action, target: plan.target });
      if (check && check.ok) {
        history.push({ source, action: plan.action, outcome: 'recovered' });
        return { done: true, recovered: true };
      }
      currentFailure = {
        ...currentFailure,
        code: check?.code || currentFailure.code,
        message: ai.redactSecrets(check?.message || 'Post-recovery verification failed', [], 300),
      };
      history.push({ source, action: plan.action, outcome: 'verify_failed', message: currentFailure.message });
      return { done: false, recovered: false };
    } catch (error) {
      currentFailure = { ...currentFailure, message: ai.redactSecrets(error?.message || 'Unexpected recovery error', [], 300) };
      history.push({ source, action: plan.action, outcome: 'exception', message: currentFailure.message });
      return { done: false, recovered: false };
    }
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const deterministic = classifyDeterministicAction(currentFailure);
    if (deterministic) {
      const outcome = await applyAction('deterministic', deterministic);
      if (outcome.done) {
        return {
          recovered: outcome.recovered,
          usedAi: aiCalls > 0,
          aiStatus,
          attempts: attempt + 1,
          history,
          guidance: outcome.guidance || (outcome.recovered ? 'Recovered deterministically.' : currentFailure.message),
        };
      }
      continue;
    }

    // Deterministic classifier could not pick an action; consult optional local AI only when explicitly enabled.
    const aiConfig = options.ai || {};
    if (!aiConfig.enabled) {
      aiStatus = 'disabled';
      return {
        recovered: false,
        usedAi: false,
        aiStatus,
        attempts: attempt,
        history,
        guidance: 'Deterministic recovery did not match this failure and optional AI recovery is disabled.',
      };
    }
    if (aiCalls >= maxAiCalls) {
      aiStatus = 'budget_exhausted';
      break;
    }

    const secretProvider = typeof aiConfig.getApiKey === 'function' ? aiConfig.getApiKey : null;
    const rawKey = secretProvider ? await secretProvider() : '';
    if (!ai.isUsableApiKey(rawKey)) {
      aiStatus = !secretProvider
        ? 'no_secret_storage_in_terminal'
        : ai.isPlaceholderApiKey(rawKey) ? 'placeholder_key_unset' : 'missing_key';
      return {
        recovered: false,
        usedAi: false,
        aiStatus,
        attempts: attempt,
        history,
        guidance: 'Optional AI recovery skipped because no real API key is available in secure storage; deterministic recovery remains available.',
      };
    }

    aiCalls++;
    const diagnostic = buildRedactedDiagnostic(currentFailure, history.map(item => item.action), [rawKey]);
    const aiResult = await ai.performProviderCall({
      provider: aiConfig.provider || ai.DEFAULT_PROVIDER,
      endpoint: aiConfig.endpoint || ai.DEFAULT_ENDPOINT,
      model: aiConfig.model || ai.DEFAULT_MODEL,
      apiKey: rawKey,
      systemPrompt: 'Choose ONE safe recovery action from allowedActions for the Antigravity Workstation installer. Return ONLY strict JSON {"action":"...","reason":"...","target":"optional"}. Never return shell commands or URLs.',
      userPrompt: JSON.stringify(diagnostic),
      maxTokens: 120,
      timeoutMs,
      request: aiConfig.request,
    });

    if (!aiResult.ok) {
      aiStatus = aiResult.status;
      history.push({ source: 'ai', action: 'consult', outcome: aiResult.status, message: ai.redactSecrets(aiResult.message, [rawKey], 200) });
      return {
        recovered: false,
        usedAi: true,
        aiStatus,
        attempts: attempt + 1,
        history,
        guidance: ai.redactSecrets(aiResult.message, [rawKey], 200),
      };
    }

    const validated = validateAiProposal(aiResult.text);
    if (!validated.valid) {
      aiStatus = 'rejected_unsafe_proposal';
      history.push({ source: 'ai', action: 'validate', outcome: 'rejected', message: validated.reason });
      return {
        recovered: false,
        usedAi: true,
        aiStatus,
        attempts: attempt + 1,
        history,
        guidance: validated.reason,
      };
    }

    aiStatus = 'proposal_accepted';
    const outcome = await applyAction('ai', validated.proposal);
    if (outcome.done) {
      return {
        recovered: outcome.recovered,
        usedAi: true,
        aiStatus,
        attempts: attempt + 1,
        history,
        guidance: outcome.guidance || (outcome.recovered ? 'Recovered using allowlisted AI proposal.' : currentFailure.message),
      };
    }
  }

  return {
    recovered: false,
    usedAi: aiCalls > 0,
    aiStatus,
    attempts: history.length,
    history,
    guidance: ai.redactSecrets(currentFailure.message || 'Recovery limit reached.', [], 240),
  };
}

module.exports = {
  ALLOWED_ACTIONS,
  classifyDeterministicAction,
  validateAiProposal,
  buildRedactedDiagnostic,
  runBoundedRecovery,
  isPlaceholderApiKey: ai.isPlaceholderApiKey,
  redactSecrets: ai.redactSecrets,
};
