import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { store } from './store.js';
import { requestOnce } from './collectors/probe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 长度不同的字符串比较会泄露长度信息，先各自 hash 成定长再定长比较
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb) && String(a) === String(b);
}

const authEnabled = Boolean(config.authUser && config.authPass);

// WebSocket 升级请求要单独校验，供 server.js 复用
export function checkBasicAuth(header) {
  if (!authEnabled) return true;
  const hdr = header || '';
  if (!hdr.startsWith('Basic ')) return false;
  let decoded = '';
  try {
    decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const idx = decoded.indexOf(':');
  if (idx <= 0) return false;
  return safeEqual(decoded.slice(0, idx), config.authUser) && safeEqual(decoded.slice(idx + 1), config.authPass);
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // ── Basic 认证（AUTH_USER + AUTH_PASS 都非空才启用）──
  if (authEnabled) {
    app.use((req, res, next) => {
      // 健康检查给容器 healthcheck 用，必须免认证，否则容器永远起不来
      if (req.path === '/api/health') return next();
      if (checkBasicAuth(req.headers.authorization)) return next();
      res.setHeader('WWW-Authenticate', 'Basic realm="ARGUS", charset="UTF-8"');
      res.status(401).send('Authentication required');
    });
  }

  app.get('/api/health', (_req, res) => {
    // 未启用认证时不暴露 uptime 之类的运行细节
    res.json({ ok: true, ts: Date.now(), ...(authEnabled ? { uptime: process.uptime() } : {}) });
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
