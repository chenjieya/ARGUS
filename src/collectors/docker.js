import http from 'node:http';
import { config } from '../config.js';

// 通过 unix socket 直接和 docker daemon 对话，零依赖
function dockerGet(pathname, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const opts = {
      socketPath: config.dockerSocket,
      path: pathname,
      method: 'GET',
      timeout,
      headers: { Host: 'docker' },
    };
    const req = http.request(opts, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
      });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`docker api ${pathname} -> ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(buf || 'null'));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('docker api timeout')));
    req.on('error', reject);
    req.end();
  });
}

function calcStats(s) {
  if (!s) return null;
  const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage || 0) - (s.precpu_stats?.cpu_usage?.total_usage || 0);
  const sysDelta = (s.cpu_stats?.system_cpu_usage || 0) - (s.precpu_stats?.system_cpu_usage || 0);
  const online = s.cpu_stats?.online_cpus || s.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  let cpuPercent = 0;
  if (sysDelta > 0 && cpuDelta > 0) cpuPercent = (cpuDelta / sysDelta) * online * 100;

  const memUsage = (s.memory_stats?.usage || 0) - (s.memory_stats?.stats?.cache || 0);
  const memLimit = s.memory_stats?.limit || 0;

  let rx = 0;
  let tx = 0;
  for (const [iface, v] of Object.entries(s.networks || {})) {
    if (iface === 'lo') continue;
    rx += v.rx_bytes || 0;
    tx += v.tx_bytes || 0;
  }

  let blkRead = 0;
  let blkWrite = 0;
  for (const e of s.blkio_stats?.io_service_bytes_recursive || []) {
    const op = (e.op || '').toLowerCase();
    if (op === 'read') blkRead += e.value || 0;
    if (op === 'write') blkWrite += e.value || 0;
  }

  return {
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memUsage,
    memLimit,
    memPercent: memLimit ? Math.round((memUsage / memLimit) * 1000) / 10 : 0,
    netRx: rx,
    netTx: tx,
    blkRead,
    blkWrite,
    pids: s.pids_stats?.current || 0,
  };
}

// 从 compose 标签还原归属项目 / 服务名
function meta(c) {
  const labels = c.Labels || {};
  return {
    id: c.Id,
    shortId: (c.Id || '').slice(0, 12),
    name: (c.Names?.[0] || '').replace(/^\//, ''),
    image: (c.Image || '').split('@')[0],
    state: c.State,
    status: c.Status,
    created: (c.Created || 0) * 1000,
    project: labels['com.docker.compose.project'] || null,
    service: labels['com.docker.compose.service'] || null,
    workdir: labels['com.docker.compose.project.working_dir'] || null,
    ports: (c.Ports || [])
      .filter((p) => p.PublicPort)
      .map((p) => `${p.PublicPort}->${p.PrivatePort}/${p.Type}`),
  };
}

export async function collectDocker() {
  let list;
  try {
    list = await dockerGet('/containers/json?all=1');
  } catch (e) {
    return { available: false, error: e.message, containers: [], summary: {} };
  }
  if (!Array.isArray(list)) {
    return { available: false, error: 'unexpected docker response', containers: [], summary: {} };
  }

  const containers = list.map(meta);

  // 只对运行中的容器取 stats，且并发受限
  const running = containers.filter((c) => c.state === 'running');
  const CONCURRENCY = 6;
  for (let i = 0; i < running.length; i += CONCURRENCY) {
    const batch = running.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (c) => {
        try {
          const s = await dockerGet(`/containers/${c.id}/stats?stream=false&one-shot=true`, 3500);
          c.stats = calcStats(s);
        } catch {
          c.stats = null;
        }
      })
    );
  }

  const groups = {};
  for (const c of containers) {
    const key = c.project || '独立容器';
    if (!groups[key]) groups[key] = { name: key, workdir: c.workdir, total: 0, running: 0, cpu: 0, mem: 0, services: [] };
    const g = groups[key];
    g.total += 1;
    if (c.state === 'running') g.running += 1;
    g.cpu += c.stats?.cpuPercent || 0;
    g.mem += c.stats?.memUsage || 0;
    if (c.service) g.services.push(c.service);
  }

  const summary = {
    total: containers.length,
    running: running.length,
    stopped: containers.length - running.length,
    unhealthy: containers.filter((c) => c.status && c.status.includes('unhealthy')).length,
    cpu: Math.round(containers.reduce((a, c) => a + (c.stats?.cpuPercent || 0), 0) * 10) / 10,
    mem: containers.reduce((a, c) => a + (c.stats?.memUsage || 0), 0),
    groups: Object.values(groups).sort((a, b) => b.running - a.running),
  };

  return { available: true, error: null, containers, summary };
}
