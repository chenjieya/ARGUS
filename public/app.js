/* ARGUS 前端运行时 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    snapshot: null,
    targets: [],
    docker: { available: false, containers: [], summary: {} },
    nginx: { available: false, sites: [] },
    history: { ts: [], cpu: [], mem: [], load: [], netIn: [], netOut: [] },
    siteFilter: 'all',
    dockerFilter: 'all',
    wsOk: false,
  };

  // ── 工具 ──
  const fmtBytes = (n) => {
    if (!n && n !== 0) return '--';
    const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
  };
  const fmtRate = (n) => `${fmtBytes(n)}/s`;
  const fmtDur = (sec) => {
    if (!sec && sec !== 0) return '--';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };
  const fmtTime = (ts) => {
    const d = new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── 时钟 ──
  function tickClock() {
    const d = new Date();
    $('clock').textContent = d.toLocaleTimeString('zh-CN', { hour12: false });
    $('dateline').textContent = d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  }
  tickClock();
  setInterval(tickClock, 1000);

  // ── 概览渲染 ──
  const GAUGE_LEN = 327;

  function setGauge(kind, pct) {
    const el = document.querySelector(`.gauge[data-kind="${kind}"] .gauge-bar`);
    if (!el) return;
    const p = clamp(pct || 0, 0, 100);
    el.style.strokeDashoffset = String(GAUGE_LEN - (GAUGE_LEN * p) / 100);
    el.style.stroke = p >= 90 ? 'var(--red)' : p >= 75 ? 'var(--amber)' : kind === 'mem' ? 'var(--purple)' : 'var(--cyan)';
  }

  function renderSystem(s) {
    if (!s) return;
    $('cpuVal').textContent = Math.round(s.cpu.usage);
    setGauge('cpu', s.cpu.usage);
    $('cpuSub').textContent = `${s.info.cores} 核 · 负载 ${s.load.map((x) => x.toFixed(2)).join(' / ')}`;

    $('memVal').textContent = Math.round(s.mem.usedPercent);
    setGauge('mem', s.mem.usedPercent);
    $('memSub').textContent = `${fmtBytes(s.mem.used)} / ${fmtBytes(s.mem.total)}`;

    $('netIn').textContent = fmtRate(s.net.rxRate);
    $('netTx').textContent = fmtRate(s.net.txRate);
    $('netSub').textContent = `累计 ↓${fmtBytes(s.net.rxTotal)} ↑${fmtBytes(s.net.txTotal)}`;

    $('uptimeVal').textContent = fmtDur(s.info.uptime);
    $('kernelLine').textContent = `${s.info.os} · ${s.info.arch}`;
    $('bootLine').textContent = `启动于 ${new Date(s.info.bootTime).toLocaleString('zh-CN', { hour12: false })}`;
    $('hostline').textContent = `${s.info.hostname} · ${s.info.cpuModel}`;

    renderDisks(s.disks);
  }

  function renderDisks(disks) {
    const box = $('diskList');
    if (!disks || !disks.length) {
      box.innerHTML = '<div class="empty">未采集到磁盘信息</div>';
      return;
    }
    box.innerHTML = disks
      .map((d) => {
        const warn = d.usedPercent >= 90 ? ' warn' : '';
        return `<div class="disk-item">
          <div class="disk-top"><b>${esc(d.mount)}</b><span>${d.usedPercent}% · ${fmtBytes(d.avail)} 可用</span></div>
          <div class="disk-track"><i class="${warn.trim()}" style="width:${clamp(d.usedPercent, 0, 100)}%"></i></div>
        </div>`;
      })
      .join('');
  }

  function renderDocker() {
    const d = state.docker;
    const s = d.summary || {};
    $('ctrRunning').textContent = s.running ?? '--';
    $('ctrTotal').textContent = `/${s.total ?? '--'}`;
    $('ctrCpu').textContent = `CPU ${s.cpu ?? 0}%`;
    $('ctrMem').textContent = `MEM ${fmtBytes(s.mem || 0)}`;
    $('ctrUnhealthy').textContent = s.unhealthy ? `⚠ ${s.unhealthy} 个 unhealthy` : d.available ? '全部健康' : 'docker 未接入';
    $('ctrCount').textContent = d.available ? `${s.running}/${s.total} running` : '';

    const body = $('dockerBody');
    if (!d.available) {
      body.innerHTML = `<div class="empty">没能连上 docker daemon<br/><small>${esc(d.error || '检查 socket 挂载')}</small></div>`;
      return;
    }

    let list = d.containers || [];
    if (state.dockerFilter === 'running') list = list.filter((c) => c.state === 'running');
    else if (state.dockerFilter === 'stopped') list = list.filter((c) => c.state !== 'running');

    if (!list.length) {
      body.innerHTML = '<div class="empty">没有匹配的容器</div>';
      return;
    }

    const groups = new Map();
    for (const c of list) {
      const key = state.dockerFilter === 'project' ? c.project || '独立容器' : c.project || '独立容器';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }

    const html = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([name, items]) => {
        const running = items.filter((c) => c.state === 'running').length;
        const workdir = items.find((c) => c.workdir)?.workdir || '';
        return `<div class="project-block">
          <div class="project-head">
            <b>${esc(name)}</b>
            <span class="pwd">${esc(workdir)} · ${running}/${items.length}</span>
          </div>
          <div class="ctr-grid">
            ${items.map(renderContainer).join('')}
          </div>
        </div>`;
      })
      .join('');

    body.innerHTML = html;
  }

  function renderContainer(c) {
    const st = c.stats;
    const cpu = st ? st.cpuPercent : 0;
    const mem = st && st.memLimit ? st.memPercent : 0;
    const isUp = c.state === 'running';
    return `<div class="ctr ${isUp ? '' : 'stopped'}">
      <div class="ctr-top">
        <span class="status-dot ${isUp ? 'up' : 'down'}" style="background:${isUp ? 'var(--green)' : 'var(--red)'};box-shadow:0 0 8px ${isUp ? 'var(--green)' : 'var(--red)'}"></span>
        <span class="ctr-name" title="${esc(c.name)}">${esc(c.service || c.name)}</span>
        <span class="badge ${isUp ? 'ok' : 'bad'}">${esc(c.state)}</span>
      </div>
      <div class="ctr-img" title="${esc(c.image)}">${esc(c.image)}${c.ports.length ? ` · ${esc(c.ports.join(' '))}` : ''}</div>
      <div class="ctr-bars">
        <div class="mini-bar">
          <div class="lbl"><span>CPU</span><span>${cpu.toFixed(1)}%</span></div>
          <div class="track"><i style="width:${clamp(cpu, 0, 100)}%"></i></div>
        </div>
        <div class="mini-bar mem">
          <div class="lbl"><span>MEM</span><span>${st ? fmtBytes(st.memUsage) : '--'}</span></div>
          <div class="track"><i style="width:${clamp(mem, 0, 100)}%"></i></div>
        </div>
      </div>
    </div>`;
  }

  function renderTargets() {
    const all = state.targets || [];
    const up = all.filter((t) => t.ok).length;
    $('siteUp').textContent = up;
    $('siteTotal').textContent = `/${all.length}`;
    $('siteCount').textContent = all.length ? `${up}/${all.length} 在线` : '';
    $('siteSub').textContent = all.length ? `最近探测 ${fmtTime(all[0].checkedAt || Date.now())}` : '等待首轮探测';

    const bars = $('siteBars');
    bars.innerHTML = all
      .slice(0, 16)
      .map((t) => `<i class="${t.ok ? '' : 'down'}" title="${esc(t.name)}"></i>`)
      .join('');

    const grid = $('siteGrid');
    let list = all;
    if (state.siteFilter === 'up') list = all.filter((t) => t.ok);
    else if (state.siteFilter === 'down') list = all.filter((t) => !t.ok);

    if (!list.length) {
      grid.innerHTML = '<div class="empty">没有匹配的站点</div>';
      return;
    }

    grid.innerHTML = list
      .map((t) => {
        const cls = t.ok ? 'up' : 'unknown';
        const lat = t.avgLatency || t.latency || 0;
        const latPct = clamp((lat / 1200) * 100, 3, 100);
        const cert = t.cert ? `<span class="badge ${t.cert.daysLeft > 14 ? '' : 'warn'}">TLS ${t.cert.daysLeft}d</span>` : '';
        return `<div class="site ${cls}">
          <div class="site-top">
            <div>
              <div class="site-name">${esc(t.name)}</div>
              <div class="site-host">${esc(t.url)}</div>
            </div>
            <span class="status-dot"></span>
          </div>
          <div class="site-meta">
            <span class="badge ${t.ok ? 'ok' : 'bad'}">${t.ok ? 'ONLINE' : 'FAIL'}</span>
            <span class="badge">${t.status || t.error || '--'}</span>
            <span class="badge">${lat}ms</span>
            ${cert}
          </div>
          <div class="lat-bar"><i style="width:${latPct}%"></i></div>
        </div>`;
      })
      .join('');
  }

  function renderNginx() {
    const n = state.nginx;
    const box = $('nginxList');
    if (!n.available) {
      box.innerHTML = `<div class="empty">${esc(n.error || '未接入 nginx 配置')}</div>`;
      return;
    }
    const sites = n.sites || [];
    if (!sites.length) {
      box.innerHTML = '<div class="empty">配置里没解析出 server 块</div>';
      return;
    }
    box.innerHTML = sites
      .map(
        (s) => `<div class="nginx-item">
        <div class="dom"><span>${esc(s.domain)}</span><span class="badge">${esc(String(s.port))}</span></div>
        <div class="up">${s.upstream ? `→ <span>${esc(s.upstream)}</span>` : s.root ? `root <span>${esc(s.root)}</span>` : '<span>静态</span>'}</div>
      </div>`
      )
      .join('');
  }

  function renderEvents(events) {
    const box = $('eventList');
    if (!events || !events.length) {
      box.innerHTML = '<div class="empty">暂无事件</div>';
      return;
    }
    box.innerHTML = events
      .slice(0, 30)
      .map(
        (e) => `<div class="event-item ${e.level}">
        <span class="t">${fmtTime(e.ts)}</span>
        <span class="txt"><b>${esc(e.title)}</b><small>${esc(e.detail)}</small></span>
      </div>`
      )
      .join('');
  }

  function setHealth(h) {
    const pill = $('healthPill');
    const map = {
      ok: ['pill-ok', '全部正常'],
      degraded: ['pill-warn', '部分异常'],
      critical: ['pill-critical', '严重故障'],
      unknown: ['pill-unknown', '待探测'],
    };
    const [cls, text] = map[h] || map.unknown;
    pill.className = `pill ${cls}`;
    $('healthText').textContent = text;
  }

  // ── Canvas 图表 ──
  function fitCanvas(cv) {
    const dpr = window.devicePixelRatio || 1;
    const rect = cv.getBoundingClientRect();
    const w = rect.width || 600;
    // 高度取布局盒（CSS 固定 200px），不能用 attribute —— 它每帧都会被本函数改写
    const h = rect.height || 200;
    if (cv.width !== Math.floor(w * dpr) || cv.height !== Math.floor(h * dpr)) {
      cv.width = Math.floor(w * dpr);
      cv.height = Math.floor(h * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function drawGrid(ctx, w, h, pad) {
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(94,234,255,0.08)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i += 1) {
      const y = pad + ((h - pad * 2) / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(w - pad, y);
      ctx.stroke();
    }
    for (let i = 0; i <= 6; i += 1) {
      const x = pad + ((w - pad * 2) / 6) * i;
      ctx.beginPath();
      ctx.moveTo(x, pad);
      ctx.lineTo(x, h - pad);
      ctx.strokeStyle = 'rgba(94,234,255,0.045)';
      ctx.stroke();
    }
  }

  function drawSeries(ctx, data, w, h, pad, color, maxVal, fill) {
    if (!data.length) return;
    const n = data.length;
    const stepX = (w - pad * 2) / Math.max(1, n - 1);
    const y = (v) => h - pad - (clamp(v, 0, maxVal) / maxVal) * (h - pad * 2);
    ctx.beginPath();
    data.forEach((v, i) => {
      const px = pad + stepX * i;
      const py = y(v);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.9;
    ctx.lineJoin = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = 9;
    ctx.stroke();
    ctx.shadowBlur = 0;

    if (fill) {
      ctx.lineTo(pad + stepX * (n - 1), h - pad);
      ctx.lineTo(pad, h - pad);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, pad, 0, h - pad);
      g.addColorStop(0, fill);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fill();
    }
  }

  function drawRes() {
    const cv = $('chartRes');
    const { ctx, w, h } = fitCanvas(cv);
    const pad = 12;
    drawGrid(ctx, w, h, pad);
    const H = state.history;
    const loadMax = Math.max(4, ...H.load.map((x) => x * 10));
    drawSeries(ctx, H.cpu, w, h, pad, 'rgba(0,229,255,0.95)', 100, 'rgba(0,229,255,0.22)');
    drawSeries(ctx, H.mem, w, h, pad, 'rgba(168,85,247,0.95)', 100, 'rgba(168,85,247,0.18)');
    // 负载折算到百分比轴：load/cores*100
    const cores = state.snapshot?.system?.info?.cores || 1;
    drawSeries(ctx, H.load.map((x) => (x / cores) * 100), w, h, pad, 'rgba(245,158,11,0.9)', Math.max(100, loadMax), null);
  }

  function drawNet() {
    const cv = $('chartNet');
    const { ctx, w, h } = fitCanvas(cv);
    const pad = 12;
    drawGrid(ctx, w, h, pad);
    const H = state.history;
    const max = Math.max(1024, ...H.netIn, ...H.netOut);
    drawSeries(ctx, H.netIn, w, h, pad, 'rgba(34,211,238,0.95)', max, 'rgba(34,211,238,0.2)');
    drawSeries(ctx, H.netOut, w, h, pad, 'rgba(244,114,182,0.95)', max, 'rgba(244,114,182,0.16)');
  }

  let rafPending = false;
  function scheduleDraw() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      drawRes();
      drawNet();
    });
  }
  window.addEventListener('resize', scheduleDraw);

  // ── WebSocket ──
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => {
      state.wsOk = true;
      $('wsState').textContent = 'socket: live';
      $('wsState').style.color = 'var(--green)';
    };

    ws.onclose = () => {
      state.wsOk = false;
      $('wsState').textContent = 'socket: reconnecting';
      $('wsState').style.color = 'var(--amber)';
      setTimeout(connect, 2500);
    };

    ws.onerror = () => ws.close();

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      apply(msg.type, msg.data);
    };
  }

  function apply(type, data) {
    if (type === 'snapshot') {
      state.snapshot = data;
      state.targets = data.targets || [];
      state.docker = data.docker || state.docker;
      state.nginx = data.nginx || state.nginx;
      if (data.history) state.history = data.history;
      $('ver').textContent = data.version || 'dev';
      renderSystem(data.system);
      renderDocker();
      renderTargets();
      renderNginx();
      renderEvents(data.events);
      if (data.summary) setHealth(data.summary.health);
      scheduleDraw();
      return;
    }

    if (type === 'system') {
      state.snapshot = state.snapshot || {};
      state.snapshot.system = data.system;
      if (data.history) state.history = data.history;
      renderSystem(data.system);
      scheduleDraw();
      return;
    }

    if (type === 'docker') {
      state.docker = data;
      renderDocker();
      if (state.snapshot?.summary) {
        state.snapshot.summary.containersRunning = (data.summary || {}).running || 0;
      }
      return;
    }

    if (type === 'nginx') {
      state.nginx = data;
      renderNginx();
      return;
    }

    if (type === 'targets') {
      state.targets = data.targets || [];
      renderTargets();
      if (data.summary) setHealth(data.summary.health);
    }
  }

  // ── 过滤交互 ──
  document.querySelectorAll('[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-filter]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.siteFilter = btn.dataset.filter;
      renderTargets();
    });
  });

  document.querySelectorAll('[data-dfilter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-dfilter]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.dockerFilter = btn.dataset.dfilter;
      renderDocker();
    });
  });

  connect();
})();
