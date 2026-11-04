import http from 'node:http';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { store } from './store.js';
import { createApp } from './api.js';
import { collectSystem } from './collectors/system.js';
import { collectDocker } from './collectors/docker.js';
import { collectNginx } from './collectors/nginx.js';
import { probeAll, buildTargets } from './collectors/probe.js';
import { alert } from './alerts.js';

const app = createApp();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'snapshot', data: store.snapshot() }));
  ws.on('error', () => {});
});

let lastTargets = [];
let lastDocker = null;

// ── 宿主机指标 ──
let systemBusy = false;
async function tickSystem() {
  if (systemBusy) return;
  systemBusy = true;
  try {
    const sample = await collectSystem();
    store.pushSystem(sample);
    alert.checkResources(sample);
    broadcast('system', {
      system: sample,
      history: {
        ts: store.history.ts.slice(-120),
        cpu: store.history.cpu.slice(-120),
        mem: store.history.mem.slice(-120),
        load: store.history.load.slice(-120),
        netIn: store.history.netIn.slice(-120),
        netOut: store.history.netOut.slice(-120),
      },
    });
  } catch (e) {
    console.error('[argus] system collect failed:', e.message);
  } finally {
    systemBusy = false;
  }
}

// ── Docker ──
async function tickDocker() {
  try {
    const d = await collectDocker();
    alert.checkContainers(lastDocker, d);
    lastDocker = d;
    store.docker = d;
    broadcast('docker', d);
  } catch (e) {
    console.error('[argus] docker collect failed:', e.message);
  }
}

// ── nginx ──
async function tickNginx() {
  try {
    const n = await collectNginx();
    store.nginx = n;
    broadcast('nginx', n);
  } catch (e) {
    console.error('[argus] nginx collect failed:', e.message);
  }
}

// ── 站点探测 ──
let probeBusy = false;
async function tickProbe() {
  if (probeBusy) return;
  probeBusy = true;
  try {
    const targets = buildTargets(store.nginx.sites || []);
    const results = await probeAll(targets);
    alert.checkTargets(lastTargets, results);
    alert.checkCerts(results);
    lastTargets = results;
    store.targets = results;
    broadcast('targets', { targets: results, summary: store.snapshot().summary });
  } catch (e) {
    console.error('[argus] probe failed:', e.message);
  } finally {
    probeBusy = false;
  }
}

function loop(fn, ms, name) {
  const run = async () => {
    try {
      await fn();
    } catch (e) {
      console.error(`[argus] loop ${name} error:`, e.message);
    }
    setTimeout(run, ms);
  };
  run();
}

server.listen(config.port, config.host, async () => {
  console.log(`[argus] listening on http://${config.host}:${config.port}`);
  await tickNginx();
  await tickDocker();
  await tickSystem();
  await tickProbe();
  loop(tickSystem, config.metricInterval, 'system');
  loop(tickDocker, config.dockerInterval, 'docker');
  loop(tickNginx, config.nginxInterval, 'nginx');
  loop(tickProbe, config.probeInterval, 'probe');
});

process.on('SIGTERM', () => {
  console.log('[argus] SIGTERM, shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
});
