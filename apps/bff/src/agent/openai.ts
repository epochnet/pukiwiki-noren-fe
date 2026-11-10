// Minimal client for OpenAI-compatible Chat Completions APIs
// (OpenAI, llama.cpp server, vLLM, Ollama, LM Studio ...). Uses fetch only.

export interface OaiToolCall { id: string; name: string; arguments: string }
export interface OaiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}
export interface OaiTool {
  type: 'function';
  function: { name: string; description?: string; parameters: unknown };
}
export interface OaiTurn {
  text: string;
  toolCalls: OaiToolCall[];
  finishReason: string | null;
  usage: { input: number; output: number };
}

export class OpenAICompatError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class OpenAICompatClient {
  private baseUrl: string;
  private apiKey?: string;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey || undefined;
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new OpenAICompatError(res.status, `OpenAI 互換 API がエラーを返しました（HTTP ${res.status}）${detail ? `: ${detail}` : ''}`);
    }
    return res;
  }

  /** One streamed turn. Text and reasoning deltas are reported as they arrive. */
  async streamTurn(
    req: { model: string; messages: OaiMessage[]; tools?: OaiTool[] },
    on: { text?: (d: string) => void; reasoning?: (d: string) => void },
    signal?: AbortSignal,
  ): Promise<OaiTurn> {
    const res = await this.post({
      model: req.model,
      messages: req.messages,
      ...(req.tools?.length ? { tools: req.tools, tool_choice: 'auto' } : {}),
      stream: true,
      stream_options: { include_usage: true },
    }, signal);
    if (!res.body) throw new OpenAICompatError(0, 'OpenAI 互換 API の応答が空でした');

    const turn: OaiTurn = { text: '', toolCalls: [], finishReason: null, usage: { input: 0, output: 0 } };
    const calls = new Map<number, OaiToolCall>();
    const decoder = new TextDecoder();
    let buf = '';
    let done = false;

    const handle = (data: string) => {
      if (data === '[DONE]') { done = true; return; }
      let ev: any;
      try { ev = JSON.parse(data); } catch { return; }
      if (ev.error) throw new OpenAICompatError(0, `OpenAI 互換 API のエラー: ${ev.error.message ?? JSON.stringify(ev.error)}`);
      if (ev.usage) {
        turn.usage.input = ev.usage.prompt_tokens ?? turn.usage.input;
        turn.usage.output = ev.usage.completion_tokens ?? turn.usage.output;
      }
      const ch = ev.choices?.[0];
      if (!ch) return;
      const d = ch.delta ?? {};
      const reasoning = d.reasoning_content ?? d.reasoning;
      if (typeof reasoning === 'string' && reasoning) on.reasoning?.(reasoning);
      if (typeof d.content === 'string' && d.content) {
        turn.text += d.content;
        on.text?.(d.content);
      }
      for (const tc of d.tool_calls ?? []) {
        const idx = typeof tc.index === 'number' ? tc.index : calls.size;
        let c = calls.get(idx);
        if (!c) { c = { id: '', name: '', arguments: '' }; calls.set(idx, c); }
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.arguments += tc.function.arguments;
      }
      if (ch.finish_reason) turn.finishReason = ch.finish_reason;
    };

    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) handle(line.slice(5).trim());
        if (done) break;
      }
      if (done) break;
    }
    if (!done && buf.startsWith('data:')) handle(buf.slice(5).trim());

    turn.toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({
      ...c,
      id: c.id || `call_${i}_${Date.now().toString(36)}`,
    }));
    return turn;
  }

  /** Non-streamed completion; returns the assistant text. */
  async complete(req: { model: string; messages: OaiMessage[] }, signal?: AbortSignal): Promise<{ text: string; finishReason: string | null }> {
    const res = await this.post({ model: req.model, messages: req.messages, stream: false }, signal);
    const j: any = await res.json();
    const ch = j.choices?.[0];
    return { text: String(ch?.message?.content ?? ''), finishReason: ch?.finish_reason ?? null };
  }
}

/** Some servers return the model's thinking inline. Remove it from final text. */
export function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
}
