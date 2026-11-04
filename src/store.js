import { config } from './config.js';

// 进程级单例状态：最新快照 + 定长历史序列
class Store {
  constructor() {
    this.startedAt = Date.now();
    this.system = null; // 最新一次宿主机采样
    this.docker = { available: false, error: null, containers: [], summary: {} };
    this.nginx = { available: false, error: null, sites: [], upstreams: [] };
    this.targets = []; // 探测结果
    this.events = []; // 最近事件（时间倒序）
    this.history = {
      ts: [],
      cpu: [],
      mem: [],
      load: [],
      netIn: [],
      netOut: [],
    };
  }

  pushSystem(sample) {
    const h = this.history;
    const cap = config.historySize;
    h.ts.push(sample.ts);
    h.cpu.push(sample.cpu.usage);
    h.mem.push(sample.mem.usedPercent);
    h.load.push(sample.load[0]);
    h.netIn.push(sample.net.rxRate);
    h.netOut.push(sample.net.txRate);
    for (const k of Object.keys(h)) {
      if (h[k].length > cap) h[k].shift();
    }
    this.system = sample;
  }

  addEvent(ev) {
    this.events.unshift(ev);
    if (this.events.length > 200) this.events.length = 200;
  }

  snapshot() {
    const dockerUp = this.docker.containers.filter((c) => c.state === 'running').length;
    const siteUp = this.targets.filter((t) => t.ok).length;
    return {
      now: Date.now(),
      startedAt: this.startedAt,
      version: process.env.APP_VERSION || 'dev',
      system: this.system,
      docker: this.docker,
      nginx: this.nginx,
      targets: this.targets,
      events: this.events.slice(0, 40),
      history: this.history,
      summary: {
        containersRunning: dockerUp,
        containersTotal: this.docker.containers.length,
        sitesUp: siteUp,
        sitesTotal: this.targets.length,
        health: this.overallHealth(siteUp),
      },
    };
  }

  overallHealth(siteUp) {
    if (!this.targets.length) return 'unknown';
    const down = this.targets.length - siteUp;
    if (down === 0) return 'ok';
    if (siteUp === 0) return 'critical';
    return 'degraded';
  }
}

export const store = new Store();
