import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

// ── 极简 nginx 解析器 ─────────────────────────────────────
// 目标不是完整实现 nginx 语法，而是把「server 块 -> 域名 / 端口 / 上游 / 证书」抽出来
function stripComments(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');
}

function tokenize(text) {
  const tokens = [];
  let buf = '';
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '}' || ch === ';') {
      if (buf.trim()) tokens.push(buf.trim());
      buf = '';
      tokens.push(ch);
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf.trim()) tokens.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) tokens.push(buf.trim());
  return tokens;
}

function parseBlock(tokens, start, end) {
  // 返回 [{ directive: [args], children: [...] }]
  const nodes = [];
  let i = start;
  while (i < end) {
    const t = tokens[i];
    if (t === '}') break;
    if (t === '{' || t === ';') {
      i += 1;
      continue;
    }
    const args = [t];
    i += 1;
    while (i < end && tokens[i] !== ';' && tokens[i] !== '{' && tokens[i] !== '}') {
      args.push(tokens[i]);
      i += 1;
    }
    if (tokens[i] === '{') {
      const res = parseBlock(tokens, i + 1, end);
      nodes.push({ directive: args, children: res.nodes });
      i = res.i + 1;
    } else {
      nodes.push({ directive: args, children: [] });
      if (tokens[i] === ';') i += 1;
    }
  }
  return { nodes, i };
}

function collectFiles(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(full, out, depth + 1);
    else if (e.isFile() && !e.name.startsWith('.')) out.push(full);
  }
  return out;
}

function walk(nodes, visit, ctx = {}) {
  for (const n of nodes) {
    visit(n, ctx);
    if (n.children?.length) walk(n.children, visit, ctx);
  }
}

function findServers(nodes, file, out) {
  for (const n of nodes) {
    if (n.directive[0] === 'server' && n.children.length) {
      const s = {
        file,
        serverNames: [],
        listens: [],
        upstream: null,
        root: null,
        ssl: false,
        cert: null,
        sslForced: false,
        locations: [],
        internal: false,
      };
      walk(n.children, (c, _ctx) => {
        const [d, ...args] = c.directive;
        if (d === 'server_name') s.serverNames.push(...args);
        else if (d === 'listen') s.listens.push(args[0]);
        else if (d === 'return' && args.join(' ').includes('https://')) s.sslForced = true;
        else if (d === 'ssl_certificate') {
          s.ssl = true;
          s.cert = args[0];
        } else if (d === 'root') s.root = args[0];
      });
      // location 里的 proxy_pass / root
      for (const loc of n.children.filter((x) => x.directive[0] === 'location')) {
        const pathArg = loc.directive[1] || '/';
        let pass = null;
        let root = null;
        walk(loc.children, (c) => {
          if (c.directive[0] === 'proxy_pass') pass = c.directive[1];
          if (c.directive[0] === 'root') root = c.directive[1];
          if (c.directive[0] === 'alias') root = c.directive.slice(1).join(' ');
        });
        s.locations.push({ path: pathArg, proxy: pass, root });
        if (!s.upstream && pass) s.upstream = pass;
      }
      if (!s.root) {
        const r = s.locations.find((l) => l.root);
        if (r) s.root = r.root;
      }
      out.push(s);
    }
    if (n.children?.length) findServers(n.children, file, out);
  }
}

function buildUrl(primary, isHttps, port) {
  if (primary === '_') return null;
  const scheme = isHttps ? 'https' : 'http';
  const defaultPort = isHttps ? 443 : 80;
  return port === defaultPort ? `${scheme}://${primary}/` : `${scheme}://${primary}:${port}/`;
}

let logOffsets = new Map();

function accessStats() {
  // 粗粒度请求数统计：读 access.log 尾部若干字节，统计最近窗口内的 2xx/4xx/5xx
  const files = ['access.log', 'default.access.log'];
  let total = 0;
  let errors = 0;
  const perSite = {};
  for (const f of files) {
    const full = path.join(config.nginxLogDir, f);
    let fd;
    try {
      fd = fs.openSync(full, 'r');
    } catch {
      continue;
    }
    try {
      const size = fs.fstatSync(fd).size;
      const window = 256 * 1024;
      const start = Math.max(0, size - window);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      for (const line of lines) {
        const m = line.match(/"(?:GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH) [^"]*" (\d{3})/);
        if (!m) continue;
        total += 1;
        const code = Number(m[1]);
        if (code >= 500) errors += 1;
        const host = (line.match(/^([^\s]+)\s/) || [])[1];
        if (host) perSite[host] = (perSite[host] || 0) + 1;
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return { total, errors, perSite };
}

export async function collectNginx() {
  const files = collectFiles(config.nginxConfDir);
  if (!files.length) {
    return { available: false, error: `未找到 nginx 配置目录 ${config.nginxConfDir}`, sites: [], upstreams: [] };
  }

  const servers = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (!/server\s*\{/m.test(text)) continue;
    try {
      const tokens = tokenize(stripComments(text));
      const { nodes } = parseBlock(tokens, 0, tokens.length);
      findServers(nodes, path.relative(config.nginxConfDir, f), servers);
    } catch {
      /* 单个文件解析失败不影响整体 */
    }
  }

  const sites = servers
    .filter((s) => s.serverNames.length)
    .map((s, idx) => {
      const names = s.serverNames.filter((n) => n !== '_' && n !== '');
      const listen = s.listens[0] || '80';
      const isHttps = /443|ssl/.test(listen) || s.ssl;
      const port = Number((listen.match(/:(\d+)/) || [])[1] || (isHttps ? 443 : 80));
      const primary = names[0] || '_';
      return {
        id: `nginx-${idx}-${primary}`,
        domain: primary,
        aliases: names.slice(1),
        listen,
        port,
        scheme: isHttps ? 'https' : 'http',
        url: buildUrl(primary, isHttps, port),
        upstream: s.upstream,
        root: s.root,
        ssl: s.ssl,
        cert: s.cert,
        file: s.file,
      };
    });

  const upstreams = [];
  for (const s of servers) {
    if (!s.upstream) continue;
    for (const name of s.serverNames.filter((n) => n && n !== '_')) {
      upstreams.push({ domain: name, upstream: s.upstream });
    }
  }

  const access = accessStats();

  return {
    available: true,
    error: null,
    confDir: config.nginxConfDir,
    files: files.length,
    sites,
    upstreams,
    access,
    collectedAt: Date.now(),
  };
}
