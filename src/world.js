import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const TOOL_DECL = {
  name: 'tokenboard_usage',
  description:
    '查 Coopanion 自己的 token 用量（读本机 usage.jsonl 汇总，这次调用本身不花 token）：默认回今天+最近 7 天的调用量与总 token、今天的高峰时段、用量最大的几个模型、今天最烧的一轮对话。主人问「今天用了多少 token」「最近用量怎么样」「哪个模型烧得最多」时用。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      date: { type: 'string', maxLength: 10, description: '可选，YYYY-MM-DD；给了就返回那一天的逐小时明细，不给默认今天。' },
    },
    required: [],
  },
  tags: ['usage'],
  summary: { zh: '看自己这几天用了多少 token。', en: "Check Coopanion's own token usage." },
};

const ALERT_DECL = {
  name: 'tokenboard_setalert',
  description:
    '设置每天 token 用量提醒阈值（本机 usage.jsonl 口径，这次调用不花 token）。设了之后，当天总用量（输入+输出）一旦超过阈值就提醒主人一次，每天最多提醒一次；设 0 关闭。主人说「token 超过五千万提醒我」「把用量提醒关掉」时用。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      dailyTokens: { type: 'integer', minimum: 0, description: '每天的总 token 阈值（输入+输出）；0 = 关闭提醒。' },
    },
    required: ['dailyTokens'],
  },
  tags: ['usage'],
  summary: { zh: '设每天 token 用量提醒阈值。', en: 'Set the daily token usage alert threshold.' },
};

const EMPTY_HOUR = () => ({ calls: 0, input: 0, output: 0, hit: 0 });
const TTL_MS = 10000;
const ALERT_CHECK_MS = 60 * 1000;
/** 解析日志时一次读多少字节：分块处理，避免大文件解析时出现几倍的瞬时内存。 */
const READ_CHUNK = 4 * 1024 * 1024;
/** 计价方式：每个中转站一套（直充 / 套餐），只留合法数字，防止手改 config 写坏。 */
function cleanBilling(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  const keys = Object.keys(input).slice(0, 200);
  for (const key of keys) {
    if (!/^\d+$/.test(String(key))) continue;
    const v = input[key];
    if (!v || typeof v !== 'object') continue;
    const num = (x, dflt) => {
      const n = Number(x);
      if (!Number.isFinite(n) || n < 0) return dflt;
      return Math.min(n, 1e15);
    };
    out[String(key)] = {
      mode: v.mode === 'package' ? 'package' : 'topup',
      topupCny: num(v.topupCny, 1),
      topupQuota: num(v.topupQuota, 1) || 1,
      pkgCny: num(v.pkgCny, 0),
      pkgMonths: num(v.pkgMonths, 1) || 1,
      pkgQuota: num(v.pkgQuota, 0),
    };
  }
  return out;
}

const DEFAULT_RELAY_URL = 'http://127.0.0.1:8770/';
const DEFAULT_RELAY_SCRIPT = 'F:/AI/WorkBuddy-workspace/2026-11-03-11-56-09/RelayHub-service.bat';

function pad2(v) {
  return String(v).padStart(2, '0');
}

function trimNum(v) {
  const s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function fmtCn(n) {
  n = Number(n) || 0;
  const sign = n < 0 ? '-' : '';
  n = Math.abs(n);
  if (n >= 1e8) return sign + trimNum(n / 1e8) + '亿';
  if (n >= 1e4) return sign + trimNum(n / 1e4) + '万';
  return sign + Math.round(n).toLocaleString('en-US');
}

function localDateStr(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** 本地时区 ISO（带 ±hh:mm 偏移），和日志里 ts 的格式一致。 */
function localIso(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
    '.' + String(d.getMilliseconds()).padStart(3, '0') +
    sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60)
  );
}

function newDay() {
  return {
    hours: Array.from({ length: 24 }, EMPTY_HOUR),
    mins: new Map(),
    models: new Map(),
    runs: new Map(),
    sessions: new Map(),
    calls: 0,
    input: 0,
    output: 0,
    hit: 0,
    total: 0,
  };
}

function bump(map, key, inTok, outTok, hit) {
  let b = map.get(key);
  if (!b) {
    b = { calls: 0, input: 0, output: 0, hit: 0 };
    map.set(key, b);
  }
  b.calls++;
  b.input += inTok;
  b.output += outTok;
  b.hit += hit;
  return b;
}

