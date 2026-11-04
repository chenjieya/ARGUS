import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from '../config.js';

const HOST_PROC = config.hostProc;

function readProc(rel, fallbackRoot = '/proc') {
  // 优先读挂载进来的宿主机 /proc，容器内也能反映真实宿主机
  const hostPath = path.join(HOST_PROC, rel);
  try {
    return fs.readFileSync(hostPath, 'utf8');
  } catch {
    try {
      return fs.readFileSync(path.join(fallbackRoot, rel), 'utf8');
    } catch {
      return null;
    }
  }
}

function cpuSnapshot() {
  const text = readProc('stat');
  if (!text) return null;
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const p = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = p[3] + (p[4] || 0);
  const total = p.reduce((a, b) => a + b, 0);
  return { idle, total };
}

let lastCpu = null;

function cpuUsage() {
  const cur = cpuSnapshot();
  if (!cur) {
    // 退路：用 os.loadavg 近似
    const la = os.loadavg()[0] / (os.cpus().length || 1);
    return Math.min(100, Math.round(la * 100));
  }
  if (!lastCpu) {
    lastCpu = cur;
    return 0;
  }
  const dTotal = cur.total - lastCpu.total;
  const dIdle = cur.idle - lastCpu.idle;
  lastCpu = cur;
  if (dTotal <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 1000) / 10));
}

function memInfo() {
  const text = readProc('meminfo');
  if (!text) {
    const total = os.totalmem();
    const free = os.freemem();
    return {
      total,
      used: total - free,
      free,
      available: free,
      usedPercent: Math.round(((total - free) / total) * 1000) / 10,
      swapTotal: 0,
      swapUsed: 0,
    };
  }
  const get = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
    return m ? Number(m[1]) * 1024 : 0;
  };
  const total = get('MemTotal');
  const free = get('MemFree');
  const available = get('MemAvailable') || free;
  const used = total - available;
  const swapTotal = get('SwapTotal');
  const swapFree = get('SwapFree');
  return {
    total,
    used,
    free,
    available,
    usedPercent: total ? Math.round((used / total) * 1000) / 10 : 0,
    swapTotal,
    swapUsed: swapTotal - swapFree,
  };
}

function loadAvg() {
  const text = readProc('loadavg');
  if (!text) return os.loadavg();
  return text.trim().split(/\s+/).slice(0, 3).map(Number);
}

let lastNet = null;

function netInfo() {
  const text = readProc('net/dev');
  if (!text) return { rxRate: 0, txRate: 0, rxTotal: 0, txTotal: 0 };
  let rx = 0;
  let tx = 0;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\w+):\s*(.*)$/);
    if (!m) continue;
    const name = m[1];
    if (name === 'lo' || name.startsWith('veth') || name.startsWith('br-') || name.startsWith('docker')) continue;
    const cols = m[2].trim().split(/\s+/).map(Number);
    rx += cols[0] || 0;
    tx += cols[8] || 0;
  }
  const now = Date.now();
  let rxRate = 0;
  let txRate = 0;
  if (lastNet) {
    const dt = (now - lastNet.ts) / 1000;
    if (dt > 0) {
      rxRate = Math.max(0, (rx - lastNet.rx) / dt);
      txRate = Math.max(0, (tx - lastNet.tx) / dt);
    }
  }
  lastNet = { rx, tx, ts: now };
  return { rxRate, txRate, rxTotal: rx, txTotal: tx };
}

function pct(used, total) {
  if (!total) return 0;
  return Math.round((used / total) * 1000) / 10;
}

function diskInfo() {
  return new Promise((resolve) => {
    execFile('df', ['-kP', ...config.diskPaths], { timeout: 4000 }, (err, stdout) => {
      if (err || !stdout) {
        resolve([]);
        return;
      }
      const rows = stdout.trim().split('\n').slice(1);
      const out = rows
        .map((line) => {
          const cols = line.trim().split(/\s+/);
          if (cols.length < 6) return null;
          const total = Number(cols[1]) * 1024;
          const used = Number(cols[2]) * 1024;
          const avail = Number(cols[3]) * 1024;
          const mount = cols.slice(5).join(' ');
          if (!Number.isFinite(total) || total <= 0) return null;
          return { mount, fs: cols[0], total, used, avail, usedPercent: pct(used, total) };
        })
        .filter(Boolean);
      resolve(out);
    });
  });
}

function hostInfo() {
  const uptimeSec = (() => {
    const t = readProc('uptime');
    if (!t) return os.uptime();
    return Number(t.trim().split(/\s+/)[0]) || os.uptime();
  })();

  let osName = os.type();
  try {
    const rel = fs.readFileSync(path.join(HOST_PROC, '../etc/os-release'), 'utf8');
    const m = rel.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    if (m) osName = m[1];
  } catch {
    /* 容器内读不到宿主 os-release，退回 os.type */
  }

  const cpuText = readProc('cpuinfo') || '';
  const model = (cpuText.match(/^model name\s*:\s*(.+)$/m) || [])[1] || os.cpus()[0]?.model || 'unknown';
  const cores = (cpuText.match(/^processor\s*:/gm) || []).length || os.cpus().length;

  return {
    hostname: os.hostname(),
    os: osName,
    kernel: os.release(),
    arch: os.arch(),
    cores,
    cpuModel: model.trim(),
    uptime: uptimeSec,
    bootTime: Date.now() - uptimeSec * 1000,
  };
}

export async function collectSystem() {
  const mem = memInfo();
  const disks = await diskInfo();
  const info = hostInfo();
  return {
    ts: Date.now(),
    cpu: { usage: cpuUsage(), cores: info.cores },
    mem,
    load: loadAvg(),
    net: netInfo(),
    disks,
    info,
  };
}
