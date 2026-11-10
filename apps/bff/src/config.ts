import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { globToRegExp } from './util.ts';

export interface WikiConfig {
  id: string;
  label: string;
  url: string;
  /** URL of the same wiki as the users' browsers reach it (links to the classic UI). Defaults to `url`. */
  publicUrl: string;
  encoding: 'auto' | 'euc-jp' | 'utf-8';
  basicUser?: string;
  basicPassword?: string;
  verifyTls: boolean;
  timeoutMs: number;
  concurrency: number;
  /** PukiWiki admin password used automatically for attachment uploads (optional). */
  adminPassword?: string;
  /** #markdown plugin (pukiwiki-plugin-markdown) installed on the wiki: auto-detected, or forced on/off. */
  markdownPlugin: 'auto' | 'on' | 'off';
  /** Hours offset of the wiki's local time used in RecentChanges (default +9). */
  tzOffsetHours: number;
  mcp?: { url: string; token?: string };
  agent: { enabled: boolean; exclude: RegExp[]; excludePatterns: string[] };
  /** Pages hidden from the tree / dashboard (still reachable). */
  hiddenPages: RegExp[];
}

export interface AppConfig {
  port: number;
  host: string;
  publicBaseUrl: string;
  authMode: 'none' | 'tailscale' | 'header';
  authHeader: string;
  dataDir: string;
  webDist: string;
  syncIntervalSec: number;
  fullSyncHour: number;
  wikis: WikiConfig[];
  /** LLM used by the AI assistant: Claude API or an OpenAI-compatible Chat Completions API. */
  aiProvider: 'anthropic' | 'openai';
  anthropic: { apiKey?: string; baseUrl?: string; model: string; effortChat: string; effortRewrite: string };
  openai: { baseUrl?: string; apiKey?: string; model: string };
  redactPatterns: RegExp[];
}

const env = (k: string, d?: string) => process.env[k] ?? d;
const fromEnvName = (name?: string) => (name ? process.env[name] : undefined);

