'use strict';

/** 临时验证（用完即删）：读 DSH 环的金额标签与悬停提示。 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  ready() {
    return new Promise((r) => this.ws.addEventListener('open', r));
  }
  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails));
    return r.result ? r.result.value : undefined;
  }
}

(async () => {
  const targets = await (await fetch('http://127.0.0.1:9225/json/list')).json();
  const page = targets.find((t) => t.type === 'page');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.reload');
  // 等重载 + 第一轮汇总（worker 首跑约 2-4s）
  await sleep(6500);
  const out = await cdp.eval(`(async () => {
    // 等到 .mark 出现为止（最多 20s），避免 reload 后读空
    for (let i = 0; i < 100; i++) {
      if (document.querySelectorAll('.mark-cost').length) break;
      await new Promise(r => setTimeout(r, 200));
    }
    const costs = [...document.querySelectorAll('.mark-cost')].map(e => ({ text: e.textContent.trim(), tip: e.getAttribute('title') }));
    const marks = [...document.querySelectorAll('.mark')].map(m => m.getAttribute('title'));
    const dash = [...document.querySelectorAll('.ring-value')].map(e => e.getAttribute('style'));
    return { costs, marks, dash };
  })()`);
  console.log('金额标签:', JSON.stringify(out.costs));
  console.log('环弧样式:', JSON.stringify(out.dash));
  for (const t of out.marks) console.log('mark title:', t);
  process.exit(0);
})().catch((e) => {
  console.error('FAIL', e && e.message);
  process.exit(1);
});
