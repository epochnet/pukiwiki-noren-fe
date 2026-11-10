import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadConfig } from './config.ts';
import { api, createWikiCtx } from './routes.ts';
import type { WikiCtx } from './routes.ts';
import { log } from './util.ts';

const app = loadConfig();
const wikis = new Map<string, WikiCtx>();
for (const w of app.wikis) wikis.set(w.id, createWikiCtx(app, w));

const server = new Hono();
server.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
  c.header('X-Frame-Options', 'SAMEORIGIN');
  if ((c.res.headers.get('content-type') ?? '').includes('text/html')) {
    c.header('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; form-action 'self'");
  }
});
server.get('/healthz', (c) => c.json({ ok: true, wikis: [...wikis.values()].map((w) => ({ id: w.cfg.id, pages: w.db.count(), sync: w.sync.status })) }));
server.route('/api', api(app, wikis));

// Web UI (built SPA). Old PukiWiki-style URLs (/?Page) redirect to the new UI.
if (existsSync(app.webDist)) {
  const indexHtml = readFileSync(join(app.webDist, 'index.html'), 'utf8');
  const root = relative(process.cwd(), app.webDist) || '.';
  server.use('/assets/*', serveStatic({ root }));
  server.get('/favicon.svg', serveStatic({ root }));
  server.get('*', (c) => {
    const url = new URL(c.req.url);
    const first = [...wikis.values()][0];
    if (url.pathname === '/' && url.search.length > 1 && first) {
      const q = url.search.slice(1);
      const page = q.includes('=') ? first.driver.pageFromHref('?' + q) : first.driver.codec.unq(q);
      if (page) return c.redirect(`/w/${encodeURIComponent(first.cfg.id)}/p/${page.split('/').map(encodeURIComponent).join('/')}`);
    }
    return c.html(indexHtml);
  });
} else {
  log.warn(`Web UI not built (${app.webDist}); serving API only`);
}

for (const w of wikis.values()) {
  w.driver.probe()
    .then(() => w.sync.start(app.syncIntervalSec, app.fullSyncHour))
    .catch((e) => {
      log.error(`[${w.cfg.id}] cannot reach PukiWiki: ${(e as Error).message}`);
      setTimeout(() => w.driver.probe().then(() => w.sync.start(app.syncIntervalSec, app.fullSyncHour)).catch(() => {}), 30_000).unref();
    });
}

const loopback = ['127.0.0.1', '::1', 'localhost'].includes(app.host);
if (!loopback && app.authMode === 'none' && !process.env.NOREN_IN_CONTAINER) {
  log.warn(`HOST=${app.host} with AUTH_MODE=none: anyone who can reach this port can edit the wiki through it. ` +
    'Put it behind an authenticating proxy (AUTH_MODE=header / tailscale) or bind to 127.0.0.1.');
}

serve({ fetch: server.fetch, port: app.port, hostname: app.host }, (info) => {
  log.info(`pukiwiki-noren-fe listening on http://${info.address}:${info.port} (auth=${app.authMode})`);
});
