import fs from 'node:fs';
import path from 'node:path';

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

function loadTargets() {
  const file = path.resolve(process.cwd(), 'config/targets.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (raw.targets || []).filter((t) => t && t.url);
  } catch {
    return [];
  }
}

export const config = {
  port: num(process.env.PORT, 8848),
  host: process.env.HOST || '0.0.0.0',
  authUser: process.env.AUTH_USER || '',
  authPass: process.env.AUTH_PASS || '',

  dockerSocket: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
  hostProc: process.env.HOST_PROC || '/host/proc',

  nginxConfDir: process.env.NGINX_CONF_DIR || '/etc/nginx-src',
  nginxLogDir: process.env.NGINX_LOG_DIR || '/var/log/nginx-src',

  diskPaths: (process.env.DISK_PATHS || '/host')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  metricInterval: num(process.env.METRIC_INTERVAL, 2000),
  dockerInterval: num(process.env.DOCKER_INTERVAL, 5000),
  probeInterval: num(process.env.PROBE_INTERVAL, 20000),
  nginxInterval: num(process.env.NGINX_INTERVAL, 30000),

  historySize: num(process.env.HISTORY_SIZE, 900),

  probeTimeout: num(process.env.PROBE_TIMEOUT, 8000),
  failThreshold: num(process.env.FAIL_THRESHOLD, 2),

  alertWebhook: process.env.ALERT_WEBHOOK || '',
  alertCooldown: num(process.env.ALERT_COOLDOWN, 300000),

  tlsWarnDays: num(process.env.TLS_WARN_DAYS, 14),
  cpuWarn: num(process.env.CPU_WARN, 90),
  memWarn: num(process.env.MEM_WARN, 92),
  diskWarn: num(process.env.DISK_WARN, 90),

  manualTargets: loadTargets(),
};
