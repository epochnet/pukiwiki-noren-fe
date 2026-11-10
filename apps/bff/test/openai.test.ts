// AI assistant over an OpenAI-compatible API, against a local mock server (no network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AgentService, type AgentEvent } from '../src/agent/agent.ts';

const requests: any[] = [];
let auth: string | undefined;
let server: Server;
let base = '';

function sse(res: any, events: unknown[]) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.end('data: [DONE]\n\n');
}

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      auth = req.headers.authorization;
      const j = JSON.parse(body);
      requests.push(j);
      if (req.url !== '/v1/chat/completions') { res.writeHead(404).end('not found'); return; }
      if (!j.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '<think>考え中</think>\n*書き換え後' }, finish_reason: 'stop' }] }));
        return;
      }
      const last = j.messages[j.messages.length - 1];
      if (last.role === 'user') {
        // first turn: think, then call a tool with arguments split across chunks
        sse(res, [
          { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '文脈を確認する' } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_current_context', arguments: '' } }] } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{' } }] } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] }, finish_reason: 'tool_calls' }] },
          { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
        ]);
      } else {
        sse(res, [
          { choices: [{ index: 0, delta: { content: 'いま開いているのは ' } }] },
          { choices: [{ index: 0, delta: { content: '[[FrontPage]] です。' }, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 150, completion_tokens: 12 } },
        ]);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(() => server.close());

function makeAgent(openai: { baseUrl?: string; apiKey?: string; model: string }) {
  const app: any = {
    aiProvider: 'openai',
    anthropic: { model: 'claude-opus-5-5', effortChat: 'medium', effortRewrite: 'low' },
    openai,
    redactPatterns: [/(?:パスワード)\s*[:：=]\s*\S+/gi],
  };
  const wiki: any = { agent: { enabled: true, exclude: [], excludePatterns: [] } };
  return new AgentService(app, wiki, {} as any, {} as any);
}

test('status explains what is missing', () => {
  assert.equal(makeAgent({ model: 'm' }).status.reason, 'OPENAI_BASE_URL が設定されていません');
  assert.equal(makeAgent({ baseUrl: base, model: '' }).status.reason, 'AGENT_MODEL が設定されていません');
  const ok = makeAgent({ baseUrl: base, model: 'local-model' });
  assert.equal(ok.enabled, true);
  assert.equal(ok.status.provider, 'openai');
  assert.equal(ok.status.model, 'local-model');
});

test('streams text, reasoning and runs tools in a loop', async () => {
  requests.length = 0;
  const agent = makeAgent({ baseUrl: base + '/', apiKey: 'k-test', model: 'local-model' });
  const events: AgentEvent[] = [];
  await agent.run({ message: 'このページは？', context: { page: 'FrontPage', selection: 'パスワード: abc' } }, 'tester', (e) => events.push(e));

  assert.equal(auth, 'Bearer k-test');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, 'local-model');
  assert.equal(requests[0].messages[0].role, 'system');
  assert.ok(requests[0].tools.some((t: any) => t.type === 'function' && t.function.name === 'read_page' && t.function.parameters.required.includes('page')));
  assert.ok(!JSON.stringify(requests[0].tools).includes('eager_input_streaming'));

  const second = requests[1].messages;
  const asst = second[second.length - 2];
  const tool = second[second.length - 1];
  assert.equal(asst.role, 'assistant');
  assert.deepEqual(asst.tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'get_current_context', arguments: '{}' } }]);
  assert.equal(tool.role, 'tool');
  assert.equal(tool.tool_call_id, 'call_1');
  const ctx = JSON.parse(tool.content);
  assert.equal(ctx.page, 'FrontPage');
  assert.equal(ctx.selection, '[REDACTED]'); // secrets are masked before reaching the model

  assert.ok(events.some((e) => e.type === 'thinking' && e.delta === '文脈を確認する'));
  assert.ok(events.some((e) => e.type === 'tool_start' && e.name === 'get_current_context'));
  assert.ok(events.some((e) => e.type === 'tool_end' && e.ok));
  const text = events.filter((e) => e.type === 'text').map((e: any) => e.delta).join('');
  assert.equal(text, 'いま開いているのは [[FrontPage]] です。');
  assert.deepEqual(events.at(-1), { type: 'done', usage: { input: 250, output: 22 } });
});

test('rewrite uses a plain completion and drops inline thinking', async () => {
  const agent = makeAgent({ baseUrl: base, model: 'local-model' });
  assert.equal(await agent.rewrite('見出しに', '書き換え前'), '*書き換え後');
  assert.equal(auth, undefined);
});

test('HTTP errors are reported with the status code', async () => {
  const agent = makeAgent({ baseUrl: base.replace('/v1', '/nope'), model: 'local-model' });
  await assert.rejects(agent.run({ message: 'x' }, 'tester', () => {}), /HTTP 404/);
});
