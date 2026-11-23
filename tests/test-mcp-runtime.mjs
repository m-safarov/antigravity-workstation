import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const runtime = path.join(root, 'resources/mcp-runtime');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'config/mcp/active.template.json'), 'utf8')).mcpServers;

// Minimal JSON-RPC 2.0 stdio client for MCP (newline-delimited JSON per MCP stdio spec).
function createStdioMcpClient(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 1;
  let buffer = '';
  let stderr = '';
  const pending = new Map();

  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message && Object.hasOwn(message, 'id') && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
        else resolve(message.result);
      }
    }
  });
  child.on('exit', (code, signal) => {
    for (const { reject } of pending.values()) {
      reject(new Error(`MCP server exited before replying (code=${code}, signal=${signal}): ${stderr}`));
    }
    pending.clear();
  });

  function send(payload) {
    child.stdin.write(JSON.stringify(payload) + '\n');
  }
  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }
  async function connect() {
    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'workstation-setup-integration', version: '1.0.0' },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }
  async function close() {
    try { child.stdin.end(); } catch {}
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 2000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  }
  return {
    connect,
    close,
    listTools: () => request('tools/list', {}),
    callTool: ({ name, arguments: toolArgs }) => request('tools/call', { name, arguments: toolArgs }),
    getErrors: () => stderr,
  };
}

for (const [name, config] of Object.entries(catalog)) {
  test(`${name}: real stdio initialize and tool discovery`, { timeout: 60000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-mcp-'));
    const entry = config.args[0].replace('${USER_HOME}/.gemini/config/mcp-runtime', runtime);
    const args = [entry];
    const chrome = name === 'chrome-devtools-mcp' && process.env.WORKSTATION_TEST_CHROME;
    if (chrome) {
      args.push('--headless', '--isolated', '--executablePath=' + chrome, '--no-usage-statistics', '--no-page-id-routing');
      if (process.env.WORKSTATION_TEST_NO_SANDBOX === '1') args.push('--chromeArg=--no-sandbox');
    }
    const client = createStdioMcpClient(process.execPath, args, {
      cwd: directory,
      env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' },
    });
    t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    await client.connect();
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0, client.getErrors());
    assert.ok(tools.every(tool => typeof tool.name === 'string' && tool.inputSchema?.type === 'object'));
    t.diagnostic(`${tools.length} tools: ${tools.map(tool => tool.name).join(', ')}`);
    if (chrome) {
      const server = http.createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<h1>Workstation MCP audit</h1>');
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      t.after(() => { server.closeAllConnections(); server.close(); });
      const page = await client.callTool({ name: 'new_page', arguments: { url: `http://127.0.0.1:${server.address().port}` } });
      assert.notEqual(page.isError, true, JSON.stringify(page));
      const result = await client.callTool({ name: 'evaluate_script', arguments: { function: '() => document.querySelector("h1").textContent' } });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.match(JSON.stringify(result.content), /Workstation MCP audit/);
      t.diagnostic('Actual isolated Chromium page opened and its DOM read through MCP');
    }
  });
}