function mergeRecord(days, r) {
  const ts = String(r.ts || '');
  if (ts.length < 16) return;
  const date = ts.slice(0, 10);
  const h = Number(ts.slice(11, 13));
  const mi = Number(ts.slice(14, 16));
  if (!(h >= 0 && h < 24) || !(mi >= 0 && mi < 60)) return;
  const inTok = Number(r.promptTokens) || 0;
  const outTok = Number(r.completionTokens) || 0;
  const hit = Number(r.cacheHitTokens) || 0;
  const model = String(r.model || 'unknown');

  let D = days.get(date);
  if (!D) {
    D = newDay();
    days.set(date, D);
  }
  D.calls++;
  D.input += inTok;
  D.output += outTok;
  D.hit += hit;

  const H = D.hours[h];
  H.calls++;
  H.input += inTok;
  H.output += outTok;
  H.hit += hit;

  bump(D.mins, h * 60 + mi, inTok, outTok, hit);
  bump(D.models, model, inTok, outTok, hit);

  const run = String(r.run || '');
  if (run) {
    let R = D.runs.get(run);
    if (!R) {
      R = { run, calls: 0, input: 0, output: 0, hit: 0, first: ts, last: ts, maxRound: 0 };
      D.runs.set(run, R);
    }
    R.calls++;
    R.input += inTok;
    R.output += outTok;
    R.hit += hit;
    if (ts < R.first) R.first = ts;
    if (ts > R.last) R.last = ts;
    const rd = Number(r.round) || 0;
    if (rd > R.maxRound) R.maxRound = rd;
  }

  // 会话/插件归因：主对话是 main，World 自有模型的调用是 worlds.<插件id>
  const sessId = String(r.sessionId || r.label || 'unknown');
  let S = D.sessions.get(sessId);
  if (!S) {
    S = { session: sessId, label: String(r.label || ''), calls: 0, input: 0, output: 0, hit: 0 };
    D.sessions.set(sessId, S);
  }
  S.calls++;
  S.input += inTok;
  S.output += outTok;
  S.hit += hit;
}

function finalizeDay(D) {
  D.total = D.input + D.output;
  D.hours.forEach((b) => {
    b.total = b.input + b.output;
  });
  for (const M of D.mins.values()) M.total = M.input + M.output;
  for (const Mo of D.models.values()) Mo.total = Mo.input + Mo.output;
  for (const R of D.runs.values()) R.total = R.input + R.output;
  for (const S of D.sessions.values()) S.total = S.input + S.output;
}

export class TokenBoardWorld {
  constructor({ cfg, timezone, dataDir, persist, log } = {}) {
    this.id = 'tokenboard';
    this.cfg = cfg || {};
    this.timeZone = timezone || 'Asia/Shanghai';
    this.dataDir = dataDir;
    this.persist = persist || (() => {});
    this.log = log || (() => {});
    this.host = null;
    this._alertTimer = null;
    this._autoTimer = null;
    this._cfgAt = 0;
    this._cfgLive = null;
    this._cache = { at: 0, mtime: 0, size: 0, offset: 0, data: null, err: '' };
  }

  async start(host) {
    this.host = host || null;
    if (this._alertTimer) clearInterval(this._alertTimer);
    this._alertTimer = setInterval(() => {
      try {
        this.checkAlert();
      } catch {
        /* 预警检查绝不打扰主循环 */
      }
    }, ALERT_CHECK_MS);

    // 开了「自动启动」就等应用起来 3 秒再拉起对照台服务，避免和启动抢资源
    if (this._autoTimer) clearTimeout(this._autoTimer);
    this._autoTimer = setTimeout(() => {
      this._autoTimer = null;
      void this.autoStartRelay();
    }, 3000);
    if (this._autoTimer.unref) this._autoTimer.unref();
  }

  async stop() {
    if (this._alertTimer) {
      clearInterval(this._alertTimer);
      this._alertTimer = null;
    }
    if (this._autoTimer) {
      clearTimeout(this._autoTimer);
      this._autoTimer = null;
    }
  }

  /** 配置里的「自动启动服务」开关（优先读磁盘实时配置）。 */
  relayAutoStart() {
    const live = this.usageCfg() || {};
    if (typeof live.relayAutoStart === 'boolean') return live.relayAutoStart;
    return !!(this.cfg && this.cfg.relayAutoStart);
  }

  async autoStartRelay() {
    if (!this.relayAutoStart()) return;
    try {
      const st = await this.relayStatus();
      if (st && st.ok) return;
      const r = await this.relayStart();
      const msg = r && r.ok ? (r.already ? '已经在线' : '已启动') : (r && (r.message || r.error)) || '启动失败';
      this.log('relay 自动启动：' + msg);
    } catch (e) {
      this.log('relay 自动启动出错：' + (e && e.message ? e.message : String(e)));
    }
  }

  /** World 接口必备：本 World 不往环境提示词里加段落，返回 null 即可。 */
  envPromptVars() {
    return null;
  }

  usageFile() {
    return (
      String(this.cfg.usageFile || '').trim() ||
      process.env.COOPANION_USAGE ||
      path.join(this.dataDir || process.cwd(), 'usage.jsonl')
    );
  }

  /* ------------ 读取与聚合（增量 tail：只解析新追加的行） ------------ */

