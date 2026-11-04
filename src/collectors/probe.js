import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import { URL } from 'node:url';
import { config } from '../config.js';

function requestOnce(url, method, timeout, authHeader) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      resolve({ ok: false, error: 'invalid url', ms: 0, status: 0 });
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const started = Date.now();
    const headers = {
      'User-Agent': 'ARGUS-Monitor/1.0',
      Accept: '*/*',
      'Accept-Encoding': 'identity',
    };
    if (authHeader) headers.Authorization = authHeader;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        timeout,
        rejectUnauthorized: false,
        headers,
      },
      (res) => {
        res.resume();
        resolve({
          ok: true,
          status: res.statusCode || 0,
          ms: Date.now() - started,
          headers: res.headers,
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message, ms: Date.now() - started, status: 0 }));
    req.end();
  });
}

// ARGUS 自己的站点也受 Basic 认证保护，探针不带凭据会被自己拦在门外，
// 表现为「站点宕机 · 401」。这里在首次收到 401 时带凭据重试一次。
function basicAuthHeader() {
  if (!config.authUser || !config.authPass) return null;
  return `Basic ${Buffer.from(`${config.authUser}:${config.authPass}`).toString('base64')}`;
}

async function probeRequest(url, timeout) {
  const first = await requestOnce(url, 'GET', timeout);
  if (first.ok && first.status === 401) {
    const hdr = basicAuthHeader();
    if (hdr) {
      const retry = await requestOnce(url, 'GET', timeout, hdr);
      if (retry.ok) return retry;
    }
  }
  return first;
}

// 证书到期：单独开 TLS 连接读 peer certificate
function certInfo(host, port = 443, timeout = 6000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    try {
      const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout }, () => {
        const cert = sock.getPeerCertificate();
        sock.end();
        if (!cert || !cert.valid_to) {
          finish(null);
          return;
        }
        const expires = new Date(cert.valid_to).getTime();
        finish({
          subject: cert.subject?.CN || host,
          issuer: cert.issuer?.O || cert.issuer?.CN || '',
          validFrom: new Date(cert.valid_from).getTime(),
          expires,
          daysLeft: Math.floor((expires - Date.now()) / 86400000),
        });
      });
      sock.on('error', () => finish(null));
      sock.on('timeout', () => {
        sock.destroy();
        finish(null);
      });
    } catch {
      finish(null);
    }
  });
}

// 把 nginx 站点 + 手动目标合并成统一探测列表
export function buildTargets(nginxSites = []) {
  const map = new Map();

  for (const s of nginxSites) {
    if (!s.url) continue;
    const key = s.domain;
    if (map.has(key)) continue;
    map.set(key, {
      id: `site-${key}`,
      name: key,
      url: s.url,
      group: 'nginx 子域',
      source: 'nginx',
      upstream: s.upstream,
      host: s.domain,
      checkTls: s.scheme === 'https',
    });
  }

  for (const t of config.manualTargets) {
    const key = t.id || t.url;
    map.set(key, {
      id: key,
      name: t.name || t.url,
      url: t.url,
      group: t.group || '手动',
      source: 'manual',
      expect: t.expect || 200,
      checkTls: t.url.startsWith('https://'),
      host: (() => {
        try {
          return new URL(t.url).hostname;
        } catch {
          return null;
        }
      })(),
    });
  }

  return [...map.values()];
}

const state = new Map(); // id -> { fails, lastOk, latencyHistory }

export async function probeAll(targets) {
  const results = await Promise.all(
    targets.map(async (t) => {
      const r = await probeRequest(t.url, config.probeTimeout);
      const st = state.get(t.id) || { fails: 0, lastOk: null, latency: [], uptimeSince: null, everUp: false };

      let ok;
      if (r.ok) {
        ok = t.expect ? r.status === t.expect || (r.status >= 200 && r.status < 400) : r.status >= 200 && r.status < 400;
      } else {
        ok = false;
      }

      if (ok) {
        st.fails = 0;
        st.everUp = true;
        st.lastOk = Date.now();
        if (!st.uptimeSince) st.uptimeSince = Date.now();
        st.latency.push(r.ms);
        if (st.latency.length > 20) st.latency.shift();
      } else {
        st.fails += 1;
        if (st.fails >= config.failThreshold) st.uptimeSince = null;
      }
      state.set(t.id, st);

      let cert = null;
      if (t.checkTls && t.host) {
        cert = await certInfo(t.host, 443, config.probeTimeout);
      }

      // 从未成功过的目标直接判失败，不享受"容错一次"的宽限
      const up = ok || (st.everUp && st.fails < config.failThreshold);
      return {
        ...t,
        ok: up,
        hardFail: st.fails >= config.failThreshold,
        status: r.status,
        latency: r.ms,
        avgLatency: st.latency.length ? Math.round(st.latency.reduce((a, b) => a + b, 0) / st.latency.length) : null,
        error: r.error || null,
        fails: st.fails,
        lastOk: st.lastOk,
        uptimeSince: st.uptimeSince,
        cert,
        checkedAt: Date.now(),
      };
    })
  );
  return results;
}

export { requestOnce, certInfo, probeRequest };
