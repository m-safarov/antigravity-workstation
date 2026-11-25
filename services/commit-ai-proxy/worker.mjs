import { handleCommitSuggestRequest } from './proxy-core.mjs';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const bodyText = request.method === 'POST' ? await request.text() : '';
    const clientIp = request.headers.get('cf-connecting-ip')
      || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
      || 'unknown';
    const result = await handleCommitSuggestRequest({
      method: request.method,
      pathname: url.pathname,
      headers: request.headers,
      bodyText,
      clientIp,
      env,
      fetchImpl: globalThis.fetch,
    });
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  },
};