const DEFAULT_REDACT = [
  String.raw`(?:パスワード|password|passwd|pass|PW)\s*[:：=]\s*\S+`,
  String.raw`sk-ant-[A-Za-z0-9_-]{10,}`,
  String.raw`AKIA[0-9A-Z]{16}`,
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`,
];

const wikiUrl = (u: unknown) => String(u).replace(/\/?$/, '/').replace(/index\.php\/$/, 'index.php');

function wikiFromObject(o: any, i: number): WikiConfig {
  const exclude: string[] = o.agent?.exclude_pages ?? [];
  return {
    id: String(o.id ?? `wiki${i + 1}`),
    label: String(o.label ?? o.id ?? 'PukiWiki'),
    url: wikiUrl(o.url),
    publicUrl: wikiUrl(o.public_url || o.url),
    encoding: (o.encoding ?? 'auto') as WikiConfig['encoding'],
    basicUser: o.basic_auth?.user ?? fromEnvName(o.basic_auth?.user_env),
    basicPassword: o.basic_auth?.password ?? fromEnvName(o.basic_auth?.password_env),
    verifyTls: o.verify_tls !== false,
    timeoutMs: Number(o.timeout ?? 30) * 1000,
    concurrency: Number(o.concurrency ?? 4),
    adminPassword: fromEnvName(o.admin_password_env),
    markdownPlugin: markdownSetting(o.markdown_plugin),
    tzOffsetHours: Number(o.tz_offset_hours ?? 9),
    mcp: o.mcp?.url ? { url: String(o.mcp.url), token: fromEnvName(o.mcp.token_env) } : undefined,
    agent: { enabled: o.agent?.enabled !== false, exclude: exclude.map(globToRegExp), excludePatterns: exclude },
    hiddenPages: (o.hidden_pages ?? []).map(globToRegExp),
  };
}

export function loadConfig(): AppConfig {
  const wikisFile = env('WIKIS_CONFIG');
  let wikis: WikiConfig[] = [];
  if (wikisFile && existsSync(wikisFile)) {
    const y = parseYaml(readFileSync(wikisFile, 'utf8')) ?? {};
    wikis = (y.wikis ?? []).map(wikiFromObject);
  } else if (env('PUKIWIKI_URL')) {
    wikis = [wikiFromObject({
      id: env('PUKIWIKI_ID', 'wiki'),
      label: env('PUKIWIKI_LABEL', 'PukiWiki'),
      url: env('PUKIWIKI_URL'),
      public_url: env('PUKIWIKI_PUBLIC_URL'),
      encoding: env('PUKIWIKI_ENCODING', 'auto'),
      basic_auth: env('PUKIWIKI_BASIC_USER') ? { user: env('PUKIWIKI_BASIC_USER'), password: env('PUKIWIKI_BASIC_PASSWORD') } : undefined,
      verify_tls: env('PUKIWIKI_VERIFY_TLS', 'true') !== 'false',
      timeout: env('PUKIWIKI_TIMEOUT', '30'),
      concurrency: env('PUKIWIKI_CONCURRENCY', '4'),
      admin_password_env: 'PUKIWIKI_ADMIN_PASSWORD',
      markdown_plugin: env('PUKIWIKI_MARKDOWN_PLUGIN', 'auto'),
      tz_offset_hours: env('PUKIWIKI_TZ_OFFSET', '9'),
      mcp: env('MCP_URL') ? { url: env('MCP_URL'), token_env: 'MCP_TOKEN' } : undefined,
      agent: {
        enabled: env('AGENT_ENABLED', 'true') !== 'false',
        exclude_pages: (env('AGENT_EXCLUDE_PAGES', '') as string).split(',').map((s) => s.trim()).filter(Boolean),
      },
      hidden_pages: ['RecentChanges', 'RecentDeleted', 'MenuBar', 'SideBar', 'AutoTicketLinkName', 'InterWikiName', ':*'],
    }, 0)];
  }
  if (!wikis.length) throw new Error('PUKIWIKI_URL か WIKIS_CONFIG を設定してください');

  const redact = [...DEFAULT_REDACT, ...((env('AGENT_REDACT_PATTERNS', '') as string).split('\n').filter(Boolean))];
  return {
    port: Number(env('PORT', '8080')),
    host: env('HOST', '127.0.0.1') as string,
    publicBaseUrl: env('PUBLIC_BASE_URL', '') as string,
    authMode: (env('AUTH_MODE', 'none') as AppConfig['authMode']),
    authHeader: (env('AUTH_HEADER', 'Tailscale-User-Login') as string).toLowerCase(),
    dataDir: env('DATA_DIR', './data') as string,
    webDist: env('WEB_DIST', fileURLToPath(new URL('../../web/dist', import.meta.url))) as string,
    syncIntervalSec: Number(env('SYNC_INTERVAL', '60')),
    fullSyncHour: Number(env('FULL_SYNC_HOUR', '3')),
    wikis,
    aiProvider: aiProvider(env('AI_PROVIDER', 'anthropic') as string),
    anthropic: {
      apiKey: env('ANTHROPIC_API_KEY'),
      baseUrl: env('ANTHROPIC_BASE_URL'),
      model: env('AGENT_MODEL', 'claude-opus-5-5') as string,
      effortChat: env('AGENT_EFFORT_CHAT', 'medium') as string,
      effortRewrite: env('AGENT_EFFORT_REWRITE', 'low') as string,
    },
    openai: {
      baseUrl: env('OPENAI_BASE_URL') || undefined,
      apiKey: env('OPENAI_API_KEY') || undefined,
      model: env('AGENT_MODEL', '') as string,
    },
    redactPatterns: redact.map((p) => new RegExp(p, 'gi')),
  };
}

function aiProvider(v: string): AppConfig['aiProvider'] {
  const p = v.trim().toLowerCase();
  if (p === 'anthropic' || p === 'openai') return p;
  throw new Error(`AI_PROVIDER は anthropic か openai を指定してください（指定値: ${v}）`);
}

function markdownSetting(v: unknown): WikiConfig['markdownPlugin'] {
  const s = String(v ?? 'auto').trim().toLowerCase();
  if (s === 'on' || s === 'true') return 'on';
  if (s === 'off' || s === 'false') return 'off';
  return 'auto';
}