  readData() {
    const file = this.usageFile();
    let st = null;
    try {
      st = fs.statSync(file);
    } catch {
      this._cache = { at: Date.now(), mtime: 0, size: 0, offset: 0, data: null, err: '读不到用量日志：' + file };
      return this._cache;
    }
    const c = this._cache;
    // 没变化（含 TTL 内短路）：直接用缓存
    if (c.data && c.size === st.size && c.mtime === st.mtimeMs) {
      c.at = Date.now();
      return c;
    }

    // 决定起点：文件追加 → 增量；变小或原地重写 → 全量重建
    let days, offset;
    if (c.data && st.size > c.size) {
      days = c.data;
      offset = c.offset || 0;
    } else {
      days = new Map();
      offset = 0;
    }

    /* 分块读（4MB/块）：不再一次性把整个文件读进 Buffer 再 split 成几十万个字符串，
       解析大日志时的瞬时内存从「文件的 2~3 倍」降到一块左右；多字节字符跨块交给 StringDecoder。 */
    let pos = offset;
    let carry = '';
    let failed = '';
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.allocUnsafe(READ_CHUNK);
      const dec = new StringDecoder('utf8');
      while (pos < st.size) {
        const want = Math.min(READ_CHUNK, st.size - pos);
        const n = fs.readSync(fd, buf, 0, want, pos);
        if (!n) break;
        pos += n;
        const text = carry + dec.write(buf.subarray(0, n));
        let start = 0;
        for (;;) {
          const nl = text.indexOf('\n', start);
          if (nl < 0) break;
          if (nl > start) {
            let r = null;
            try {
              r = JSON.parse(text.slice(start, nl));
            } catch {
              r = null;
            }
            if (r) mergeRecord(days, r);
          }
          start = nl + 1;
        }
        carry = text.slice(start);
        // 异常长的半行（坏文件）直接丢弃，别把整块内存吊着
        if (carry.length > 8 * 1024 * 1024) carry = '';
      }
    } catch (e) {
      failed = '读用量日志失败：' + (e && e.message ? e.message : String(e));
    } finally {
      if (fd != null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }

    if (failed) {
      // 解析到一半出错：丢掉半成品，下次全量重建，避免重复累加
      this._cache = { at: Date.now(), mtime: st.mtimeMs, size: st.size, offset: 0, data: null, err: failed, file };
      return this._cache;
    }

    for (const D of days.values()) finalizeDay(D);

    this._cache = {
      at: Date.now(),
      mtime: st.mtimeMs,
      size: st.size,
      offset: Math.max(offset, pos - Buffer.byteLength(carry, 'utf8')),
      data: days,
      err: '',
      file,
    };
    return this._cache;
  }

  /* ------------ 面板数据 ------------ */

  dayStats(D) {
    return { date: null, calls: D.calls, input: D.input, output: D.output, hit: D.hit, total: D.total };
  }

  summary(wantDate) {
    const cache = this.readData();
    if (!cache.data) return { ok: false, message: cache.err || '用量日志里还没有记录', file: this.usageFile() };
    const days = [...cache.data.keys()].sort().reverse();
    if (!days.length) return { ok: false, message: '用量日志里还没有记录', file: this.usageFile() };
    const date = days.includes(wantDate) ? wantDate : days[0];
    const D = cache.data.get(date);

    const n0 = new Date();
    const today = localDateStr(n0);
    const isToday = date === today;
    const nowHour = isToday ? n0.getHours() : 23;
    const nowMin = isToday ? n0.getMinutes() : 59;

    // 昨日（自然日）同期的柱子
    const pd = new Date(date + 'T00:00:00');
    pd.setDate(pd.getDate() - 1);
    const prevDate = localDateStr(pd);
    const P = cache.data.get(prevDate) || null;

    const models = [...D.models.entries()]
      .map(([model, b]) => ({ model, calls: b.calls, input: b.input, output: b.output, hit: b.hit, total: b.total }))
      .sort((a, b) => b.total - a.total);

    const daysStats = days.slice(0, 14).map((d) => {
      const s = this.dayStats(cache.data.get(d));
      s.date = d;
      return s;
    });

    return {
      ok: true,
      source: path.basename(this.usageFile()),
      file: this.usageFile(),
      date,
      today,
      isToday,
      nowHour,
      nowMin,
      days,
      daysStats,
      hours: D.hours.map((b, h) => ({ h, calls: b.calls, input: b.input, output: b.output, hit: b.hit, total: b.total })),
      totals: { calls: D.calls, input: D.input, output: D.output, hit: D.hit, total: D.total },
      prevDate,
      hasPrev: !!P,
      prev: P ? P.hours.map((b, h) => ({ h, calls: b.calls, input: b.input, output: b.output, hit: b.hit, total: b.total })) : null,
      prevTotals: P ? { calls: P.calls, total: P.total } : null,
      models,
      alertLimit: this.alertLimit(),
    };
  }

  minutes(wantDate, wantHour) {
    const cache = this.readData();
    if (!cache.data) return { ok: false, message: cache.err || '用量日志里还没有记录', file: this.usageFile() };
    const days = [...cache.data.keys()].sort().reverse();
    if (!days.length) return { ok: false, message: '用量日志里还没有记录', file: this.usageFile() };
    const date = days.includes(wantDate) ? wantDate : days[0];
    const D = cache.data.get(date);
    const hour = Number.isFinite(wantHour) && wantHour >= 0 && wantHour < 24 ? Math.trunc(wantHour) : new Date().getHours();
    const n0 = new Date();
    const today = localDateStr(n0);
    const isToday = date === today;

    const H = D.hours[hour];
    const mins = Array.from({ length: 60 }, (_, m) => {
      const b = D.mins.get(hour * 60 + m);
      return { m, calls: b ? b.calls : 0, input: b ? b.input : 0, output: b ? b.output : 0, hit: b ? b.hit : 0, total: b ? b.total : 0 };
    });
    const active = mins.filter((b) => b.calls > 0).length;
    let peak = { m: -1, total: 0 };
    for (const b of mins) if (b.total > peak.total) peak = { m: b.m, total: b.total };

    const pd = new Date(date + 'T00:00:00');
    pd.setDate(pd.getDate() - 1);
    const prevDate = localDateStr(pd);
    const P = cache.data.get(prevDate) || null;
    const prev = Array.from({ length: 60 }, (_, m) => {
      const b = P && P.mins.get(hour * 60 + m);
      return { m, total: b ? b.total : 0 };
    });

    return {
      ok: true,
      date,
      hour,
      isToday,
      nowMin: isToday ? n0.getMinutes() : 59,
      mins,
      hourTotals: { calls: H.calls, input: H.input, output: H.output, hit: H.hit, total: H.total },
      active,
      peak,
      prevDate,
      prevTotal: P ? P.hours[hour].total : 0,
    };
  }

