'use strict';
/**
 * 中转站余额获取。
 *
 * 背景：用户不用 Claude/Codex 官方账号，Codex 走中转站
 * （config.toml 里 model_provider = "custom"，base_url = "https://api.lumivia.cn"），
 * 所以原版「各 agent 账号剩余额度」拿不到 —— 官方额度接口需要登录态。
 * 中转站的余额接口同样需要鉴权，但形态与官方不同：
 *   - One API / New API 系（国内主流中转）：`GET /api/user/self`，需 `Authorization` 或 Cookie
 *   - 部分站点用 `/api/user/token`、`/v1/dashboard/billing/subscription`
 *
 * 本模块只做一件事：按用户配置的中转站信息拉余额，换算成 0~1 的比例。
 * 配置缺失或拉取失败时返回 null，调用方降级为"不显示余额环"，绝不编造数字。
 *
 * 配置来源（config.json）：
 *   relay: {
 *     baseUrl: 'https://api.lumivia.cn',
 *     token:  'sk-xxx',          // 或 cookie
 *     cookie: 'session=...',     // 二选一
 *     quotaPath: '/api/user/self',// 余额接口路径，默认 One API 系
 *     balanceField: 'quota',     // 响应里余额字段（默认 quota，单位通常是 1/500000 美元）
 *     usedField: 'used_quota',
 *   }
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const TIMEOUT_MS = 6000;

/** 余额单位换算：One API / New API 系用 quota，500000 quota = 1 美元。 */
const QUOTA_PER_UNIT = 500000;

/**
 * 拉中转站余额。
 * @param {object} relay 配置（见文件头说明）
 * @returns {Promise<{ok:boolean, ratio?:number, remain?:number, used?:number, total?:number, error?:string}>}
 */
function fetchRelayBalance(relay) {
  return new Promise((resolve) => {
    if (!relay || !relay.baseUrl || !relay.quotaPath) {
      return resolve({ ok: false, error: '未配置中转站余额接口' });
    }
    const auth = relay.token || relay.cookie;
    if (!auth) return resolve({ ok: false, error: '未配置中转站凭据（token 或 cookie）' });

    let u;
    try {
      u = new URL(relay.quotaPath, relay.baseUrl);
    } catch (e) {
      return resolve({ ok: false, error: 'baseUrl 无效: ' + relay.baseUrl });
    }

    const headers = {
      Accept: 'application/json',
      'User-Agent': 'AgentHUD/0.1',
    };
    if (relay.token) {
      // One API / New API 接受 "Bearer sk-xxx"；部分站点要裸 token，故两种都带上字段名
      headers.Authorization = /^Bearer\s/i.test(relay.token) ? relay.token : `Bearer ${relay.token}`;
    }
    if (relay.cookie) headers.Cookie = relay.cookie;

    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      { method: 'GET', headers, timeout: TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            return resolve({ ok: false, error: `HTTP ${res.statusCode}` });
          }
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            // 返回 HTML 说明鉴权失败被重定向到登录页
            return resolve({
              ok: false,
              error: text.trim().startsWith('<') ? '返回 HTML（凭据无效或需登录）' : '响应不是 JSON',
            });
          }
          const data = json && json.data ? json.data : json;
          const remainRaw = Number(data[relay.balanceField || 'quota']);
          const usedRaw = Number(data[relay.usedField || 'used_quota']);
          if (!Number.isFinite(remainRaw)) {
            return resolve({ ok: false, error: `响应里没有 ${relay.balanceField || 'quota'} 字段` });
          }
          const remain = remainRaw / QUOTA_PER_UNIT;
          const used = Number.isFinite(usedRaw) ? usedRaw / QUOTA_PER_UNIT : null;
          const total = used != null ? remain + used : null;
          const ratio = total && total > 0 ? Math.max(0, Math.min(1, remain / total)) : null;
          resolve({ ok: true, ratio, remain, used, total });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: '请求超时' });
    });
    req.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
    req.end();
  });
}

module.exports = { fetchRelayBalance, QUOTA_PER_UNIT };
