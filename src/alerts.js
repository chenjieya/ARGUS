import { config } from './config.js';
import { store } from './store.js';

const lastSent = new Map();

function cooldownOk(key) {
  const now = Date.now();
  const prev = lastSent.get(key) || 0;
  if (now - prev < config.alertCooldown) return false;
  lastSent.set(key, now);
  return true;
}

function emit(level, title, detail, key) {
  if (key && !cooldownOk(key)) return;
  const ev = { ts: Date.now(), level, title, detail: detail || '' };
  store.addEvent(ev);

  if (config.alertWebhook) {
    const payload = JSON.stringify({ source: 'ARGUS', ...ev });
    fetch(config.alertWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    }).catch(() => {
      /* 告警通道失败不影响主流程 */
    });
  }
}

export const alert = {
  info: (title, detail, key) => emit('info', title, detail, key),
  warn: (title, detail, key) => emit('warn', title, detail, key),
  error: (title, detail, key) => emit('error', title, detail, key),

  // 站点状态跃迁只在变化时发声
  checkTargets(prev, next) {
    const before = new Map((prev || []).map((t) => [t.id, t]));
    for (const t of next) {
      const old = before.get(t.id);
      if (!old) continue;
      if (old.ok && !t.ok) {
        alert.error(`站点宕机 · ${t.name}`, `${t.url} · ${t.error || `HTTP ${t.status}`}`, `down:${t.id}`);
      } else if (!old.ok && t.ok) {
        alert.info(`站点恢复 · ${t.name}`, `${t.url} · ${t.latency}ms`, `up:${t.id}`);
      }
      if (old.status !== t.status && t.ok && old.ok && t.status >= 500) {
        alert.warn(`5xx 响应 · ${t.name}`, `${t.url} -> HTTP ${t.status}`, `5xx:${t.id}`);
      }
    }
  },

  checkContainers(prev, next) {
    if (!next.available) return;
    const before = new Map((prev?.containers || []).map((c) => [c.id, c]));
    for (const c of next.containers) {
      const old = before.get(c.id);
      if (!old) continue;
      if (old.state === 'running' && c.state !== 'running') {
        alert.error(`容器退出 · ${c.name}`, `${c.image} -> ${c.status}`, `ctr:${c.id}`);
      } else if (old.state !== 'running' && c.state === 'running') {
        alert.info(`容器启动 · ${c.name}`, c.image, `ctr-up:${c.id}`);
      }
    }
  },

  checkResources(sample) {
    if (!sample) return;
    if (sample.cpu.usage >= config.cpuWarn) {
      alert.warn('CPU 高负载', `${sample.cpu.usage}% 已超阈值 ${config.cpuWarn}%`, 'cpu');
    }
    if (sample.mem.usedPercent >= config.memWarn) {
      alert.warn('内存紧张', `${sample.mem.usedPercent}% 已超阈值 ${config.memWarn}%`, 'mem');
    }
    for (const d of sample.disks) {
      if (d.usedPercent >= config.diskWarn) {
        alert.warn(`磁盘将满 · ${d.mount}`, `${d.usedPercent}% 已超阈值 ${config.diskWarn}%`, `disk:${d.mount}`);
      }
    }
  },

  checkCerts(targets) {
    for (const t of targets) {
      if (!t.cert) continue;
      if (t.cert.daysLeft <= config.tlsWarnDays && t.cert.daysLeft >= 0) {
        alert.warn(`证书即将过期 · ${t.name}`, `剩余 ${t.cert.daysLeft} 天（${t.cert.issuer}）`, `cert:${t.id}`);
      } else if (t.cert.daysLeft < 0) {
        alert.error(`证书已过期 · ${t.name}`, `${t.cert.issuer}`, `cert-exp:${t.id}`);
      }
    }
  },
};
