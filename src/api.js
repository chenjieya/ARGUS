import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { store } from './store.js';
import { requestOnce } from './collectors/probe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // ── Basic 认证（配置了 AUTH_USER 才启用）──
  if (config.authUser && config.authPass) {
    app.use((req, res, next) => {
      if (req.path === '/api/health') return next();
      const hdr = req.headers.authorization || '';
      if (hdr.startsWith('Basic ')) {
        const [u, p] = Buffer.from(hdr.slice(6), 'base64').toString().split(':');
        if (u === config.authUser && p === config.authPass) return next();
      }
      res.setHeader('WWW-Authenticate', 'Basic realm="ARGUS"');
      res.status(401).send('Authentication required');
    });
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime(), ts: Date.now() });
  });

  app.get('/api/snapshot', (_req, res) => {
    res.json(store.snapshot());
  });

  app.get('/api/system', (_req, res) => {
    res.json(store.system || {});
  });

  app.get('/api/history', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 300, config.historySize);
    const h = store.history;
    const from = Math.max(0, h.ts.length - limit);
    res.json({
      ts: h.ts.slice(from),
      cpu: h.cpu.slice(from),
      mem: h.mem.slice(from),
      load: h.load.slice(from),
      netIn: h.netIn.slice(from),
      netOut: h.netOut.slice(from),
    });
  });

  app.get('/api/docker', (_req, res) => {
    res.json(store.docker);
  });

  app.get('/api/nginx', (_req, res) => {
    res.json(store.nginx);
  });

  app.get('/api/targets', (_req, res) => {
    res.json(store.targets);
  });

  app.get('/api/events', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json(store.events.slice(0, limit));
  });

  // 立即重探某个站点
  app.post('/api/targets/:id/check', async (req, res) => {
    const t = store.targets.find((x) => x.id === req.params.id);
    if (!t) {
      res.status(404).json({ error: 'target not found' });
      return;
    }
    const r = await requestOnce(t.url, 'GET', config.probeTimeout);
    res.json(r);
  });

  app.use(express.static(path.join(ROOT, 'public'), { maxAge: '1h', extensions: ['html'] }));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.sendFile(path.join(ROOT, 'public/index.html'));
  });

  return app;
}