  /** 某一天的轮次（run）与会话 Top 榜。run = 一次连续的主循环交互。 */
  tops(wantDate) {
    const cache = this.readData();
    if (!cache.data) return { ok: false, message: cache.err || '用量日志里还没有记录' };
    const days = [...cache.data.keys()].sort().reverse();
    if (!days.length) return { ok: false, message: '用量日志里还没有记录' };
    const date = days.includes(wantDate) ? wantDate : days[0];
    const D = cache.data.get(date);

    // 插件 / 会话 Token 榜：sessionId 是宿主唯一的调用来源归因
    // main = 桌宠主对话；worlds.<id> = 对应 World 插件自己的模型调用
    const sessions = [...D.sessions.values()]
      .map((S) => ({
        session: S.session,
        label: S.label || '',
        calls: S.calls,
        input: S.input,
        output: S.output,
        hit: S.hit,
        total: S.total,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 14);

    return {
      ok: true,
      date,
      note: 'main = 主对话；worlds.<id> = 插件自己的模型调用。',
      sessions,
    };
  }

  /** 日期范围汇总（含范围内模型分布），给周/月/全部视图用。 */
  range(from, to) {
    const cache = this.readData();
    if (!cache.data) return { ok: false, message: cache.err || '用量日志里还没有记录' };
    const F = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? String(from) : null;
    const T = /^\d{4}-\d{2}-\d{2}$/.test(String(to || '')) ? String(to) : null;
    const days = [...cache.data.keys()]
      .filter((d) => (!F || d >= F) && (!T || d <= T))
      .sort();
    const totals = { calls: 0, input: 0, output: 0, hit: 0, total: 0 };
    const models = new Map();
    const list = days.map((d) => {
      const D = cache.data.get(d);
      totals.calls += D.calls;
      totals.input += D.input;
      totals.output += D.output;
      totals.hit += D.hit;
      totals.total += D.total;
      for (const [m, b] of D.models) {
        let Mb = models.get(m);
        if (!Mb) {
          Mb = { calls: 0, input: 0, output: 0, hit: 0, total: 0 };
          models.set(m, Mb);
        }
        Mb.calls += b.calls;
        Mb.input += b.input;
        Mb.output += b.output;
        Mb.hit += b.hit;
        Mb.total += b.total;
      }
      return { date: d, calls: D.calls, input: D.input, output: D.output, hit: D.hit, total: D.total };
    });
    const modelList = [...models.entries()]
      .map(([model, b]) => ({ model, ...b }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 14);
    return { ok: true, from: F, to: T, days: list, totals, models: modelList };
  }

  /* ------------ 用量预警 ------------ */

  /** 设置热读：磁盘 config.json 的 worlds.tokenboard 优先（2 秒缓存），退回启动 cfg。 */
  usageCfg() {
    const now = Date.now();
    if (this._cfgAt && now - this._cfgAt < 2000) return this._cfgLive || {};
    this._cfgAt = now;
    this._cfgLive = null;
    try {
      const file = path.join(this.dataDir || '.', '..', 'config.json');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const w = parsed && parsed.worlds && parsed.worlds.tokenboard;
      if (w && typeof w === 'object') this._cfgLive = w;
    } catch {
      // 读不到就退回内存里的 cfg
    }
    return this._cfgLive || {};
  }

  alertLimit() {
    const live = Number(this.usageCfg().dailyAlertTokens);
    if (Number.isFinite(live) && live >= 0) return live;
    const base = Number(this.cfg && this.cfg.dailyAlertTokens);
    return Number.isFinite(base) && base >= 0 ? base : 0;
  }

  stateFile() {
    return path.join(this.dataDir || '.', 'tokenboard-state.json');
  }

  loadAlertState() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile(), 'utf8')) || {};
    } catch {
      return {};
    }
  }

  saveAlertState(s) {
    try {
      fs.writeFileSync(this.stateFile(), JSON.stringify(s, null, 2) + '\n');
    } catch {
      /* 状态写不进去最多多提醒一次 */
    }
  }

  checkAlert() {
    const limit = this.alertLimit();
    if (!(limit > 0) || !this.host) return;
    const cache = this.readData();
    if (!cache.data) return;
    const today = localDateStr(new Date());
    const D = cache.data.get(today);
    if (!D || D.total < limit) return;
    const st = this.loadAlertState();
    if (st.alertDate === today && st.alerted) return;
    this.saveAlertState({ alertDate: today, alerted: true, totalAtAlert: D.total, limit });
    const text =
      '⚡ Token 用量提醒：今天已用 ' + fmtCn(D.total) + ' tokens（' + fmtInt(D.calls) + ' 次调用），超过了你设的 ' + fmtCn(limit) + ' 阈值。';
    try {
      void this.host.pushEvent(
        {
          type: 'tokenboard.alert',
          source: this.id,
          ts: localIso(new Date()),
          text,
          senderKey: 'tokenboard:alert',
          origin: 'internal',
          meta: { date: today, total: D.total, limit },
        },
        { trigger: 'debounce' }
      );
    } catch {
      /* 推送失败不打扰 */
    }
  }

  /* ------------ 给智能体的工具 ------------ */

  toolUsage(args = {}) {
    const cache = this.readData();
    if (!cache.data) return { ok: false, error: cache.err || '用量日志里还没有记录' };
    const days = [...cache.data.keys()].sort().reverse();
    const date = days.includes(String(args.date || '')) ? String(args.date) : days[0];
    const D = cache.data.get(date);
    const peak = D.hours.reduce((a, b, h) => (b.total > a.total ? { h, total: b.total } : a), { h: 0, total: 0 });
    const models = [...D.models.entries()].map(([model, b]) => ({ model, total: b.total, calls: b.calls })).sort((a, b) => b.total - a.total).slice(0, 5);
    const topRun = [...D.runs.values()].sort((a, b) => b.total - a.total)[0] || null;
    const last7 = days.slice(0, 7).map((d) => {
      const s = cache.data.get(d);
      return { date: d, calls: s.calls, total: s.total };
    });
    return {
      ok: true,
      note: '总量=输入+输出，单位 token；数据来自本机用量日志。',
      date,
      day: { calls: D.calls, total: D.total, input: D.input, output: D.output, cacheHit: D.hit },
      peakHour: peak.total > 0 ? { hour: peak.h, total: peak.total } : null,
      topModels: models,
      busiestRun: topRun ? { run: topRun.run, startedAt: topRun.first, calls: topRun.calls, total: topRun.total } : null,
      last7,
      alertLimit: this.alertLimit(),
    };
  }

  toolSetAlert(args = {}) {
    const n = Math.floor(Number(args && args.dailyTokens));
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'dailyTokens 要是非负整数（token 数），0 表示关闭提醒。' };
    try {
      this.persist({ dailyAlertTokens: n });
    } catch (e) {
      return { ok: false, error: '保存设置失败：' + (e && e.message ? e.message : e) };
    }
    this._cfgAt = 0; // 失效热读缓存，立刻生效
    const cur = this.alertLimit();
    return {
      ok: true,
      dailyAlertTokens: cur,
      note:
        cur > 0
          ? '已设置：每天总用量（输入+输出）超过 ' + fmtCn(cur) + ' 就提醒一次，每天最多提醒一次；跟我说「关闭用量提醒」可撤销。'
          : '已关闭每天用量提醒。',
    };
  }

  tools() {
    return [
      {
        ...TOOL_DECL,
        handler: async (args) => {
          try {
            return JSON.stringify(this.toolUsage(args ?? {}));
          } catch (e) {
            return JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) });
          }
        },
      },
      {
        ...ALERT_DECL,
        handler: async (args) => {
          try {
            return JSON.stringify(this.toolSetAlert(args ?? {}));
          } catch (e) {
            return JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) });
          }
        },
      },
    ];
  }

  /* ------------ 挂到控制台的 webui 描述 ------------ */

  webUi() {
    const s = this.summary();
    const ok = !!s.ok;
    const todayTotal = ok && s.isToday ? s.totals.total : 0;
    return {
      label: 'Token 账房',
      lamps: [
        { label: '用量日志', state: ok ? 'online' : 'offline', hint: ok ? s.source + ' · ' + s.days.length + ' 天记录' : s.message || '没读到' },
      ],
      badges: [{ label: '今日', value: ok && s.isToday ? todayTotal : '—', tone: ok && todayTotal > 0 ? 'on' : 'off' }],
      panels: [
        {
          id: 'board',
          title: 'Token 用量',
          description:
            '整个 Coopanion 的 token 消耗：每小时曲线（叠昨日同期）、单小时分钟下钻、周/月/全部历史汇总、模型分布；当日超过阈值桌宠会主动提醒（说「token 超过 X 提醒我」可设置）。数据来自本机 usage.jsonl。',
          getMethods: ['summary', 'minutes', 'range'],
        },
        {
          id: 'speed',
          title: '测速对照',
          description:
            '同一 prompt、同一参数，把每个中转站的延迟和价格放到一起比；按品牌各自对照官方价，给「推荐用哪个」。可现场测速、增删改目标。数据来自本机中转站对照台服务（127.0.0.1:8770）。',
          getMethods: ['relayGet', 'relayPost', 'relayStatus', 'relayStart'],
        },
        {
          id: 'bill',
          title: '账单核对',
          description:
            '把中转站后台账单和实际测速对上：单价对不对、缓存有没有真省钱、有没有偷偷换模型、账单自己能不能对上。支持直连同步、粘贴导入、手填汇总；手填时可按「直充 / 套餐」两种计价方式折算人民币，并自动比哪个更划算。',
          getMethods: ['relayGet', 'relayPost', 'relayStatus', 'relayStart', 'getCfg', 'saveCfg'],
        },
        {
          id: 'config',
          title: '配置',
          description:
            '对照台服务的启动方式（自动 / 手动）、启停与状态、服务地址与 Python 路径、每日用量提醒阈值。选「自动启动」会在 Coopanion 起来后自动拉起服务。',
          getMethods: ['relayStatus', 'relayStart', 'relayStop', 'getCfg', 'saveCfg'],
        },
      ],
      config: [],
      invoke: (panel, method, args) => this.invoke(panel, method, args),
    };
  }

  async invoke(panel, method, args = []) {
    if (method === 'summary') return this.summary(args[0] == null ? undefined : String(args[0]));
    if (method === 'minutes') return this.minutes(args[0] == null ? undefined : String(args[0]), Number(args[1]));
    if (method === 'tops') return this.tops(args[0] == null ? undefined : String(args[0]));
    if (method === 'range') return this.range(args[0] == null ? undefined : String(args[0]), args[1] == null ? undefined : String(args[1]));
    if (method === 'relayStatus') return this.relayStatus();
    if (method === 'relayGet') return this.relayGet(args[0] == null ? '/' : String(args[0]));
    if (method === 'relayPost') return this.relayPost(args[0] == null ? '/' : String(args[0]), args[1]);
    if (method === 'getCfg') return this.getCfg();
    if (method === 'saveCfg') return this.saveCfg(args[0]);
    if (method === 'relayApi')
      return this.relayApi(
        args[0] == null ? '' : String(args[0]),
        args[1] == null ? 'GET' : String(args[1]),
        args[2] == null ? null : String(args[2]),
        args[3] && typeof args[3] === 'object' ? args[3] : null
      );
    if (method === 'relayStart') return this.relayStart(args[0] == null ? undefined : String(args[0]));
    if (method === 'relayStop') return this.relayStop();
    return { ok: false, error: '未知方法：' + String(method) };
  }

  /* ------------ 面板直连对照台服务（不经浏览器，绕开跨源限制） ------------ */

  /** 把 relayApi 的原始响应整理成 {ok, data} / {ok:false, error}。 */
  unwrapRelay(r) {
    if (!r) return { ok: false, error: '没有响应' };
    if (r.error) return { ok: false, error: String(r.error) };
    const status = Number(r.status) || 500;
    let data = null;
    try {
      data = JSON.parse(r.body == null ? 'null' : String(r.body));
    } catch {
      data = r.body;
    }
    if (status >= 200 && status < 300) return { ok: true, data };
    let msg = '';
    if (data && typeof data === 'object' && data.error) msg = String(data.error);
    else if (typeof data === 'string' && data.trim()) msg = data.trim().slice(0, 300);
    return { ok: false, error: msg || 'HTTP ' + status, status };
  }

  async relayGet(pathname) {
    return this.unwrapRelay(await this.relayApi(pathname, 'GET', null, null));
  }

  async relayPost(pathname, body) {
    return this.unwrapRelay(
      await this.relayApi(pathname, 'POST', JSON.stringify(body || {}), { 'content-type': 'application/json' })
    );
  }

  /** 配置页读当前值（读的是 config.json 里的实时值，不是启动时的快照）。 */
  getCfg() {
    const live = this.usageCfg() || {};
    return {
      ok: true,
      cfg: {
        dailyAlertTokens: Number(live.dailyAlertTokens ?? this.cfg.dailyAlertTokens ?? 0) || 0,
        relayUrl: String(live.relayUrl || this.cfg.relayUrl || DEFAULT_RELAY_URL),
        relayPython: String(live.relayPython || this.cfg.relayPython || ''),
        relayStartScript: String(live.relayStartScript || this.cfg.relayStartScript || DEFAULT_RELAY_SCRIPT),
        relayAutoStart: typeof live.relayAutoStart === 'boolean' ? live.relayAutoStart : !!(this.cfg && this.cfg.relayAutoStart),
        billing: cleanBilling(live.billing || this.cfg.billing || {}),
      },
    };
  }

  /** 配置页保存（写回 config.json 的 worlds.tokenboard 段）。 */
  saveCfg(patch) {
    if (!patch || typeof patch !== 'object') return { ok: false, error: '没有要保存的项' };
    const out = {};
    if (Object.prototype.hasOwnProperty.call(patch, 'dailyAlertTokens')) {
      out.dailyAlertTokens = Math.max(0, Math.floor(Number(patch.dailyAlertTokens) || 0));
    }
    for (const key of ['relayUrl', 'relayPython', 'relayStartScript']) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        out[key] = String(patch[key] == null ? '' : patch[key]).trim();
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'relayAutoStart')) {
      out.relayAutoStart = !!patch.relayAutoStart;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'billing')) {
      out.billing = cleanBilling(patch.billing);
    }
    if (!Object.keys(out).length) return { ok: false, error: '没有要保存的项' };
    if (out.relayUrl) {
      try {
        const u = new URL(out.relayUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http/https');
        out.relayUrl = u.href;
      } catch {
        return { ok: false, error: '对照台地址不是合法的 http/https 地址' };
      }
    }
    if (out.billing) {
      // persist 是深合并，内存里也按站合并，避免把别的站的计价设置冲掉
      out.billing = Object.assign({}, this.cfg && this.cfg.billing, out.billing);
    }
    this.cfg = Object.assign({}, this.cfg, out);
    this._cfgAt = 0;
    this._cfgLive = null;
    try {
      this.persist(out);
    } catch (e) {
      return { ok: false, error: '写入配置失败：' + String((e && e.message) || e) };
    }
    return { ok: true, cfg: this.getCfg().cfg };
  }

  /* ------------ 中转站对照台（RelayHub） ------------ */

  relayConfig() {
    const live = this.usageCfg();
    const pick = (key, dflt) => {
      const v = live && live[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
      const mem = this.cfg && this.cfg[key];
      if (typeof mem === 'string' && mem.trim()) return mem.trim();
      return dflt;
    };
    return {
      url: pick('relayUrl', DEFAULT_RELAY_URL),
      script: pick('relayStartScript', DEFAULT_RELAY_SCRIPT),
      python: pick('relayPython', ''),
    };
  }

  relayPaths() {
    const cfg = this.relayConfig();
    const root = path.dirname(cfg.script);
    let port = 8770;
    try {
      port = Number(new URL(cfg.url).port) || 8770;
    } catch {
      port = 8770;
    }
    return {
      url: cfg.url,
      script: cfg.script,
      root,
      server: path.join(root, 'relayhub', 'server.py'),
      pyDir: path.join(root, 'relayhub'),
      port,
      log: path.join(root, 'relayhub', 'relay-service.log'),
      python: cfg.python,
    };
  }

  // 找一个可用的 Python：优先 pythonw.exe（无控制台窗口）
  findPython() {
    const cfg = this.relayConfig();
    const cands = [];
    if (cfg.python) cands.push(cfg.python);
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const vers = path.join(home, '.workbuddy', 'binaries', 'python', 'versions');
    try {
      const dirs = fs
        .readdirSync(vers, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .filter((n) => n !== 'current')
        .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
      for (const d of dirs) cands.push(path.join(vers, d, 'pythonw.exe'), path.join(vers, d, 'python.exe'));
      cands.push(path.join(vers, 'current', 'pythonw.exe'), path.join(vers, 'current', 'python.exe'));
    } catch {
      /* 没有这个目录就继续找 PATH */
    }
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (!dir || /windowsapps/i.test(dir)) continue;
      cands.push(path.join(dir, 'pythonw.exe'), path.join(dir, 'python.exe'));
    }
    for (const c of cands) {
      try {
        if (c && fs.existsSync(c)) return c;
      } catch {
        /* 忽略权限问题 */
      }
    }
    return '';
  }

  relayLogTail(logPath, maxLines = 6) {
    try {
      const st = fs.statSync(logPath);
      const size = Math.min(st.size, 4096);
      if (size <= 0) return '';
      const buf = Buffer.alloc(size);
      const fd = fs.openSync(logPath, 'r');
      try {
        fs.readSync(fd, buf, 0, size, Math.max(0, st.size - size));
      } finally {
        fs.closeSync(fd);
      }
      const lines = buf
        .toString('utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-maxLines);
      return lines.length ? ' 最近日志：\n' + lines.join('\n') : '';
    } catch {
      return '';
    }
  }

  // 面板直连用：替面板发 HTTP 请求（相对地址按对照台地址补全；http/https 均可）
  relayApi(rawUrl, method, body, headers) {
    const p = this.relayPaths();
    let target;
    try {
      target = new URL(String(rawUrl || '/'), String(p.url || DEFAULT_RELAY_URL));
    } catch {
      return Promise.resolve({ error: '接口地址无效：' + String(rawUrl) });
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return Promise.resolve({ error: '只支持 http/https：' + target.protocol });
    }
    const m = String(method || 'GET').toUpperCase();
    const h = { 'accept-encoding': 'identity' };
    if (headers && typeof headers === 'object') {
      for (const key of Object.keys(headers)) {
        const lk = String(key).toLowerCase();
        const v = headers[key];
        if (typeof v !== 'string') continue;
        if (lk === 'content-type' || lk === 'accept' || lk === 'authorization' || lk.startsWith('x-')) h[lk] = v;
      }
    }
    // 请求体必须在建连接前定下来：对照台是 Python BaseHTTPRequestHandler，
    // 只认 Content-Length，chunked 会被当成空 body（POST 会静默失效）。
    const payload = body != null && m !== 'GET' && m !== 'HEAD' ? Buffer.from(String(body), 'utf8') : null;
    if (payload) h['content-length'] = String(payload.length);
    const isHttps = target.protocol === 'https:';
    const mod = isHttps ? https : http;
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      let req;
      try {
        req = mod.request(
          {
            hostname: target.hostname,
            port: target.port || (isHttps ? 443 : 80),
            path: target.pathname + target.search,
            method: m,
            headers: h,
            timeout: 120000,
          },
          (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (c) => {
              size += c.length;
              if (size <= 16 * 1024 * 1024) chunks.push(c);
            });
            res.on('end', () => {
              done({
                status: res.statusCode || 200,
                body: Buffer.concat(chunks).toString('utf8'),
                headers: { 'content-type': String(res.headers['content-type'] || 'application/json; charset=utf-8') },
              });
            });
            res.on('error', (e) => done({ error: '读响应失败：' + (e && e.message ? e.message : String(e)) }));
          }
        );
      } catch (e) {
        done({ error: '请求失败：' + (e && e.message ? e.message : String(e)) });
        return;
      }
      req.on('timeout', () => {
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        done({ error: '请求超时（120s）：' + target.href });
      });
      req.on('error', (e) => done({ error: '连不上 ' + target.host + '：' + (e && e.message ? e.message : String(e)) }));
      if (payload) {
        try {
          req.write(payload);
        } catch {
          /* ignore */
        }
      }
      req.end();
    });
  }

  probeRelay(url, timeoutMs = 1200) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        resolve(ok);
      };
      try {
        const u = new URL(url);
        const req = http.get(
          { hostname: u.hostname, port: u.port || 80, path: u.pathname || '/', timeout: timeoutMs },
          (res) => {
            res.resume();
            finish(res.statusCode >= 200 && res.statusCode < 500);
          }
        );
        req.on('timeout', () => {
          req.destroy();
          finish(false);
        });
        req.on('error', () => finish(false));
      } catch {
        finish(false);
      }
    });
  }

  async relayStatus() {
    const p = this.relayPaths();
    const ok = await this.probeRelay(p.url);
    const python = this.findPython();
    return {
      ok,
      url: p.url,
      script: p.script,
      server: p.server,
      hasServer: fs.existsSync(p.server),
      python,
      log: p.log,
      canStart: fs.existsSync(p.server) || fs.existsSync(p.script),
      message: ok ? '' : '中转站对照台服务没有运行',
    };
  }

  // 结束占用该端口的旧服务（重启服务时用）
  async relayStop() {
    const p = this.relayPaths();
    const { execFile } = await import('node:child_process');
    const run = (file, args) =>
      new Promise((resolve) => {
        try {
          execFile(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
        } catch {
          resolve('');
        }
      });
    const text = await run('netstat.exe', ['-ano']);
    const pids = new Set();
    const re = new RegExp('[:.]' + p.port + '\\s');
    for (const line of text.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line) || !re.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid);
    }
    for (const pid of pids) await run('taskkill.exe', ['/PID', pid, '/F']);
    if (pids.size) await new Promise((r) => setTimeout(r, 700));
    return { ok: true, killed: [...pids] };
  }

  // 启动服务：直接拉起 pythonw（无控制台窗口），日志写进 relayhub/relay-service.log
  async relayStart(mode) {
    const p = this.relayPaths();
    if (mode === 'restart') await this.relayStop();
    if (await this.probeRelay(p.url)) return { ok: true, url: p.url, already: true };

    let spawnError = '';
    if (fs.existsSync(p.server)) {
      const py = this.findPython();
      if (!py) {
        return { ok: false, message: '没有找到 Python 运行环境。请装一个 Python 3，或在插件配置页填写 python.exe 的路径。' };
      }
      let fd = null;
      try {
        fs.mkdirSync(path.dirname(p.log), { recursive: true });
        fd = fs.openSync(p.log, 'a');
        fs.writeSync(fd, `\n[${new Date().toISOString()}] 启动：${py} server.py ${p.port}\n`);
      } catch {
        fd = null;
      }
      try {
        const { spawn } = await import('node:child_process');
        const child = spawn(py, [p.server, String(p.port)], {
          cwd: p.pyDir,
          detached: true,
          windowsHide: true,
          stdio: ['ignore', fd == null ? 'ignore' : fd, fd == null ? 'ignore' : fd],
        });
        child.on('error', (e) => {
          spawnError = e && e.message ? e.message : String(e);
        });
        child.on('exit', (code) => {
          if (fd != null) {
            try {
              fs.writeSync(fd, `[${new Date().toISOString()}] 进程退出 code=${code}\n`);
            } catch {
              /* ignore */
            }
          }
        });
        child.unref();
      } catch (e) {
        spawnError = e && e.message ? e.message : String(e);
      }
      if (fd != null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    } else if (fs.existsSync(p.script)) {
      // 兜底：老式 .bat，同样不弹窗口（注意不能加 detached，否则 cmd 会卡住）
      try {
        const { spawn } = await import('node:child_process');
        const child = spawn('cmd.exe', ['/c', `"${p.script}"`], {
          cwd: p.root,
          windowsHide: true,
          stdio: 'ignore',
          windowsVerbatimArguments: true,
        });
        child.unref();
      } catch (e) {
        spawnError = e && e.message ? e.message : String(e);
      }
    } else {
      return { ok: false, message: '找不到 RelayHub 服务文件：' + p.server + '（可在插件配置页改启动脚本路径）' };
    }

    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await this.probeRelay(p.url)) return { ok: true, url: p.url, python: this.findPython() };
    }
    return {
      ok: false,
      starting: true,
      message: (spawnError ? '启动失败：' + spawnError + '。' : '服务 12 秒内还没起来。') + this.relayLogTail(p.log),
    };
  }
}

const TOKENBOARD = {
  id: 'tokenboard',
  label: 'Token 账房',
  defaults: () => ({
    dailyAlertTokens: 0,
    relayUrl: DEFAULT_RELAY_URL,
    relayStartScript: DEFAULT_RELAY_SCRIPT,
    relayPython: '',
    relayAutoStart: false,
    billing: {},
  }),
  create: (ctx) =>
    new TokenBoardWorld({
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      dataDir: ctx.dataDir,
      persist: (patch) => ctx.persist(patch),
      log: ctx.log,
    }),
  describe: {
    tools: [TOOL_DECL, ALERT_DECL],
    events: [
      {
        type: 'tokenboard.alert',
        description: {
          zh: '当日 token 总用量（输入+输出）超过主人设置的阈值时，每天提醒一次。',
          en: 'Fires once per day when daily token usage exceeds the owner-set threshold.',
        },
        trigger: 'debounce',
      },
    ],
  },
};

function fmtInt(n) {
  return (Number(n) || 0).toLocaleString('en-US');
}

export default TOKENBOARD;
