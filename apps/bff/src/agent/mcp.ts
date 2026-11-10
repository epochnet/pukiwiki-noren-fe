// Minimal client for pukiwiki-mcp over streamable HTTP. Read-only use.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { log } from '../util.ts';

export class McpBridge {
  private url: string;
  private token?: string;
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private toolsCache: { at: number; tools: any[] } | null = null;
  status: { connected: boolean; error: string | null; url: string };

  constructor(url: string, token?: string) {
    this.url = url;
    this.token = token;
    this.status = { connected: false, error: null, url };
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const transport = new StreamableHTTPClientTransport(new URL(this.url), {
        requestInit: this.token ? { headers: { Authorization: `Bearer ${this.token}` } } : undefined,
      });
      const c = new Client({ name: 'pukiwiki-noren-fe', version: '0.1.0' });
      await c.connect(transport);
      this.client = c;
      this.status = { connected: true, error: null, url: this.url };
      return c;
    })();
    try {
      return await this.connecting;
    } catch (e) {
      this.status = { connected: false, error: (e as Error).message, url: this.url };
      throw e;
    } finally {
      this.connecting = null;
    }
  }

  async listTools(): Promise<{ name: string; description?: string; inputSchema: unknown }[]> {
    if (this.toolsCache && Date.now() - this.toolsCache.at < 10 * 60 * 1000) return this.toolsCache.tools;
    try {
      const c = await this.connect();
      const r = await c.listTools();
      this.toolsCache = { at: Date.now(), tools: r.tools };
      return r.tools;
    } catch (e) {
      log.warn('MCP unavailable:', (e as Error).message);
      this.client = null;
      return [];
    }
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const c = await this.connect();
    try {
      const r: any = await c.callTool({ name, arguments: args });
      const text = (r.content ?? []).map((p: any) => (p.type === 'text' ? p.text : '')).join('\n');
      if (r.isError) throw new Error(text || 'MCP ツールがエラーを返しました');
      return text || JSON.stringify(r.structuredContent ?? {});
    } catch (e) {
      this.client = null;
      throw e;
    }
  }
}
