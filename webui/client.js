/**
 * Token 用量看板 · webui 面板
 * 复刻 APIGOTO 账号管理面板的「每小时 token 曲线」页：
 * 五张汇总卡 + 每小时柱状图（昨日同期虚线 / 已发生时段均值线 / 当前小时蓝框 / 未发生小时灰底）
 * + 点柱子下钻这一小时每分钟 + 逐日历史表 + 模型分布表。
 * 数据全部来自 Coopanion 本机用量日志（usage.jsonl），由后端 world.js 聚合，不花 token。
 */

const METRICS = {
  total: { key: 'total', name: '总量', hint: '输入 + 输出' },
  input: { key: 'input', name: '输入', hint: '' },
  output: { key: 'output', name: '输出', hint: '' },
  hit: { key: 'hit', name: '缓存命中', hint: '输入中命中前缀缓存的部分' },
};

const SVGNS = 'http://www.w3.org/2000/svg';

function pad2(v) {
  return String(v).padStart(2, '0');
}

function fmtDate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/* ---------------- 小工具 ---------------- */

function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (cls) node.className = cls;
  return node;
}

function sv(tag, attrs) {
  const node = document.createElementNS(SVGNS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
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

function fmtInt(n) {
  return (Number(n) || 0).toLocaleString('en-US');
}

function fmtPct(v, digits = 1) {
  return (v * 100).toFixed(digits) + '%';
}

function niceMax(v) {
  if (!(v > 0)) return 100;
  const target = v * 1.06;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (m * pow >= target) return m * pow;
  }
  return 10 * pow;
}

function metricName(key) {
  return (METRICS[key] || METRICS.total).name;
}

/* ---------------- 图表渲染 ---------------- */

/**
 * 画一个柱状/折线图。
 * items: [{label, value, calls, input, output, hit, future?, current?}]
 * prev:  [{value}] 或 null（虚线对比线）
 * opts:  {mean, meanLabel, nowText, onPick(i), yMaxHint}
 */
function renderChart(items, prev, opts = {}) {
  const W = 760;
  const H = 300;
  const L = 52;
  const R = 14;
  const T = 26;
  const B = 26;
  const plotW = W - L - R;
  const plotH = H - T - B;
  const n = items.length;
  const slotW = plotW / n;

  const vals = items.map((it) => it.value || 0);
  let maxV = Math.max(...vals, 1);
  if (prev) maxV = Math.max(maxV, ...prev.map((p) => p.value || 0));
  const yMax = niceMax(maxV);
  const y = (v) => T + plotH - (v / yMax) * plotH;
  const cx = (i) => L + slotW * (i + 0.5);

  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'tb-svg' });

  // 未来时段灰底
  items.forEach((it, i) => {
    if (it.future) svg.append(sv('rect', { x: L + slotW * i, y: T - 8, width: slotW, height: plotH + 8, fill: '#ededf2' }));
  });

  // 网格 + 轴标签
  for (let g = 0; g <= 4; g++) {
    const gv = (yMax / 4) * g;
    const gy = y(gv);
    svg.append(sv('line', { x1: L, y1: gy, x2: W - R, y2: gy, stroke: '#e7e9f0', 'stroke-width': 1 }));
    if (g > 0) {
      const t = sv('text', { x: L - 7, y: gy + 3.5, 'text-anchor': 'end', class: 'tb-axis' });
      t.textContent = fmtCn(gv);
      svg.append(t);
    }
  }

  const bw = Math.max(3, Math.min(slotW * 0.6, 30));

  // 昨日同期虚线
  if (prev && prev.length === n) {
    const pts = prev.map((p, i) => cx(i) + ',' + y(p.value || 0)).join(' ');
    svg.append(sv('polyline', { points: pts, fill: 'none', stroke: '#a6acba', 'stroke-width': 1.3, 'stroke-dasharray': '4 3' }));
  }

  const isLine = opts.mode === 'line';
  if (!isLine) {
    items.forEach((it, i) => {
      const v = it.value || 0;
      if (v <= 0) return;
      const bh = Math.max(2, T + plotH - y(v));
      svg.append(
        sv('rect', {
          x: cx(i) - bw / 2,
          y: T + plotH - bh,
          width: bw,
          height: bh,
          rx: Math.min(3, bw / 3),
          fill: i === opts.picked ? '#1e5fd0' : it.current ? '#9ec7ff' : '#3e8eff',
        })
      );
    });
  } else {
    const pts = vals.map((v, i) => cx(i) + ',' + y(v)).join(' ');
    svg.append(sv('polyline', { points: pts, fill: 'none', stroke: '#3e8eff', 'stroke-width': 1.8 }));
    items.forEach((it, i) => {
      if ((it.value || 0) > 0) svg.append(sv('circle', { cx: cx(i), cy: y(it.value), r: 2.4, fill: '#3e8eff' }));
    });
  }

  // 均值线（已发生时段均值）
  if (opts.mean > 0) {
    const my = y(Math.min(opts.mean, yMax));
    svg.append(sv('line', { x1: L, y1: my, x2: W - R, y2: my, stroke: '#f5a623', 'stroke-width': 1.2, 'stroke-dasharray': '5 3' }));
    const t = sv('text', { x: W - R, y: my - 5, 'text-anchor': 'end', class: 'tb-mean' });
    t.textContent = opts.meanLabel || '平均 ' + fmtCn(opts.mean);
    svg.append(t);
  }

  // 峰值标注
  if (!isLine && n > 1) {
    let peakI = -1;
    let peakV = 0;
    items.forEach((it, i) => {
      if ((it.value || 0) > peakV && !it.future) {
        peakV = it.value;
        peakI = i;
      }
    });
    if (peakI >= 0 && peakV > 0) {
      const t = sv('text', { x: cx(peakI), y: y(peakV) - 6, 'text-anchor': 'middle', class: 'tb-peak' });
      t.textContent = fmtCn(peakV);
      svg.append(t);
    }
  }

  // 当前小时：蓝框 + “现在”
  items.forEach((it, i) => {
    if (!it.current) return;
    svg.append(
      sv('rect', {
        x: L + slotW * i + 1.5,
        y: T - 6,
        width: slotW - 3,
        height: plotH + 10,
        rx: 6,
        fill: 'none',
        stroke: '#4a9eff',
        'stroke-width': 1.4,
        'stroke-dasharray': '5 4',
      })
    );
    if (opts.nowText) {
      const t = sv('text', { x: Math.min(cx(i), W - R - 40), y: T - 10, 'text-anchor': 'middle', class: 'tb-now' });
      t.textContent = opts.nowText;
      svg.append(t);
    }
  });

  // X 轴刻度
  const step = n === 24 ? 2 : n === 60 ? 10 : 1;
  items.forEach((it, i) => {
    if (i % step !== 0) return;
    const t = sv('text', { x: cx(i), y: H - 8, 'text-anchor': 'middle', class: 'tb-axis' });
    t.textContent = it.shortLabel != null ? it.shortLabel : it.label;
    svg.append(t);
  });

  // 命中区（悬停 + 点击；未来时段不可点，进行中的小时可以点）
  items.forEach((it, i) => {
    const pickable = !!opts.onPick && !it.future;
    const hit = sv('rect', {
      x: L + slotW * i,
      y: T - 8,
      width: slotW,
      height: plotH + 8,
      fill: 'transparent',
      style: 'cursor:' + (pickable ? 'pointer' : 'default'),
    });
    hit.addEventListener('mousemove', (ev) => showTip(ev, it, opts, i, items));
    hit.addEventListener('mouseleave', hideTip);
    if (pickable) {
      hit.addEventListener('click', () => opts.onPick(i));
    }
    svg.append(hit);
  });

  return svg;
}

/* ---------------- tooltip（挂在 body 下的全局唯一一个） ---------------- */

let tipEl = null;

function ensureTip() {
  if (!tipEl || !tipEl.isConnected) {
    tipEl = el('div', undefined, 'tb-tip');
    tipEl.style.display = 'none';
    document.body.append(tipEl);
  }
  return tipEl;
}

function hideTip() {
  if (tipEl) tipEl.style.display = 'none';
}

function deltaHtml(d) {
  if (d == null || isNaN(d)) return '<b class="tt-v">—</b>';
  if (d === 0) return '<b class="tt-v">0</b>';
  const cls = d > 0 ? 'up' : 'down';
  const sign = d > 0 ? '+' : '-';
  return '<b class="tt-v ' + cls + '">' + sign + fmtCn(Math.abs(d)) + '</b>';
}

function pctDeltaHtml(cur, prev) {
  if (!(prev > 0)) return '';
  const p = (cur - prev) / prev;
  if (Math.abs(p) < 0.005) return ' · <b class="tt-v">±0%</b>';
  const cls = p > 0 ? 'up' : 'down';
  const sign = p > 0 ? '+' : '-';
  return ' · <b class="tt-v ' + cls + '">' + sign + Math.abs(p * 100).toFixed(0) + '%</b>';
}

function showTip(ev, it, opts, i, items) {
  const tip = ensureTip();
  const t = (opts && opts.tip) || {};
  const row = (label, valueHtml) => '<div class="tt-row"><span>' + label + '</span>' + valueHtml + '</div>';
  const sep = '<div class="tt-sep"></div>';

  // 标题：小时版 "12:00–12:59"，分钟版 "15:19"
  const base = String(it.label || '');
  const title = t.kind === 'minute' ? base : base.slice(0, 3) + '00–' + base.slice(0, 3) + '59';

  const rows = [];
  rows.push('<div class="tt-title">' + title + '</div>');
  rows.push(row('总量', '<b class="tt-v">' + fmtInt(it.total || 0) + '</b>'));
  rows.push(row('输入 / 输出', '<b class="tt-v">' + fmtCn(it.input || 0) + ' / ' + fmtCn(it.output || 0) + '</b>'));
  rows.push(row('缓存命中', '<b class="tt-v">' + fmtCn(it.hit || 0) + '</b>'));
  rows.push(sep);
  rows.push(row('调用次数', '<b class="tt-v">' + fmtInt(it.calls || 0) + ' 次</b>'));

  if (t.kind === 'minute') {
    const share = t.hourTotal > 0 && it.total ? (it.total / t.hourTotal) * 100 : null;
    rows.push(row('占本小时', share != null ? '<b class="tt-v">' + share.toFixed(1) + '%</b>' : '<b class="tt-v">—</b>'));
  } else {
    const per = (it.calls || 0) > 0 ? fmtCn((it.total || 0) / it.calls) : null;
    rows.push(row('平均每次', per != null ? '<b class="tt-v">' + per + '</b>' : '<b class="tt-v">—</b>'));
    const share = t.dayTotal > 0 && it.total ? ((it.total / t.dayTotal) * 100).toFixed(1) + '%' : null;
    rows.push(row('占全天', share ? '<b class="tt-v">' + share + '</b>' : '<b class="tt-v">—</b>'));
  }

  const m = (opts && opts.metricKey) || 'total';
  // 较上一时段
  let prevSlot = null;
  if (items && i > 0) prevSlot = items[i - 1];
  const prevVal = prevSlot ? prevSlot[m] || prevSlot.total || 0 : null;
  rows.push(row(t.kind === 'minute' ? '较上一分钟' : '较上一小时', deltaHtml(prevVal == null ? null : (it[m] || it.total || 0) - prevVal)));

  // 昨日同期
  let yd = '—';
  let ydPct = '';
  if (t.prev && t.prev[i]) {
    const pv = t.prev[i][m] || t.prev[i].total || 0;
    yd = fmtCn(pv);
    ydPct = pctDeltaHtml(it[m] || it.total || 0, pv);
  }
  rows.push(row('昨日同期', '<b class="tt-v">' + yd + ydPct + '</b>'));

  tip.innerHTML = rows.join('');
  tip.style.display = 'block';
  const pad = 14;
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  const rect = tip.getBoundingClientRect();
  if (x + rect.width > window.innerWidth - 8) x = ev.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = ev.clientY - rect.height - pad;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}

/* ================= 中转站对照台 · 原生页面（不再内嵌网页） =================
   三个面板：测速对照 / 账单核对 / 配置。
   数据全部经 world 的 relayGet / relayPost 转发到本机对照台服务（127.0.0.1:8770）。
   服务默认手动启动，可在「配置」页改成自动启动。 */

const RH_SOURCE = {
  oneapi: '直连同步',
  openslate: '直连同步',
  paste: '粘贴导入',
  script: '脚本推送',
  manual: '手填',
};

const RH_LEVEL = { pass: 'ok', warn: 'warn', fail: 'bad', skip: 'skip' };

function rhNum(v, digits = 0) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return Number(v).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function rhMoney(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  const a = Math.abs(n);
  if (a >= 100) return '¥' + n.toFixed(2);
  if (a >= 1) return '¥' + n.toFixed(3);
  if (a === 0) return '¥0';
  return '¥' + n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function rhZhe(r) {
  if (r == null || !Number.isFinite(Number(r)) || Number(r) <= 0) return '—';
  const v = Number(r);
  if (v >= 1.005) return (v >= 10 ? v.toFixed(0) : v.toFixed(2)) + '× 官方';
  if (v >= 0.995) return '原价';
  return (v * 10).toFixed(2) + ' 折';
}

function rhMs(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  if (n >= 1000) return (n / 1000).toFixed(2) + ' s';
  return Math.round(n) + ' ms';
}

function rhTok(v) {
  if (v == null) return '—';
  const n = Number(v) || 0;
  if (n >= 1e8) return trimNum(n / 1e8) + ' 亿';
  if (n >= 1e4) return trimNum(n / 1e4) + ' 万';
  return rhNum(n);
}

function rhRate(v) {
  if (v == null || !Number.isFinite(Number(v)) || Number(v) <= 0) return '—';
  const n = Number(v);
  if (n >= 1) return '¥' + n.toFixed(2);
  if (n >= 0.001) return '¥' + n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return '¥' + n.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
}

function rhCopy(text) {
  const fallback = () => {
    const ta = el('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    ta.remove();
    if (!ok) throw new Error('复制被系统拦下了');
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(fallback);
  }
  return Promise.resolve().then(fallback);
}

function rhTime(s) {
  const t = String(s || '');
  return t ? t.slice(5, 16) : '—';
}

function rhCall(ctx, method, args) {
  return Promise.resolve()
    .then(() => ctx.invoke(method, args || []))
    .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
}

function rhGet(ctx, path) {
  return rhCall(ctx, 'relayGet', [path]);
}

function rhPost(ctx, path, body) {
  return rhCall(ctx, 'relayPost', [path, body || {}]);
}

function rhBtn(text, cls, onClick) {
  const b = el('button', text, cls);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

function rhTag(text, tone) {
  return el('span', text, 'tb-rh-tag' + (tone ? ' ' + tone : ''));
}

function rhSection(title, sub) {
  const sec = el('section', undefined, 'tb-rh-sec');
  const head = el('div', undefined, 'tb-rh-sec-head');
  head.append(el('h3', title, 'tb-rh-sec-title'));
  if (sub) head.append(el('span', sub, 'tb-rh-sec-sub'));
  const body = el('div', undefined, 'tb-rh-sec-body');
  sec.append(head, body);
  return { sec, body, head };
}

function rhTable(cols) {
  const wrap = el('div', undefined, 'tb-rh-tablewrap');
  const table = el('table', undefined, 'tb-table tb-rh-table');
  const thead = el('thead');
  const htr = el('tr');
  for (const c of cols) {
    const th = el('th', c.title);
    if (c.align === 'right') th.className = 'ta-r';
    htr.append(th);
  }
  thead.append(htr);
  const tbody = el('tbody');
  table.append(thead, tbody);
  wrap.append(table);
  return { wrap, table, tbody };
}

function rhEmpty(text) {
  return el('div', text, 'tb-rh-empty');
}

/* 通用弹窗：fields 里每项 {key,label,type,value,placeholder,hint,options} */
function rhModal(host, opts) {
  return new Promise((resolve) => {
    const wrap = el('div', undefined, 'tb-rh-mask');
    const panel = el('div', undefined, 'tb-rh-modal');
    const head = el('div', undefined, 'tb-rh-modal-head');
    const titles = el('div');
    titles.append(el('div', opts.title, 'tb-rh-modal-title'));
    if (opts.sub) titles.append(el('div', opts.sub, 'tb-rh-modal-sub'));
    const x = rhBtn('×', 'tb-rh-x', () => finish(null));
    head.append(titles, x);

    const body = el('div', undefined, 'tb-rh-modal-body');
    const inputs = {};
    for (const f of opts.fields || []) {
      const row = el('label', undefined, 'tb-rh-field');
      const lab = el('span', f.label, 'tb-rh-field-label');
      row.append(lab);
      let input;
      if (f.type === 'select') {
        input = el('select', undefined, 'tb-rh-input');
        for (const o of f.options || []) {
          const op = el('option', o.label);
          op.value = String(o.value);
          input.append(op);
        }
        input.value = f.value == null ? '' : String(f.value);
      } else if (f.type === 'textarea') {
        input = el('textarea', undefined, 'tb-rh-input tb-rh-textarea');
        input.rows = f.rows || 7;
        input.value = f.value == null ? '' : String(f.value);
        if (f.placeholder) input.placeholder = f.placeholder;
      } else {
        input = el('input', undefined, 'tb-rh-input');
        input.type = f.type || 'text';
        if (f.step) input.step = String(f.step);
        input.value = f.value == null ? '' : String(f.value);
        if (f.placeholder) input.placeholder = f.placeholder;
      }
      row.append(input);
      if (f.hint) row.append(el('span', f.hint, 'tb-rh-field-hint'));
      inputs[f.key] = input;
      body.append(row);
    }
    if (opts.note) body.append(el('div', opts.note, 'tb-rh-note'));

    const err = el('div', '', 'tb-rh-modal-err');
    const foot = el('div', undefined, 'tb-rh-modal-foot');
    const cancel = rhBtn('取消', 'tb-ghost', () => finish(null));
    const ok = rhBtn(opts.okText || '确定', 'tb-primary', async () => {
      const data = {};
      for (const key of Object.keys(inputs)) data[key] = inputs[key].value;
      err.textContent = '';
      ok.disabled = true;
      cancel.disabled = true;
      const old = ok.textContent;
      ok.textContent = '处理中…';
      let msg = '';
      try {
        msg = (await opts.onOk(data)) || '';
      } catch (e) {
        msg = String((e && e.message) || e);
      }
      ok.disabled = false;
      cancel.disabled = false;
      ok.textContent = old;
      if (msg) {
        err.textContent = msg;
        return;
      }
      finish(data);
    });
    foot.append(cancel, ok);
    panel.append(head, body, err, foot);
    wrap.append(panel);
    wrap.addEventListener('click', (ev) => {
      if (ev.target === wrap) finish(null);
    });
    host.append(wrap);
    setTimeout(() => {
      const first = panel.querySelector('input,textarea,select');
      if (first) first.focus();
    }, 30);

    function finish(v) {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    }
    function onKey(ev) {
      if (ev.key === 'Escape') finish(null);
    }
    document.addEventListener('keydown', onKey);
  });
}

function rhConfirm(host, title, sub, okText) {
  return rhModal(host, {
    title,
    sub,
    okText: okText || '确定',
    fields: [],
    onOk: async () => '',
  }).then((v) => !!v);
}

function rhAlert(host, title, text) {
  return rhModal(host, { title, sub: text, okText: '知道了', fields: [], onOk: async () => '' });
}

/* ============================ 测速对照 ============================ */

function rhHost(url) {
  try {
    return new URL(String(url || '')).host || String(url || '');
  } catch (e) {
    return String(url || '');
  }
}

function rhInput(opts) {
  const o = opts || {};
  const inp = el('input', undefined, 'tb-rh-input');
  inp.type = o.type || 'text';
  if (o.value != null) inp.value = String(o.value);
  if (o.placeholder) inp.placeholder = o.placeholder;
  if (o.step) inp.step = String(o.step);
  if (o.min != null) inp.min = String(o.min);
  if (o.width) inp.style.width = o.width;
  return inp;
}

function rhFieldBox(label, input, hint) {
  const box = el('label', undefined, 'tb-rh-field');
  box.append(el('span', label, 'tb-rh-field-label'));
  box.append(input);
  if (hint) box.append(el('span', hint, 'tb-rh-field-hint'));
  return box;
}

function rhSelect(options, value, cls) {
  const sel = el('select', undefined, cls || 'tb-rh-input');
  for (const o of options) {
    const op = el('option', o.label);
    op.value = String(o.value);
    sel.append(op);
  }
  sel.value = value == null ? '' : String(value);
  return sel;
}

function mountSpeed(ctx) {
  const root = el('div', undefined, 'tb-root tb-rh');
  ctx.root.append(root);

  const head = el('div', undefined, 'tb-head');
  const titleWrap = el('div', undefined, 'tb-title-wrap');
  titleWrap.append(el('h2', '测速对照', 'tb-title'));
  titleWrap.append(el('span', '同一 prompt · 同一参数 · 各自对照自家官方价', 'tb-source'));

  const tools = el('div', undefined, 'tb-tools');
  const seg = el('div', undefined, 'tb-tabs');
  const MODES = [
    { key: 'interactive', name: '在线交互' },
    { key: 'batch', name: '离线批处理' },
  ];
  const modeBtns = {};
  for (const m of MODES) {
    const b = rhBtn(m.name, 'tb-tab' + (m.key === 'interactive' ? ' on' : ''), () => {
      state.mode = m.key;
      for (const k of Object.keys(modeBtns)) modeBtns[k].classList.toggle('on', k === m.key);
      load();
    });
    modeBtns[m.key] = b;
    seg.append(b);
  }
  const addBtn = rhBtn('+ 添加中转站', 'tb-ghost', () => openStation(null));
  const refreshBtn = rhBtn('刷新', 'tb-ghost', () => load());
  tools.append(seg, addBtn, refreshBtn);
  head.append(titleWrap, tools);
  root.append(head);

  const body = el('div', undefined, 'tb-rh-body');
  root.append(body);

  const state = {
    mode: 'interactive',
    cmp: null,
    targets: [],
    vendors: [],
    err: '',
    loading: true,
    sel: null,
    checked: new Set(),
    filter: 'all',
    opts: { runs: 30, warmup: 2, max_tokens: 1024, thinking: 'default', prompt: '' },
    run: null,
    timer: null,
  };

  function compareTarget(id) {
    const groups = (state.cmp && state.cmp.groups) || [];
    for (const g of groups) {
      for (const t of g.targets || []) if (t.id === id) return t;
    }
    return null;
  }

  function groupOf(id) {
    const groups = (state.cmp && state.cmp.groups) || [];
    for (const g of groups) {
      for (const t of g.targets || []) if (t.id === id) return g;
    }
    return null;
  }

  function isPicked(id) {
    const groups = (state.cmp && state.cmp.groups) || [];
    for (const g of groups) if (g.pick && g.pick.id === id) return true;
    return false;
  }

  function currentTarget() {
    return state.targets.find((t) => t.id === state.sel) || null;
  }

  function vendorName(key) {
    const v = state.vendors.find((x) => x.key === key);
    if (v) return v.name;
    const t = state.targets.find((x) => x.vendor === key);
    return (t && t.vendor_name) || key || '其它';
  }

  async function load() {
    state.loading = !state.cmp;
    const [c, t, v] = await Promise.all([
      rhGet(ctx, '/api/compare?mode=' + state.mode),
      rhGet(ctx, '/api/targets'),
      rhGet(ctx, '/api/vendors'),
    ]);
    state.loading = false;
    if (c.ok) state.cmp = c.data;
    state.targets = t.ok ? t.data || [] : [];
    if (v.ok) state.vendors = v.data || [];
    state.err = c.ok ? t.error || '' : c.error || '读不到对照台数据';
    if (state.sel && !state.targets.some((x) => x.id === state.sel)) state.sel = null;
    if (!state.sel && state.targets.length) state.sel = state.targets[0].id;
    const alive = new Set(state.targets.map((x) => x.id));
    state.checked = new Set([...state.checked].filter((id) => alive.has(id)));
    render();
  }

  function render() {
    body.replaceChildren();
    if (state.err && !state.targets.length) {
      body.append(offlineCard(state.err));
      return;
    }
    body.append(renderList());
    body.append(renderRun());
    body.append(renderScen());
  }

  function offlineCard(msg) {
    const box = el('div', undefined, 'tb-rh-offline');
    box.append(el('div', '对照台服务没有连上', 'tb-rh-offline-title'));
    box.append(
      el(
        'div',
        '服务是独立的本地小程序（默认端口 8770）。默认手动启动：到「配置」页点一次「启动服务」，或在配置里把启动方式改成「自动启动」。',
        'tb-rh-offline-sub'
      )
    );
    box.append(el('div', String(msg || ''), 'tb-rh-offline-err'));
    const row = el('div', undefined, 'tb-rh-row');
    const go = rhBtn('启动服务', 'tb-primary', async () => {
      go.disabled = true;
      go.textContent = '启动中…';
      const r = await rhCall(ctx, 'relayStart', []);
      go.disabled = false;
      go.textContent = '启动服务';
      if (!r || !r.ok) {
        box.append(el('div', (r && r.message) || '启动失败', 'tb-rh-offline-err'));
        return;
      }
      load();
    });
    row.append(go);
    box.append(row);
    return box;
  }

  /* -------- 中转站列表（按品牌分组、可多选） -------- */

  function renderList() {
    const { sec, body: sb, head: sh } = rhSection('中转站', '按品牌分组 · 勾选后底部可一键批量测速');
    if (state.loading) {
      sb.append(rhEmpty('正在读取…'));
      return sec;
    }
    if (!state.targets.length) {
      sb.append(rhEmpty('还没有中转站，点右上角「+ 添加中转站」。'));
      return sec;
    }

    const groups = (state.cmp && state.cmp.groups) || [];
    const picks = groups.filter((g) => g.pick);
    if (picks.length) sb.append(renderPicks(picks));

    /* 品牌筛选 */
    const counts = new Map();
    for (const t of state.targets) {
      const k = t.vendor || 'other';
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    if (state.filter !== 'all' && !counts.has(state.filter)) state.filter = 'all';
    const chips = el('div', undefined, 'tb-rh-chips');
    const mkChip = (key, label, n) => {
      const b = rhBtn(label + ' ' + n, 'tb-rh-chip' + (state.filter === key ? ' on' : ''), () => {
        state.filter = key;
        render();
      });
      return b;
    };
    chips.append(mkChip('all', '全部', state.targets.length));
    for (const [k, n] of counts) chips.append(mkChip(k, vendorName(k), n));
    sb.append(chips);

    /* 品牌分组 */
    const order = state.vendors.map((v) => v.key);
    const keys = [...counts.keys()].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
    for (const k of keys) {
      if (state.filter !== 'all' && state.filter !== k) continue;
      const rows = state.targets.filter((t) => (t.vendor || 'other') === k);
      const groupBox = el('div', undefined, 'tb-rh-group');
      const gh = el('div', undefined, 'tb-rh-group-h');
      gh.append(el('span', vendorName(k), 'tb-rh-group-name'));
      gh.append(el('span', rows.length + ' 个', 'tb-rh-sub'));
      groupBox.append(gh);
      const grid = el('div', undefined, 'tb-rh-cards2');
      for (const t of rows) grid.append(renderCard(t));
      groupBox.append(grid);
      sb.append(groupBox);
    }

    /* 底部操作条 */
    const bar = el('div', undefined, 'tb-rh-selbar');
    bar.append(el('span', state.checked.size + ' 个已选', 'tb-rh-selbar-n'));
    const visible = state.targets.filter((t) => state.filter === 'all' || (t.vendor || 'other') === state.filter);
    const allOn = visible.length > 0 && visible.every((t) => state.checked.has(t.id));
    const allBtn = rhBtn(allOn ? '取消全选' : '全选', 'tb-ghost', () => {
      if (allOn) for (const t of visible) state.checked.delete(t.id);
      else for (const t of visible) state.checked.add(t.id);
      render();
    });
    const busy = !!state.run && state.run.status === 'running';
    const goBtn = rhBtn(
      busy ? '测速中…' : state.checked.size > 1 ? '一键测试 ' + state.checked.size + ' 个' : '一键测试',
      'tb-primary',
      () => startBatch()
    );
    goBtn.disabled = state.checked.size === 0 || busy;
    bar.append(el('div', undefined, 'tb-rh-spacer'), allBtn, goBtn);
    sb.append(bar);
    return sec;
  }

  function renderPicks(picks) {
    const wrap = el('div', undefined, 'tb-rh-picks' + (picks.length === 1 ? ' single' : ''));
    picks.forEach((g, i) => {
      const p = g.pick;
      const card = el('div', undefined, 'tb-rh-pickcard c' + (i % 4));
      const top = el('div', undefined, 'tb-rh-pickcard-top');
      top.append(el('span', g.name + ' · 推荐', 'tb-rh-pickcard-brand'));
      top.append(el('span', '★ 首选', 'tb-rh-pickcard-flag'));
      card.append(top);
      const nameRow = el('div', undefined, 'tb-rh-pickcard-name-row');
      nameRow.append(el('div', p.name, 'tb-rh-pickcard-name'));
      nameRow.append(el('div', rhZhe(p.ratio), 'tb-rh-pickcard-zhe'));
      card.append(nameRow);
      const stats = el('div', undefined, 'tb-rh-pickcard-stats');
      const addStat = (k, v) => {
        const cell = el('span', undefined, 'tb-rh-pickcard-stat');
        cell.append(el('i', k), el('b', v));
        stats.append(cell);
      };
      addStat('首字', rhMs(p.ttft));
      if (p.save_per_10k != null) addStat('每万次省', rhMoney(p.save_per_10k));
      if (p.ratio && p.ratio < 1) addStat('比官方省', Math.round((1 - p.ratio) * 100) + '%');
      card.append(stats);
      if (p.verdict && p.verdict.why) card.append(el('div', p.verdict.why, 'tb-rh-pickcard-why'));
      card.tabIndex = 0;
      card.addEventListener('click', () => {
        state.sel = p.id;
        render();
      });
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          state.sel = p.id;
          render();
        }
      });
      wrap.append(card);
    });
    return wrap;
  }

  function renderCard(t) {
    const c = compareTarget(t.id);
    const card = el(
      'div',
      undefined,
      'tb-rh-tgt' + (t.id === state.sel ? ' on' : '') + (state.checked.has(t.id) ? ' checked' : '')
    );
    card.tabIndex = 0;
    card.addEventListener('click', () => {
      state.sel = t.id;
      render();
    });
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        state.sel = t.id;
        render();
      }
    });

    const top = el('div', undefined, 'tb-rh-tgt-top');
    const cb = el('input', undefined, 'tb-rh-check');
    cb.type = 'checkbox';
    cb.checked = state.checked.has(t.id);
    cb.title = '勾选后可一键批量测速';
    cb.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (cb.checked) state.checked.add(t.id);
      else state.checked.delete(t.id);
      render();
    });
    cb.addEventListener('dblclick', (ev) => ev.stopPropagation());

    const nameWrap = el('div', undefined, 'tb-rh-tgt-namewrap');
    const line = el('div', undefined, 'tb-rh-name-line');
    line.append(el('b', t.name, 'tb-rh-tgt-name'));
    if (t.is_base) line.append(rhTag('基线', 'green'));
    if (isPicked(t.id)) line.append(rhTag('推荐', 'blue'));
    if (c && c.billed && c.billed.stable === false) line.append(rhTag('单价不稳', 'amber'));
    nameWrap.append(line);
    nameWrap.append(el('div', (t.model || '—') + ' · ' + rhHost(t.base_url), 'tb-rh-tgt-meta'));
    top.append(cb, nameWrap);

    if (c) {
      const badge = el('span', undefined, 'tb-rh-tgt-badge');
      if (c.price_basis === 'billed' && c.eff) badge.textContent = '实扣 ' + trimNum(c.eff.in) + '/' + trimNum(c.eff.out);
      else badge.textContent = '标价 ' + trimNum(c.prices.in) + '/' + trimNum(c.prices.out);
      if (c.price_basis === 'billed') badge.title = '按最近账单的实扣价折算（元 / 百万 token）';
      else badge.title = '站点标价（元 / 百万 token）';
      top.append(badge);
    }
    card.append(top);

    const foot = el('div', undefined, 'tb-rh-tgt-foot');
    const stats = el('div', undefined, 'tb-rh-tgt-stats');
    if (c) {
      const zhe = el('span', rhZhe(c.ratio), 'tb-rh-tgt-zhe' + (c.ratio > 1.02 ? ' bad' : ''));
      zhe.title = '按 ' + (c.price_basis === 'billed' ? '实扣价' : '标价') + ' 算的单次成本 / 官方直连';
      stats.append(zhe);
      const lat = el('span', c.ttft ? rhMs(c.ttft) : '未测', 'tb-rh-tgt-lat');
      if (c.ttft != null && c.dttft != null) {
        lat.title = '较同品牌基线 ' + (c.dttft >= 0 ? '+' : '') + Math.round(c.dttft) + ' ms';
      }
      stats.append(lat);
      if (c.save_per_10k != null) {
        const sv10 = el('span', '万次省 ' + rhMoney(c.save_per_10k), 'tb-rh-tgt-save');
        stats.append(sv10);
      }
    } else {
      stats.append(el('span', '还没数据', 'tb-rh-sub'));
    }

    const ops = el('div', undefined, 'tb-rh-tgt-ops');
    ops.append(
      rhBtn('编辑', 'tb-rh-link', (ev) => {
        ev.stopPropagation();
        openStation(t);
      }),
      rhBtn('测试', 'tb-rh-link', (ev) => {
        ev.stopPropagation();
        state.sel = t.id;
        render();
        focusRun();
      }),
      rhBtn('删除', 'tb-rh-link danger', (ev) => {
        ev.stopPropagation();
        removeTarget(t);
      })
    );
    foot.append(stats, ops);
    card.append(foot);
    return card;
  }

  /* -------- 同一工作量，谁更便宜 -------- */

  function renderScen() {
    const { sec, body: sb } = rhSection('同一工作量，谁更便宜', '把每家的单价套到同一个请求上，才是可比的价格');
    const scenarios = (state.cmp && state.cmp.scenarios) || [];
    if (!scenarios.length) {
      sb.append(rhEmpty('还没有可对比的数据'));
      return sec;
    }
    const index = new Map();
    for (const sc of scenarios) {
      for (const r of sc.rows || []) {
        if (!index.has(r.id)) index.set(r.id, { id: r.id, name: r.name, base: !!r.is_base, cells: {} });
        index.get(r.id).cells[sc.key] = r;
      }
    }
    const rows = [...index.values()];
    const firstKey = scenarios[0].key;
    rows.sort((a, b) => {
      const av = a.cells[firstKey];
      const bv = b.cells[firstKey];
      return (av ? av.ratio : 9) - (bv ? bv.ratio : 9);
    });

    const t = rhTable([
      { title: '目标' },
      ...scenarios.map((s) => ({ title: s.label, align: 'right' })),
      { title: '最低', align: 'right' },
    ]);
    for (const r of rows) {
      const tr = el('tr');
      if (r.id === state.sel) tr.className = 'on';
      const name = el('td');
      name.append(el('b', r.name));
      if (r.base) name.append(rhTag('基线', 'gray'));
      tr.append(name);
      let min = null;
      for (const s of scenarios) {
        const c = r.cells[s.key];
        min = min == null || (c && c.ratio < min.ratio) ? c || null : min;
      }
      for (const s of scenarios) {
        const c = r.cells[s.key];
        const td = el('td', c ? rhZhe(c.ratio) : '—', 'ta-r');
        if (c && c.basis === 'billed') td.title = '按实扣价算 ' + rhMoney(c.cost) + ' / 官方 ' + rhMoney(c.official);
        else if (c) td.title = '按标价算 ' + rhMoney(c.cost) + ' / 官方 ' + rhMoney(c.official);
        if (c && c.stable === false) {
          td.append(el('span', ' 不稳定', 'tb-rh-mini-warn'));
          td.title += ' · 该站单价波动大，均值不可复现';
        }
        if (min && c === min) td.classList.add('tb-rh-best');
        tr.append(td);
      }
      const low = el('td', min ? rhZhe(min.ratio) : '—', 'ta-r');
      tr.append(low);
      t.tbody.append(tr);
    }
    sb.append(t.wrap);
    return sec;
  }

  /* -------- 测速 -------- */

  function makeRun(rows, auto) {
    return {
      queue: rows.map((t) => ({ target: t, status: 'wait', err: '' })),
      idx: 0,
      curIdx: -1,
      job: '',
      rows: [],
      done: 0,
      total: 0,
      phase: '',
      status: auto ? 'running' : 'idle',
      err: '',
    };
  }

  function focusRun() {
    setTimeout(() => {
      const node = body.querySelector('.tb-rh-runsec');
      if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 40);
  }

  function stopPoll() {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  function startBatch() {
    const ids = state.checked.size
      ? state.targets.filter((t) => state.checked.has(t.id)).map((t) => t.id)
      : state.sel
      ? [state.sel]
      : [];
    if (!ids.length) return;
    stopPoll();
    const prev = state.run;
    if (prev && prev.status === 'running') return;
    state.run = makeRun(state.targets.filter((t) => ids.includes(t.id)), true);
    render();
    focusRun();
    kick();
  }

  async function kick() {
    const run = state.run;
    if (!run) return;
    const item = run.queue[run.idx];
    if (!item) {
      run.status = 'done';
      run.idx = run.curIdx + 1;
      render();
      load();
      return;
    }
    item.status = 'run';
    run.curIdx = run.idx;
    run.job = '';
    run.rows = [];
    run.done = 0;
    run.total = Number(state.opts.runs) || 30;
    run.phase = '';
    run.err = '';
    run.status = 'running';
    state.sel = item.target.id;
    render();
    const r = await rhPost(ctx, '/api/bench', {
      target_id: item.target.id,
      runs: Number(state.opts.runs) || 30,
      warmup: Number(state.opts.warmup) || 0,
      max_tokens: Number(state.opts.max_tokens) || 1024,
      thinking: state.opts.thinking,
      prompt: state.opts.prompt || '',
    });
    if (state.run !== run) return;
    if (!r.ok) {
      item.status = 'error';
      item.err = r.error || '启动失败';
      run.idx += 1;
      render();
      setTimeout(() => {
        if (state.run === run) kick();
      }, 240);
      return;
    }
    run.job = (r.data && r.data.job_id) || '';
    render();
    pollRun();
  }

  async function pollRun() {
    const run = state.run;
    if (!run || !run.job) return;
    const r = await rhGet(ctx, '/api/bench/' + run.job);
    if (state.run !== run) return;
    const item = run.queue[run.curIdx];
    if (!r.ok) {
      run.err = r.error || '读不到测速进度';
      if (item) {
        item.status = 'error';
        item.err = run.err;
      }
      run.status = 'error';
      render();
      return;
    }
    const j = r.data || {};
    run.rows = j.rows || [];
    run.done = j.done || 0;
    run.total = j.total || run.total;
    run.phase = j.phase || '';
    run.status = j.status || 'running';
    if (j.summary) run.summary = j.summary;
    if (j.error) run.err = j.error;
    if (run.status === 'done') {
      if (item) {
        item.status = 'done';
        item.summary = j.summary || null;
      }
      run.idx += 1;
      render();
      if (run.idx < run.queue.length) kick();
      else {
        run.status = 'done';
        render();
        load();
      }
      return;
    }
    if (run.status === 'running') {
      render();
      state.timer = setTimeout(pollRun, 900);
    } else {
      if (item && run.status !== 'done') {
        item.status = 'error';
        item.err = run.err || statusText(run.status);
      }
      run.idx += 1;
      render();
      if (run.idx < run.queue.length) kick();
    }
  }

  async function cancelRun() {
    const run = state.run;
    if (!run) return;
    if (run.job) await rhPost(ctx, '/api/bench/cancel', { job_id: run.job });
    stopPoll();
    run.status = 'cancelled';
    for (const it of run.queue) if (it.status === 'run') it.status = 'wait';
    render();
  }

  function statusText(s) {
    return { done: '完成', error: '出错', cancelled: '已取消', blocked: '被拦下' }[s] || s;
  }

  function renderRun() {
    const { sec, body: sb, head: sh } = rhSection('测速', '同一 prompt 连跑多次，取均值 / 中位 / p95');
    sec.classList.add('tb-rh-runsec');
    const run = state.run;
    const running = !!run && run.status === 'running';
    const cur = run && run.queue[run.curIdx] ? run.queue[run.curIdx].target : currentTarget();
    if (cur) sh.append(el('span', '当前：' + cur.name, 'tb-rh-sec-sub'));
    if (run && run.queue.length > 1) {
      const close = rhBtn('收起', 'tb-ghost', () => {
        if (running) return;
        stopPoll();
        state.run = null;
        render();
      });
      close.disabled = running;
      sh.append(el('span', undefined, 'tb-rh-spacer'), close);
    }

    /* 批量队列 */
    if (run && run.queue.length > 1) {
      const q = el('div', undefined, 'tb-rh-batch');
      run.queue.forEach((it, i) => {
        const row = el('div', undefined, 'tb-rh-batch-row' + (i === run.curIdx && running ? ' on' : ''));
        row.append(el('i', undefined, 'tb-rh-batch-dot ' + it.status));
        row.append(el('span', i + 1 + '. ' + it.target.name, 'tb-rh-batch-name'));
        const txt =
          it.status === 'done'
            ? '完成 · ' + (it.summary && it.summary.ttft_mean ? rhMs(it.summary.ttft_mean) : '')
            : it.status === 'error'
            ? it.err || '失败'
            : it.status === 'run'
            ? '测速中…'
            : '等待';
        row.append(el('span', txt, 'tb-rh-sub'));
        q.append(row);
      });
      sb.append(q);
    }

    /* 参数表单 */
    const form = el('div', undefined, 'tb-rh-form');
    const mkNum = (key, label, width) => {
      const inp = rhInput({ type: 'number', value: state.opts[key], width: width });
      inp.disabled = running;
      inp.addEventListener('input', () => {
        state.opts[key] = Number(inp.value) || 0;
      });
      const box = el('label', undefined, 'tb-rh-field inline');
      box.append(el('span', label, 'tb-rh-field-label'), inp);
      form.append(box);
    };
    mkNum('runs', '次数', '86px');
    mkNum('warmup', '预热（丢弃）', '104px');
    mkNum('max_tokens', 'max_tokens', '110px');
    const think = rhSelect(
      [
        { value: 'default', label: '默认（跟随模型）' },
        { value: 'enabled', label: '强制开启' },
        { value: 'disabled', label: '关闭' },
      ],
      state.opts.thinking
    );
    think.disabled = running;
    think.style.width = '150px';
    think.addEventListener('change', () => {
      state.opts.thinking = think.value;
    });
    const thinkBox = el('label', undefined, 'tb-rh-field inline');
    thinkBox.append(el('span', '思考', 'tb-rh-field-label'), think);
    form.append(thinkBox);

    const promptIn = rhInput({ value: state.opts.prompt, placeholder: '留空用内置标准 prompt' });
    promptIn.disabled = running;
    promptIn.classList.add('tb-rh-grow');
    promptIn.addEventListener('input', () => {
      state.opts.prompt = promptIn.value;
    });
    const promptBox = el('label', undefined, 'tb-rh-field inline tb-rh-grow');
    promptBox.append(el('span', 'Prompt', 'tb-rh-field-label'), promptIn);
    form.append(promptBox);

    const go = rhBtn(running ? '测速中…' : '开始测试', 'tb-primary', () => {
      if (!cur || running) return;
      stopPoll();
      state.run = makeRun([cur], true);
      render();
      kick();
    });
    go.disabled = !cur || running;
    form.append(go);
    sb.append(form);
    sb.append(
      el(
        'div',
        '思考开着 = 贴近你平时的用法：结果里看「首字延迟」，价格按真实输出（含思考 token）算。关掉只比纯输出速度，跑得快省钱，但比出来的价会偏低。',
        'tb-rh-note'
      )
    );

    /* 进度 */
    if (run && (running || run.status === 'cancelled' || run.status === 'error')) {
      const per = Number(state.opts.runs) || 30;
      const totalAll = run.queue.length * per;
      const doneAll = run.curIdx * per + run.done;
      const pct = totalAll ? Math.min(100, Math.round((doneAll / totalAll) * 100)) : 0;
      const line = el('div', undefined, 'tb-rh-runline');
      const label =
        run.queue.length > 1
          ? '正在测 ' + (run.curIdx + 1) + '/' + run.queue.length + '：' + (run.queue[run.curIdx] ? run.queue[run.curIdx].target.name : '')
          : run.status === 'running'
          ? '正在测'
          : statusText(run.status);
      line.append(el('b', label));
      // phase 在跑正式样本时就是 "3/30"，和 done/total 重复，只在预热/连接阶段才显示
      const phaseTxt = run.phase && !/^\d+\/\d+$/.test(run.phase) ? ' · ' + run.phase : '';
      line.append(el('span', ' ' + run.done + ' / ' + (run.total || per) + phaseTxt, 'tb-rh-sub'));
      if (running) line.append(el('span', undefined, 'tb-rh-spacer'), rhBtn('取消', 'tb-ghost', cancelRun));
      sb.append(line);
      const bar = el('div', undefined, 'tb-rh-progress');
      const fill = el('i');
      fill.style.width = pct + '%';
      bar.append(fill);
      sb.append(bar);

      if (run.rows && run.rows.length) {
        const tb = rhTable([
          { title: '#', align: 'right' },
          { title: '首字', align: 'right' },
          { title: '总时长', align: 'right' },
          { title: 'tps', align: 'right' },
          { title: '输入', align: 'right' },
          { title: '输出', align: 'right' },
        ]);
        const rows = run.rows.slice(-8);
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          const tr = el('tr');
          tr.append(el('td', run.done - rows.length + i + 1, 'ta-r'));
          tr.append(el('td', Math.round(r.ttft_ms) + ' ms', 'ta-r'));
          tr.append(el('td', (r.total_ms / 1000).toFixed(2) + ' s', 'ta-r'));
          tr.append(el('td', (r.tps || 0).toFixed(1), 'ta-r'));
          tr.append(el('td', rhNum(r.input_tokens), 'ta-r'));
          tr.append(el('td', rhNum(r.output_tokens), 'ta-r'));
          tb.tbody.append(tr);
        }
        sb.append(tb.wrap);
      }
    }
    if (run && run.err) sb.append(el('div', run.err, 'tb-rh-err'));

    /* 当前目标最近一次结果 */
    if (cur && !running) sb.append(renderLast(cur));
    return sec;
  }

  function renderLast(t) {
    const c = compareTarget(t.id);
    const sm = c && c.summary;
    const box = el('div', undefined, 'tb-rh-last');
    const head = el('div', undefined, 'tb-rh-last-head');
    head.append(el('h4', '当前目标最近一次结果', 'tb-rh-sec-title'));
    if (c && c.runs) head.append(rhTag('测了 ' + c.runs + ' 次', 'gray'));
    if (sm && sm.thinking) {
      const map = { default: '思考默认', enabled: '思考开启', disabled: '思考关闭' };
      head.append(rhTag(map[sm.thinking] || sm.thinking, 'gray'));
    }
    if (c && c.price_basis === 'billed') head.append(rhTag('成本按实扣价', 'blue'));
    box.append(head);

    if (!sm || !sm.runs) {
      box.append(rhEmpty('这个站还没测过。点上面的「开始测试」，一轮 30 次大概几十秒。'));
      return box;
    }

    const grid = el('div', undefined, 'tb-rh-cards');
    const add = (k, v, tone, small) => {
      const cell = el('div', undefined, 'tb-rh-card');
      cell.append(el('div', k, 'tb-rh-card-k'));
      const val = el('div', undefined, 'tb-rh-card-v' + (tone ? ' ' + tone : ''));
      val.append(document.createTextNode(v));
      if (small) val.append(el('small', small));
      cell.append(val);
      grid.append(cell);
    };
    add('首字延迟 ttft', rhMs(sm.ttft_mean));
    add('p95 / 最差', rhMs(sm.ttft_p95) + ' / ' + rhMs(sm.ttft_max));
    add('解码速度', (sm.tps_mean || 0).toFixed(1), '', ' tok/s');
    add('单次成本（实测）', rhMoney(sm.relay_cny), '', ' / 次');
    const dtxt = c && c.dttft != null ? (c.dttft >= 0 ? '+' : '') + Math.round(c.dttft) + ' ms' : '—';
    add('同品牌延迟差', dtxt, c && c.dttft != null && c.dttft > 50 ? 'bad' : c && c.dttft != null ? 'good' : '');
    add('每万次省', c && c.save_per_10k != null ? rhMoney(c.save_per_10k) : '—', c && c.save_per_10k > 0 ? 'good' : '');
    box.append(grid);

    if (sm.stopped && sm.stopped.text) box.append(el('div', sm.stopped.text, 'tb-rh-err'));
    if (sm.partial) box.append(el('div', '这一轮是被提前停下的，样本数偏少，结论只作参考。', 'tb-rh-note'));
    box.append(renderRecon(c, sm));
    return box;
  }

  function renderRecon(c, sm) {
    const wrap = el('div', undefined, 'tb-rh-recon');
    const head = el('div', undefined, 'tb-rh-recon-head');
    head.append(el('b', '对账：站点后台实扣 ¥'));
    const amt = rhInput({ type: 'number', step: '0.000001', placeholder: '如 0.000052', width: '150px' });
    const mode = rhSelect(
      [
        { value: 'total', label: '整轮合计' },
        { value: 'each', label: '单次' },
      ],
      'total',
      'tb-rh-input tb-rh-input-mini'
    );
    head.append(amt, mode);
    const txt = el('div', undefined, 'tb-rh-recon-text');
    const runs = sm.runs || 1;
    const off = sm.official_cny || 0;

    const calc = () => {
      const a = Number(amt.value);
      if (!a || a <= 0) {
        txt.textContent =
          '这一轮共 ' +
          runs +
          ' 次，按官方价应扣 ' +
          rhMoney(off * runs) +
          '（单次 ' +
          rhMoney(off) +
          '）。把站点后台看到的扣费填进来，我给你算真实折扣。';
        return;
      }
      const per = mode.value === 'total' ? a / runs : a;
      const ratio = off > 0 ? per / off : 0;
      const savePct = ratio > 0 ? Math.round((1 - ratio) * 100) : 0;
      txt.textContent =
        '单次 ¥' +
        per.toFixed(6) +
        '，是官方价的 ' +
        (ratio * 100).toFixed(1) +
        '%（' +
        rhZhe(ratio) +
        '）' +
        (savePct > 0 ? '，比官方省 ' + savePct + '%' : '，比官方贵 ' + Math.abs(savePct) + '%') +
        '。整轮 ' +
        runs +
        ' 次 ≈ ¥' +
        (per * runs).toFixed(6) +
        '（官方 ¥' +
        (off * runs).toFixed(6) +
        '）。';
    };
    amt.addEventListener('input', calc);
    mode.addEventListener('change', calc);
    calc();
    wrap.append(head, txt);
    return wrap;
  }

  /* -------- 中转站增删改 -------- */

  function openStation(row) {
    const isNew = !row;
    const vendors = state.vendors.slice();
    const vmap = new Map(vendors.map((v) => [v.key, v]));
    let vendorKey = row ? row.vendor || 'deepseek' : vendors[0] ? vendors[0].key : 'deepseek';
    if (!vmap.has(vendorKey)) vmap.set(vendorKey, { key: vendorKey, name: vendorKey, models: [] });

    const vendorModels = (vk) => {
      const v = vmap.get(vk);
      return ((v && v.models) || []).map((m) => ({
        id: m[0],
        in: m[1],
        out: m[2],
        cache: m[3],
        note: m[4] || '',
      }));
    };

    let modelList = [];
    let currentModel = row ? row.model : '';
    // 编辑已有站：参考价 / 标价都以保存值为准，只有用户主动换品牌、换模型时才跟着变
    let refAuto = isNew;
    let priceAuto =
      isNew ||
      (!!row && row.price_in === row.ref_in && row.price_out === row.ref_out && row.price_cache === row.ref_cache);

    const wrap = el('div', undefined, 'tb-rh-mask');
    const panel = el('div', undefined, 'tb-rh-modal tb-rh-modal-wide');
    const mhead = el('div', undefined, 'tb-rh-modal-head');
    const titles = el('div');
    titles.append(el('div', isNew ? '添加中转站' : '编辑：' + row.name, 'tb-rh-modal-title'));
    titles.append(el('div', '标价填站点牌价（元 / 百万 token），留空会按品牌参考价补。', 'tb-rh-modal-sub'));
    const xBtn = rhBtn('×', 'tb-rh-x', () => finish());
    mhead.append(titles, xBtn);

    const mbody = el('div', undefined, 'tb-rh-modal-body');

    /* 名称 / 地址 */
    const nameIn = rhInput({ value: row ? row.name : '', placeholder: '如：juflow' });
    const urlIn = rhInput({ value: row ? row.base_url : '', placeholder: 'https://xxx.com/v1' });
    const g1 = el('div', undefined, 'tb-rh-form-grid');
    g1.append(rhFieldBox('名称（显示用）', nameIn), rhFieldBox('Base URL', urlIn));
    mbody.append(g1);

    /* Key */
    const keyIn = rhInput({
      type: 'password',
      value: '',
      placeholder: row ? '留空 = 不改（' + (row.api_key_masked || '') + '）' : 'sk-...（读模型、跑测试都要用）',
    });
    mbody.append(
      rhFieldBox('API Key', keyIn, '模型清单按这个 key 读——只列它实际能调的，不是站点全部模型。')
    );

    /* 品牌 / 模型 */
    const vendorSel = rhSelect(
      vendors.map((v) => ({ value: v.key, label: v.name })),
      vendorKey
    );
    if (!vendors.some((v) => v.key === vendorKey)) {
      const o = el('option', vendorKey);
      o.value = vendorKey;
      vendorSel.append(o);
      vendorSel.value = vendorKey;
    }
    const modelSel = el('select', undefined, 'tb-rh-input');
    const readModelsBtn = rhBtn('↻ 从站点读取', 'tb-ghost tb-rh-mini', () => onReadModels());
    readModelsBtn.title = '按这个 API Key 读它实际能调的模型';

    const gm = el('div', undefined, 'tb-rh-form-grid');
    const modelField = el('label', undefined, 'tb-rh-field');
    const modelLabel = el('div', undefined, 'tb-rh-label-line');
    modelLabel.append(el('span', '模型', 'tb-rh-field-label'), readModelsBtn);
    modelField.append(modelLabel, modelSel);
    gm.append(rhFieldBox('品牌', vendorSel), modelField);
    mbody.append(gm);

    /* 参考价 */
    const priceCells = (vals, onChange) => {
      const box = el('div', undefined, 'tb-rh-prices');
      const cells = {};
      const set = (k, v) => {
        if (v == null || v === '') return;
        cells[k].value = String(Math.round(Number(v) * 1e6) / 1e6);
      };
      for (const item of [
        ['in', '输入'],
        ['out', '输出'],
        ['cache', '缓存'],
      ]) {
        const k = item[0];
        const cell = el('label', undefined, 'tb-rh-price-cell');
        cell.append(el('span', item[1]));
        const inp = rhInput({ type: 'number', step: '0.0001', min: 0, value: vals[k] == null ? 0 : vals[k] });
        inp.addEventListener('input', () => {
          if (onChange) onChange(k, inp.value);
        });
        cell.append(inp);
        cells[k] = inp;
        box.append(cell);
      }
      return { box, cells, set };
    };

    const refVals = row
      ? { in: row.ref_in, out: row.ref_out, cache: row.ref_cache }
      : vendorModels(vendorKey)[0] || { in: 1, out: 4, cache: 0.02 };
    const ref = priceCells(refVals, () => {
      refAuto = false;
      ratioCalc();
    });
    const refHead = el('div', undefined, 'tb-rh-pricehead');
    refHead.append(el('span', '官方参考价 ¥/百万（对照用）', 'tb-rh-field-label'));
    const refWrap = el('div', undefined, 'tb-rh-priceblock');
    refWrap.append(refHead, ref.box);
    mbody.append(refWrap);

    const priceVals = row
      ? { in: row.price_in, out: row.price_out, cache: row.price_cache }
      : { in: refVals.in, out: refVals.out, cache: refVals.cache };
    const pr = priceCells(priceVals, () => {
      priceAuto = false;
      ratioCalc();
    });
    const readPriceBtn = rhBtn('↻ 从站点读取', 'tb-ghost tb-rh-mini', () => onReadPrices());
    readPriceBtn.title = '读站点自己公布的牌价（/api/pricing）自动填';
    const prHead = el('div', undefined, 'tb-rh-pricehead');
    prHead.append(el('span', '这个站的实际标价 ¥/百万', 'tb-rh-field-label'), el('span', undefined, 'tb-rh-spacer'), readPriceBtn);
    const prWrap = el('div', undefined, 'tb-rh-priceblock');
    prWrap.append(prHead, pr.box);
    mbody.append(prWrap);

    /* 折扣换算 */
    const ratioRow = el('div', undefined, 'tb-rh-ratio');
    const ratioIn = rhInput({ type: 'number', step: '0.01', min: 0, value: 3, width: '96px' });
    ratioIn.placeholder = '0.3 = 3 折';
    const applyBtn = rhBtn('填进去', 'tb-ghost tb-rh-mini', () => {
      let v = Number(ratioIn.value);
      if (!v || v <= 0) return;
      if (v > 1) v = v / 10;
      const cut = (x) => String(Math.round(Number(x) * v * 1e6) / 1e6);
      pr.cells.in.value = cut(ref.cells.in.value);
      pr.cells.out.value = cut(ref.cells.out.value);
      pr.cells.cache.value = cut(ref.cells.cache.value);
      priceAuto = false;
      ratioCalc();
    });
    const ratioText = el('span', '', 'tb-rh-ratio-text');
    ratioRow.append(el('span', '按几折换算', 'tb-rh-field-label'), ratioIn, applyBtn, ratioText);
    mbody.append(ratioRow);

    /* 基线 */
    const baseLine = el('label', undefined, 'tb-rh-checkline');
    const baseIn = el('input');
    baseIn.type = 'checkbox';
    if (row && row.is_base) baseIn.checked = true;
    baseLine.append(baseIn, el('span', '设为该品牌基线（官方直连才勾，用来算延迟差）'));
    mbody.append(baseLine);

    const note = el('div', '参考价会按品牌+模型自动填，可以改。真实扣费以站点资金记录为准。', 'tb-rh-note');
    mbody.append(note);
    const err = el('div', '', 'tb-rh-modal-err');

    const foot = el('div', undefined, 'tb-rh-modal-foot');
    const cancel = rhBtn('取消', 'tb-ghost', () => finish());
    const okBtn = rhBtn(isNew ? '添加' : '保存', 'tb-primary', () => save());
    foot.append(cancel, okBtn);

    panel.append(mhead, mbody, err, foot);
    wrap.append(panel);
    wrap.addEventListener('click', (ev) => {
      if (ev.target === wrap) finish();
    });
    document.addEventListener('keydown', onKey);
    root.append(wrap);
    setTimeout(() => nameIn.focus(), 30);

    function finish() {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(ev) {
      if (ev.key === 'Escape') finish();
    }

    function syncRef(force) {
      const hit = modelList.find((m) => m.id === modelSel.value);
      if (hit && (refAuto || force)) {
        ref.set('in', hit.in);
        ref.set('out', hit.out);
        ref.set('cache', hit.cache);
        refAuto = true;
      }
      if (priceAuto) {
        pr.set('in', Number(ref.cells.in.value));
        pr.set('out', Number(ref.cells.out.value));
        pr.set('cache', Number(ref.cells.cache.value));
      }
      ratioCalc();
    }

    function ratioCalc() {
      const cost = (a, b, c) => Number(a || 0) + Number(b || 0) * 0.5 + Number(c || 0) * 0.1;
      const rc = cost(ref.cells.in.value, ref.cells.out.value, ref.cells.cache.value);
      const pc = cost(pr.cells.in.value, pr.cells.out.value, pr.cells.cache.value);
      if (!(rc > 0)) {
        ratioText.textContent = '先把官方参考价填上';
        return;
      }
      const r = pc / rc;
      ratioText.textContent =
        r >= 1.005
          ? '= ' + (r >= 10 ? r.toFixed(0) : r.toFixed(2)) + '× 官方价（贵 ' + Math.round((r - 1) * 100) + '%）'
          : '= ' + (r * 10).toFixed(2) + ' 折（官方价的 ' + (r * 100).toFixed(1) + '%）';
      ratioText.className = 'tb-rh-ratio-text' + (r > 1.02 ? ' bad' : r < 0.99 ? ' good' : '');
      if (!ratioIn.value) ratioIn.value = String((Math.round(r * 100) / 100).toFixed(2));
    }

    function fillModelOptions(pick) {
      if (pick) currentModel = pick;
      modelSel.replaceChildren();
      for (const m of modelList) {
        const o = el('option', m.id + (m.note ? ' · ' + m.note : ''));
        o.value = m.id;
        modelSel.append(o);
      }
      if (!modelList.some((m) => m.id === currentModel)) {
        currentModel = modelList.length ? modelList[0].id : '';
      }
      if (currentModel) modelSel.value = currentModel;
      syncRef(false);
    }

    function resetModels() {
      modelList = vendorModels(vendorKey);
      if (currentModel && !modelList.some((m) => m.id === currentModel)) {
        modelList = [{ id: currentModel, note: '当前保存的' }].concat(modelList);
      }
      if (!modelList.length) modelList = [{ id: currentModel || 'deepseek-v4.1-flash', note: '手填' }];
      fillModelOptions(modelList.some((m) => m.id === currentModel) ? currentModel : modelList[0].id);
    }

    vendorSel.addEventListener('change', () => {
      vendorKey = vendorSel.value;
      /* 换品牌等于换一套官方价，标价也按新品牌的参考价重来 */
      refAuto = true;
      priceAuto = true;
      currentModel = '';
      resetModels();
      syncRef(true);
    });
    modelSel.addEventListener('change', () => {
      currentModel = modelSel.value;
      syncRef(true);
    });

    async function onReadModels() {
      const base = urlIn.value.trim();
      const key = keyIn.value.trim();
      if (!base) {
        err.textContent = '先填 Base URL';
        return;
      }
      if (!key && !(row && row.api_key_masked)) {
        err.textContent = '新站要先填 API Key 才能读模型';
        return;
      }
      err.textContent = '';
      const old = readModelsBtn.textContent;
      readModelsBtn.disabled = true;
      readModelsBtn.textContent = '读取中…';
      const r = await rhPost(ctx, '/api/models/fetch', {
        api_base: base,
        api_key: key,
        target_id: row ? row.id : undefined,
      });
      readModelsBtn.disabled = false;
      readModelsBtn.textContent = old;
      if (!r.ok) {
        err.textContent = r.error || '读不到这个站的模型';
        return;
      }
      const list = (r.data.models || []).map((m) => ({ id: m.id, note: '站点' }));
      if (!list.length) {
        err.textContent = (r.data.notes || ['这个 key 一个模型都读不到']).join('；');
        return;
      }
      // 只列站点真的有的模型：站点没列的一律不显示
      modelList = list;
      const keep = list.some((m) => m.id === currentModel) ? currentModel : list[0].id;
      const changed = keep !== currentModel;
      fillModelOptions(keep);
      if (changed) syncRef(true);
      ratioCalc();
      err.textContent = '';
      note.textContent = '已从站点读到 ' + list.length + ' 个模型（只列这个 key 实际能调的，站点没有的不再显示）。';
      note.className = 'tb-rh-note good';
    }

    async function onReadPrices() {
      const base = urlIn.value.trim();
      if (!base) {
        err.textContent = '先填 Base URL';
        return;
      }
      err.textContent = '';
      const old = readPriceBtn.textContent;
      readPriceBtn.disabled = true;
      readPriceBtn.textContent = '读取中…';
      const r = await rhPost(ctx, '/api/targets/price-preview', {
        id: row ? row.id : undefined,
        base_url: base,
        model: modelSel.value,
        api_key: keyIn.value.trim(),
      });
      readPriceBtn.disabled = false;
      readPriceBtn.textContent = old;
      if (!r.ok) {
        err.textContent = r.error || '读不到站点牌价';
        return;
      }
      const listed = (r.data && r.data.listed) || {};
      const measured = (r.data && r.data.measured) || {};
      if (listed.ok) {
        pr.set('in', listed.in);
        pr.set('out', listed.out);
        pr.set('cache', listed.cache);
        pr.cells.in.value = String(listed.in);
        pr.cells.out.value = String(listed.out);
        pr.cells.cache.value = String(listed.cache);
        priceAuto = false;
        ratioCalc();
        note.textContent =
          '已按站点牌价填好' + (listed.group ? '（分组：' + listed.group + '）' : '') + '；这个价可以手改。';
        note.className = 'tb-rh-note good';
        return;
      }
      if (measured.in || measured.out) {
        pr.cells.in.value = String(measured.in || 0);
        pr.cells.out.value = String(measured.out || 0);
        ratioCalc();
        note.textContent = '站点没公开牌价，按最近账单实测单价填的（' + (measured.n || 0) + ' 条明细）。';
        note.className = 'tb-rh-note good';
        return;
      }
      err.textContent = (listed.notes || ['站点没公开价格接口，手填或用账单实测价']).join('；');
    }

    async function save() {
      err.textContent = '';
      const payload = {
        name: nameIn.value.trim(),
        base_url: urlIn.value.trim(),
        api_key: keyIn.value.trim(),
        vendor: vendorSel.value,
        model: modelSel.value,
        price_in: pr.cells.in.value,
        price_out: pr.cells.out.value,
        price_cache: pr.cells.cache.value,
        ref_in: ref.cells.in.value,
        ref_out: ref.cells.out.value,
        ref_cache: ref.cells.cache.value,
        is_base: baseIn.checked,
      };
      if (!payload.name || !payload.base_url) {
        err.textContent = '名称和 Base URL 必填';
        return;
      }
      okBtn.disabled = true;
      cancel.disabled = true;
      const old = okBtn.textContent;
      okBtn.textContent = '保存中…';
      if (!isNew) payload.id = row.id;
      const r = await rhPost(ctx, '/api/targets', payload);
      okBtn.disabled = false;
      cancel.disabled = false;
      okBtn.textContent = old;
      if (!r.ok) {
        err.textContent = r.error || '保存失败';
        return;
      }
      finish();
      await load();
      const saved = state.targets.find((t) => t.name === payload.name);
      if (saved) {
        state.sel = saved.id;
        render();
      }
    }

    resetModels();
    syncRef(false);
    ratioCalc();
  }

  async function removeTarget(row) {
    const yes = await rhConfirm(root, '删除「' + row.name + '」？', '测速记录和账单会一起删掉。', '删除');
    if (!yes) return;
    const r = await rhPost(ctx, '/api/targets/delete', { id: row.id });
    if (!r.ok) {
      await rhAlert(root, '删除失败', r.error || '服务没有给出原因');
      return;
    }
    state.checked.delete(row.id);
    load();
  }

  load();
}

/* ============================ 账单核对 ============================ */

const RH_SCRIPT_SYNC = [
  '(async () => {',
  '  /* 直连同步用：在站点后台（已登录）按 F12 → Console，整段粘贴回车。',
  '     用你当前的会话读 /api/log/self，把明细直接推回本机 RelayHub。 */',
  "  const HUBS = ['http://127.0.0.1:8770', 'http://localhost:8770'];",
  '  const DAYS = 7;',
  '  const H = {};',
  '  const log = (...a) => console.log("[RelayHub]", ...a);',
  '',
  '  /* 1) 先找前端存着的令牌（new-api 系） */',
  '  try {',
  '    for (let i = 0; i < localStorage.length; i++) {',
  '      const k = localStorage.key(i) || "";',
  '      const v = localStorage.getItem(k) || "";',
  '      if (k === "user") {',
  '        try { const u = JSON.parse(v); if (u && u.id) H["New-Api-User"] = String(u.id); } catch (e) {}',
  '      }',
  '      if (/^(access_?token|token|auth_token|jwt|user_token)$/i.test(k) && v.length > 16) {',
  '        H.Authorization = "Bearer " + v.replace(/^"|"$/g, "").replace(/^Bearer\\s+/i, "");',
  '      }',
  '    }',
  '  } catch (e) {}',
  '',
  '  /* 2) 没有就试着用 HttpOnly 的 session 换一个短期 access_token */',
  '  if (!H.Authorization) {',
  '    try {',
  '      const rf = await fetch("/api/user/auth/refresh", { method: "POST", credentials: "include" });',
  '      const rj = await rf.json();',
  '      const tk = rj && rj.data && (rj.data.access_token || rj.data.token);',
  '      if (tk) H.Authorization = "Bearer " + tk;',
  '    } catch (e) {}',
  '  }',
  '  log("令牌:", H.Authorization ? "有" : "没有（只靠 Cookie）");',
  '',
  '  /* 3) 站点参数与账号：用户 ID 有些站必须带 */',
  '  let qpu = null;',
  '  try {',
  '    const st = await fetch("/api/status", { credentials: "include" }).then((r) => r.json());',
  '    const sd = (st && st.data) || {};',
  '    qpu = sd.quota_per_unit || null;',
  '    if (sd.usd_exchange_rate) log("站点汇率:", sd.usd_exchange_rate);',
  '  } catch (e) {}',
  '  try {',
  '    const me = await fetch("/api/user/self", { headers: H, credentials: "include" }).then((r) => r.json());',
  '    const md = (me && me.data) || {};',
  '    if (md.id) H["New-Api-User"] = String(md.id);',
  '    log("账号:", md.username || "?", "· id =", md.id, "· 余额额度 =", md.quota);',
  '  } catch (e) {}',
  '',
  '  /* 4) 抓明细：data 是数组、或 data.items / records / list 都认 */',
  '  const pick = (o) => {',
  '    const d = o && o.data;',
  '    return Array.isArray(d) ? d : ((d && (d.items || d.records || d.list)) || []);',
  '  };',
  '  const keyOf = (it) => (it.id != null',
  '    ? "i" + it.id',
  '    : [it.created_at, it.model_name, it.prompt_tokens, it.completion_tokens, it.quota].join("|"));',
  '  const logs = [];',
  '  const seen = new Set();',
  '  let size = 100;',
  '  for (const sz of [2000, 1000, 500, 200]) {',
  '    try {',
  '      const t = await fetch("/api/log/self?page_size=" + sz, { headers: H, credentials: "include" }).then((r) => r.json());',
  '      if (pick(t).length >= 200) { size = sz; break; }',
  '      size = sz;',
  '    } catch (e) {}',
  '  }',
  '  for (let p = 0; p < 30; p++) {',
  '    let arr = [];',
  '    try {',
  '      const o = await fetch("/api/log/self?p=" + p + "&page_size=" + size, { headers: H, credentials: "include" }).then((r) => r.json());',
  '      arr = pick(o);',
  '    } catch (e) { break; }',
  '    if (!arr.length) break;',
  '    for (const it of arr) {',
  '      const k = keyOf(it);',
  '      if (seen.has(k)) continue;',
  '      seen.add(k);',
  '      logs.push(it);',
  '    }',
  '    log("第", p + 1, "页：累计", logs.length, "条");',
  '    if (arr.length < size) break;',
  '  }',
  '  if (!logs.length) { alert("一条明细都没读到：确认已登录、账号有调用记录，或改用「粘贴导入」。"); return; }',
  '',
  '  /* 5) 推回本机 */',
  '  const body = JSON.stringify({ host: location.hostname, logs: logs, quota_per_unit: qpu, days: DAYS });',
  '  for (const hub of HUBS) {',
  '    try {',
  '      const res = await fetch(hub + "/api/bill/ingest", {',
  '        method: "POST",',
  '        headers: { "Content-Type": "application/json" },',
  '        body: body,',
  '      }).then((r) => r.json());',
  '      if (res && res.ok) {',
  '        alert("已推送 " + logs.length + " 条到 RelayHub。回面板点「重新体检」即可。");',
  '        return;',
  '      }',
  '      log("推送失败:", res && res.error);',
  '    } catch (e) { log("连不上", hub); }',
  '  }',
  '  alert("推送失败：确认 RelayHub 服务在 127.0.0.1:8770 运行。");',
  '})();',
].join('\n');

const RH_SCRIPT_PASTE = [
  '(async () => {',
  '  /* 自研后台专用：读本页 localStorage 的登录令牌，重放站点自己的账单接口，',
  '     把响应原样复制到剪贴板。只在你自己的浏览器里跑，不发往第三方。 */',
  "  const KEYS = ['zz_token', 'token', 'access_token', 'auth_token', 'jwt', 'user_token', 'Authorization'];",
  '  let tk = "";',
  '  for (const k of KEYS) {',
  '    const v = localStorage.getItem(k);',
  '    if (v && v.length > 16) { tk = v.replace(/^Bearer\\s+/i, ""); break; }',
  '  }',
  '  if (!tk) {',
  '    for (const k of Object.keys(localStorage)) {',
  '      const v = localStorage.getItem(k);',
  '      if (typeof v === "string" && v.startsWith("ey") && v.length > 40) { tk = v; break; }',
  '    }',
  '  }',
  '  if (!tk) { alert("没在 localStorage 里找到登录令牌，请确认已登录这个站的后台，再执行一次。"); return; }',
  '  const H = { Authorization: "Bearer " + tk, "Content-Type": "application/json" };',
  '  const paths = ["/api/log/self?page_size=100", "/api/log?page_size=100", "/api/user/self"];',
  '  let got = null;',
  '  for (const p of paths) {',
  '    try {',
  '      const r = await fetch(p, { headers: H, credentials: "include" });',
  '      if (!r.ok) continue;',
  '      got = await r.json();',
  '      if (got) break;',
  '    } catch (e) {}',
  '  }',
  '  if (!got) { alert("这几个接口都没读到数据：F12 → Network 里找返回账单的请求，右键 Copy Response 也行。"); return; }',
  '  const text = JSON.stringify(got);',
  '  try {',
  '    await navigator.clipboard.writeText(text);',
  '  } catch (e) {',
  '    const ta = document.createElement("textarea");',
  '    ta.value = text;',
  '    document.body.append(ta);',
  '    ta.select();',
  '    document.execCommand("copy");',
  '    ta.remove();',
  '  }',
  '  alert("已复制 " + text.length + " 个字符。回面板 → 粘贴导入 → 粘贴（Ctrl+V）→ 解析导入。");',
  '})();',
].join('\n');

function mountBill(ctx) {
  const root = el('div', undefined, 'tb-root tb-rh');
  ctx.root.append(root);

  const head = el('div', undefined, 'tb-head');
  const titleWrap = el('div', undefined, 'tb-title-wrap');
  titleWrap.append(el('h2', '账单核对', 'tb-title'));
  titleWrap.append(el('span', '账单实扣 vs 标价 · 计量口径 · 缓存与模型分流', 'tb-source'));
  const tools = el('div', undefined, 'tb-tools');
  const auditBtn = rhBtn('重新体检', 'tb-ghost', () => loadBill(true));
  tools.append(auditBtn);
  head.append(titleWrap, tools);
  root.append(head);

  const layout = el('div', undefined, 'tb-rh-two');
  const aside = el('aside', undefined, 'tb-rh-aside');
  const main = el('div', undefined, 'tb-rh-main');
  layout.append(aside, main);
  root.append(layout);

  const state = {
    targets: [],
    sel: null,
    bill: null,
    err: '',
    loading: false,
    bills: new Map(),
    tab: 'sync',
    billFilter: 'all',
    probe: null,
    msg: '',
    msgTone: '',
    forms: {},
    billingAll: null,
    billingTimer: null,
  };

  async function load() {
    state.loading = true;
    const r = await rhGet(ctx, '/api/targets');
    if (!r.ok) {
      state.loading = false;
      state.err = r.error || '读不到目标列表';
      render();
      return;
    }
    state.targets = r.data || [];
    // 一次把每个站的账单读出来（左侧标「有账单」、默认落在有数据的站），顺便读计价设置
    const [bills, cfgR] = await Promise.all([
      Promise.all(state.targets.map((t) => rhGet(ctx, '/api/bill/' + t.id))),
      rhCall(ctx, 'getCfg', []),
    ]);
    if (cfgR && cfgR.ok && cfgR.cfg) state.billingAll = cfgR.cfg.billing || {};
    state.loading = false;
    state.bills = new Map();
    state.targets.forEach((t, i) => {
      if (bills[i] && bills[i].ok) state.bills.set(t.id, bills[i].data);
    });
    if (!state.sel) {
      const withBill = state.targets.find((t) => (state.bills.get(t.id) || {}).latest);
      state.sel = withBill ? withBill.id : state.targets.length ? state.targets[0].id : null;
    }
    if (!state.sel) {
      render();
      return;
    }
    const cached = state.bills.get(state.sel);
    if (cached && cached.latest) {
      state.bill = cached;
      state.err = '';
      render();
    } else {
      await loadBill();
    }
  }

  async function loadBill(force) {
    if (!state.sel) {
      state.bill = null;
      render();
      return;
    }
    if (force) auditBtn.disabled = true;
    const r = await rhGet(ctx, '/api/bill/' + state.sel);
    if (force) auditBtn.disabled = false;
    if (!r.ok) {
      state.err = r.error || '读不到账单';
      state.bill = null;
    } else {
      state.err = '';
      state.bill = r.data;
      state.bills.set(state.sel, r.data);
    }
    render();
  }

  function currentTarget() {
    return state.targets.find((t) => t.id === state.sel) || null;
  }

  function formFor(kind, t) {
    const f = state.forms[kind];
    if (f && f.tid === t.id) return f;
    const base = { tid: t.id };
    let next;
    if (kind === 'sync') {
      next = Object.assign(base, {
        api_base: t.base_url || '',
        token: '',
        cookie: '',
        user_id: '',
        days: 7,
      });
    } else if (kind === 'paste') {
      next = Object.assign(base, { json: '', unit: 'auto' });
    } else {
      next = Object.assign(base, {
        requests: '',
        amount: '',
        rate: 1,
        tin: '',
        tout: '',
        tcache: '',
        note: '',
      });
    }
    state.forms[kind] = next;
    return next;
  }

  function billingOf(t) {
    const key = String(t.id);
    if (!state.billingAll) state.billingAll = {};
    let b = state.billingAll[key];
    if (!b || typeof b !== 'object') {
      b = { mode: 'topup', topupCny: 1, topupQuota: 1, pkgCny: 0, pkgMonths: 1, pkgQuota: 0 };
      state.billingAll[key] = b;
    }
    const n = (v, d) => {
      const x = Number(v);
      return Number.isFinite(x) && x >= 0 ? x : d;
    };
    b.mode = b.mode === 'package' ? 'package' : 'topup';
    b.topupCny = n(b.topupCny, 1);
    b.topupQuota = n(b.topupQuota, 1) || 1;
    b.pkgCny = n(b.pkgCny, 0);
    b.pkgMonths = n(b.pkgMonths, 1) || 1;
    b.pkgQuota = n(b.pkgQuota, 0);
    return b;
  }

  /** 两种买法的单价（元 / 额度）与当前选中的那一种。 */
  function billingRates(b) {
    const topup = b.topupCny > 0 && b.topupQuota > 0 ? b.topupCny / b.topupQuota : null;
    const pkg =
      b.pkgCny > 0 && b.pkgMonths > 0 && b.pkgQuota > 0 ? b.pkgCny / (b.pkgMonths * b.pkgQuota) : null;
    return { topup, pkg, rate: b.mode === 'package' ? pkg : topup };
  }

  function saveBilling(t, b) {
    state.billingAll = Object.assign({}, state.billingAll || {}, { [String(t.id)]: b });
    if (state.billingTimer) clearTimeout(state.billingTimer);
    state.billingTimer = setTimeout(async () => {
      const r = await rhCall(ctx, 'saveCfg', [{ billing: state.billingAll }]);
      if (r && r.ok && r.cfg) state.billingAll = r.cfg.billing || state.billingAll;
    }, 450);
  }

  function render() {
    aside.replaceChildren();
    main.replaceChildren();
    if (state.err && !state.targets.length) {
      main.append(offlineCard(state.err));
      return;
    }
    aside.append(el('div', '中转站', 'tb-rh-aside-title'));
    if (!state.targets.length) {
      aside.append(el('div', '还没有目标。到「测速对照」页添加一个。', 'tb-rh-sub'));
    }

    /* 侧栏也按模型品牌分组 */
    const counts = new Map();
    for (const t of state.targets) {
      const k = t.vendor || 'other';
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    if (state.billFilter !== 'all' && !counts.has(state.billFilter)) state.billFilter = 'all';
    if (state.targets.length) {
      const chips = el('div', undefined, 'tb-rh-chips tb-rh-chips-aside');
      const mkChip = (key, label, n) =>
        rhBtn(label + ' ' + n, 'tb-rh-chip' + (state.billFilter === key ? ' on' : ''), () => {
          state.billFilter = key;
          render();
        });
      chips.append(mkChip('all', '全部', state.targets.length));
      for (const [k, n] of counts) {
        const one = state.targets.find((x) => (x.vendor || 'other') === k);
        chips.append(mkChip(k, (one && one.vendor_name) || k, n));
      }
      aside.append(chips);
    }

    for (const [k, n] of counts) {
      if (state.billFilter !== 'all' && state.billFilter !== k) continue;
      const list = state.targets.filter((t) => (t.vendor || 'other') === k);
      const gh = el('div', undefined, 'tb-rh-aside-group');
      gh.append(el('span', (list[0] && list[0].vendor_name) || k, 'tb-rh-group-name'));
      gh.append(el('span', n + ' 个', 'tb-rh-sub'));
      aside.append(gh);
      for (const t of list) {
        const item = el('button', undefined, 'tb-rh-pick' + (t.id === state.sel ? ' on' : ''));
        item.type = 'button';
        const nameRow = el('div', undefined, 'tb-rh-name-line');
        nameRow.append(el('span', t.name, 'tb-rh-pick-name'));
        const b = state.bills.get(t.id);
        if (b && b.latest) nameRow.append(rhTag('有账单', 'green'));
        item.append(nameRow);
        const meta = el('div', undefined, 'tb-rh-sub');
        meta.textContent = (t.vendor_name ? t.vendor_name + ' · ' : '') + (t.model || '');
        item.append(meta);
        item.addEventListener('click', () => {
          state.sel = t.id;
          state.bill = null;
          state.probe = null;
          state.msg = '';
          state.msgTone = '';
          render();
          loadBill();
        });
        aside.append(item);
      }
    }

    const t = currentTarget();
    if (!t) {
      main.append(rhEmpty('先在左边选一个中转站'));
      return;
    }

    main.append(renderBilling(t));
    main.append(renderFetch(t));

    const bill = state.bill;
    const latest = bill && bill.latest;
    if (!latest) {
      const box = el('div', undefined, 'tb-rh-offline');
      box.append(el('div', '这个站还没有账单', 'tb-rh-offline-title'));
      box.append(
        el(
          'div',
          '上面三个办法任选一个：直连同步（能连上站点后台最省事）、粘贴导入（浏览器能开、本机命令行连不上时用）、手填汇总（后台首页那几个大数字抄进来）。拿到账单后这里会逐项说明：单价对不对、缓存有没有真省钱、有没有偷偷换模型、账单自己能不能对上。',
          'tb-rh-offline-sub'
        )
      );
      if (state.err) box.append(el('div', state.err, 'tb-rh-offline-err'));
      main.append(box);
      if (bill && bill.history && bill.history.length) main.append(renderHistory(bill));
      return;
    }

    main.append(renderReport(t, bill));
    main.append(renderCards(bill));
    main.append(renderModels(t, latest));
    if (latest.notes && latest.notes.length) {
      const { sec, body: sb } = rhSection('账单自己的备注');
      for (const n of latest.notes) sb.append(el('div', n, 'tb-rh-note'));
      main.append(sec);
    }
    main.append(renderHistory(bill));
  }

  /* -------- 额度怎么买（计价基准，放最上面） -------- */

  function renderBilling(t) {
    const { sec, body: sb, head: sh } = rhSection(
      '额度怎么买（计价基准）',
      '先定这个：账单金额换算、站点之间的划算比较都按它算'
    );
    sec.classList.add('tb-bill-billing');
    const b = billingOf(t);

    const modes = el('div', undefined, 'tb-bill-modes');
    const mkMode = (key, name, sub) => {
      const btn = el('button', undefined, 'tb-bill-mode' + (b.mode === key ? ' on' : ''));
      btn.type = 'button';
      btn.append(el('b', name), el('span', sub, 'tb-bill-mode-sub'));
      btn.addEventListener('click', () => {
        b.mode = key;
        saveBilling(t, b);
        render();
      });
      return btn;
    };
    modes.append(mkMode('topup', '直充额度', '人民币充值换额度'), mkMode('package', '套餐', '按月订阅固定额度'));
    sh.append(el('span', undefined, 'tb-rh-spacer'), modes);

    const price = el('div', undefined, 'tb-bill-price');
    const rowTop = el('div', undefined, 'tb-bill-prow' + (b.mode === 'topup' ? ' on' : ''));
    const cnyIn = rhInput({ type: 'number', step: '0.01', min: 0, value: b.topupCny, width: '92px' });
    const quotaIn = rhInput({ type: 'number', step: '1', min: 0, value: b.topupQuota, width: '120px' });
    const topRate = el('span', '', 'tb-bill-prow-rate');
    rowTop.append(
      el('span', '直充', 'tb-bill-prow-k'),
      el('span', '人民币'),
      cnyIn,
      el('span', '元，买'),
      quotaIn,
      el('span', '额度'),
      topRate
    );
    cnyIn.addEventListener('input', () => {
      b.topupCny = Number(cnyIn.value) || 0;
      saveBilling(t, b);
      refresh();
    });
    quotaIn.addEventListener('input', () => {
      b.topupQuota = Number(quotaIn.value) || 0;
      saveBilling(t, b);
      refresh();
    });

    const rowPkg = el('div', undefined, 'tb-bill-prow' + (b.mode === 'package' ? ' on' : ''));
    const pkgCnyIn = rhInput({ type: 'number', step: '0.01', min: 0, value: b.pkgCny, width: '92px' });
    const pkgMonIn = rhInput({ type: 'number', step: '1', min: 0, value: b.pkgMonths, width: '62px' });
    const pkgQuotaIn = rhInput({ type: 'number', step: '1', min: 0, value: b.pkgQuota, width: '128px' });
    const pkgRate = el('span', '', 'tb-bill-prow-rate');
    rowPkg.append(
      el('span', '套餐', 'tb-bill-prow-k'),
      el('span', '套餐价'),
      pkgCnyIn,
      el('span', '元 /'),
      pkgMonIn,
      el('span', '个月，每期给'),
      pkgQuotaIn,
      el('span', '额度'),
      pkgRate
    );
    const bindPkg = (inp, key) =>
      inp.addEventListener('input', () => {
        b[key] = Number(inp.value) || 0;
        saveBilling(t, b);
        refresh();
      });
    bindPkg(pkgCnyIn, 'pkgCny');
    bindPkg(pkgMonIn, 'pkgMonths');
    bindPkg(pkgQuotaIn, 'pkgQuota');

    const cmp = el('div', undefined, 'tb-bill-cmp');
    price.append(rowTop, rowPkg, cmp);
    sb.append(price);

    function refresh() {
      const rates = billingRates(b);
      topRate.textContent = rates.topup ? '→ 1 额度 ≈ ' + rhRate(rates.topup) : '→ 填完才算';
      pkgRate.textContent = rates.pkg ? '→ 1 额度 ≈ ' + rhRate(rates.pkg) : '→ 填完才算';
      if (rates.topup && rates.pkg) {
        const a = rates.topup * 10000;
        const c = rates.pkg * 10000;
        const diff = Math.abs(a - c) / Math.max(a, c);
        const cheap = a <= c ? '直充' : '套餐';
        cmp.className = 'tb-bill-cmp good';
        cmp.textContent =
          '每 1 万额度：直充 ' +
          rhRate(a) +
          ' · 套餐 ' +
          rhRate(c) +
          ' → ' +
          cheap +
          '更划算，便宜 ' +
          (diff * 100 >= 99.9
            ? (diff * 100).toFixed(4)
            : diff * 100 >= 10
            ? (diff * 100).toFixed(1)
            : (diff * 100).toFixed(2)) +
          '%';
      } else if (rates.topup || rates.pkg) {
        cmp.className = 'tb-bill-cmp';
        cmp.textContent =
          '只填了一种：' +
          (rates.topup ? '直充 ' : '套餐 ') +
          rhRate(rates.topup || rates.pkg) +
          ' / 额度。补上另一种就能比哪个划算。';
      } else {
        cmp.className = 'tb-bill-cmp';
        cmp.textContent = '直充和套餐都填上，这里会自动算哪个更划算。';
      }
    }
    refresh();
    return sec;
  }

  /* -------- 获取账单（三个入口） -------- */

  function renderFetch(t) {
    const { sec, body: sb, head: sh } = rhSection('获取账单', t.name + ' · ' + (t.model || ''));
    const tabs = el('div', undefined, 'tb-tabs');
    for (const def of [
      ['sync', '直连同步'],
      ['paste', '粘贴导入'],
      ['manual', '手填汇总'],
    ]) {
      tabs.append(
        rhBtn(def[1], 'tb-tab' + (state.tab === def[0] ? ' on' : ''), () => {
          state.tab = def[0];
          state.msg = '';
          state.msgTone = '';
          render();
        })
      );
    }
    sh.append(el('span', undefined, 'tb-rh-spacer'), tabs);
    if (state.tab === 'sync') renderSync(t, sb);
    else if (state.tab === 'paste') renderPaste(t, sb);
    else renderManual(t, sb);
    if (state.msg) sb.append(el('div', state.msg, 'tb-rh-msg ' + (state.msgTone || '')));
    return sec;
  }

  function renderSync(t, sb) {
    const f = formFor('sync', t);

    const r1 = el('div', undefined, 'tb-rh-form');
    const baseIn = rhInput({ value: f.api_base, placeholder: 'https://xxx.com/v1' });
    baseIn.classList.add('tb-rh-grow');
    baseIn.addEventListener('input', () => {
      f.api_base = baseIn.value;
    });
    const baseBox = rhFieldBox('站点根地址', baseIn);
    baseBox.classList.add('tb-rh-grow');

    const daysSel = rhSelect(
      [
        { value: 1, label: '最近 1 天' },
        { value: 3, label: '最近 3 天' },
        { value: 7, label: '最近 7 天' },
        { value: 30, label: '最近 30 天' },
      ],
      f.days || 7
    );
    daysSel.style.width = '128px';
    daysSel.addEventListener('change', () => {
      f.days = Number(daysSel.value) || 7;
    });

    const probeBtn = rhBtn('探测', 'tb-ghost', async () => {
      const base = f.api_base.trim();
      if (!base) {
        state.msg = '先填站点根地址';
        state.msgTone = 'bad';
        render();
        return;
      }
      probeBtn.disabled = true;
      probeBtn.textContent = '探测中…';
      const r = await rhPost(ctx, '/api/bill/probe', { api_base: base });
      probeBtn.disabled = false;
      probeBtn.textContent = '探测';
      if (!r.ok) {
        state.msg = r.error || '探测失败';
        state.msgTone = 'bad';
      } else {
        state.probe = r.data;
        state.msg = '识别为：' + (r.data.kind || '未知') + ((r.data.notes || []).length ? ' · ' + r.data.notes[0] : '');
        state.msgTone = 'good';
      }
      render();
    });

    const syncBtn = rhBtn('同步账单', 'tb-primary', async () => {
      const base = f.api_base.trim();
      if (!base) {
        state.msg = '先填站点根地址';
        state.msgTone = 'bad';
        render();
        return;
      }
      if (!f.token.trim() && !f.cookie.trim()) {
        state.msg = '令牌和 Cookie 至少填一个（都要登录才能读账单）';
        state.msgTone = 'bad';
        render();
        return;
      }
      syncBtn.disabled = true;
      syncBtn.textContent = '同步中…';
      const r = await rhPost(ctx, '/api/bill/sync', {
        target_id: t.id,
        api_base: base,
        token: f.token.trim(),
        cookie: f.cookie.trim(),
        user_id: f.user_id.trim(),
        days: Number(f.days) || 7,
        rate_mode: 'one',
      });
      syncBtn.disabled = false;
      syncBtn.textContent = '同步账单';
      if (!r.ok) {
        state.msg = r.error || '同步失败';
        state.msgTone = 'bad';
      } else {
        state.bill = r.data;
        state.bills.set(t.id, r.data);
        const tot = (r.data.latest && r.data.latest.totals) || {};
        state.msg = '同步完成：' + (tot.requests || 0) + ' 条记录 · ' + rhMoney(tot.cost) + '。';
        state.msgTone = 'good';
      }
      render();
    });

    r1.append(baseBox, rhFieldBox('拉最近', daysSel), probeBtn, syncBtn);
    sb.append(r1);

    const r2 = el('div', undefined, 'tb-rh-form');
    const tokenIn = rhInput({ value: f.token, placeholder: '控制台里的访问令牌（不是 sk- 开头的调用密钥）' });
    tokenIn.addEventListener('input', () => {
      f.token = tokenIn.value;
    });
    const tokenBox = rhFieldBox('后台访问令牌', tokenIn);
    tokenBox.classList.add('tb-rh-grow');
    const uidIn = rhInput({ value: f.user_id, placeholder: '多数站可以留空', width: '150px' });
    uidIn.addEventListener('input', () => {
      f.user_id = uidIn.value;
    });
    r2.append(tokenBox, rhFieldBox('用户 ID（可选）', uidIn));
    sb.append(r2);

    const cookieIn = el('textarea', undefined, 'tb-rh-input tb-rh-textarea');
    cookieIn.rows = 2;
    cookieIn.value = f.cookie;
    cookieIn.placeholder = 'session=... 或整段 cURL（F12 → 网络 → 右键请求 → 复制 → 以 cURL 粘贴）';
    cookieIn.addEventListener('input', () => {
      f.cookie = cookieIn.value;
    });
    sb.append(rhFieldBox('或整段 Cookie / cURL（和令牌二选一）', cookieIn));

    if (state.probe) {
      const p = el('div', undefined, 'tb-rh-probe');
      p.append(rhTag('识别为 ' + (state.probe.kind || '未知'), 'blue'));
      for (const n of state.probe.notes || []) p.append(el('div', n, 'tb-rh-sub'));
      sb.append(p);
    }

    sb.append(
      el(
        'div',
        '多数站是 one-api / new-api 换皮：先「探测」确认站点类型，再「同步」。令牌在 F12 → Application → Local Storage → user → access_token（长串随机 / JWT），同一段里的 id 就是用户 ID。',
        'tb-rh-note'
      )
    );
    const hint = el('details', undefined, 'tb-rh-hintbox');
    hint.append(el('summary', '找不到令牌？点开看（new-api / 改版站 / cURL 复制）'));
    const tips = [
      '多数站是 one-api / new-api 换皮，这套接口通用：先「探测」确认，再「同步」。',
      'new-api 系的令牌在 F12 → Application → Local Storage → user 里的 access_token（长串随机 / JWT），同一段里的 id 就是用户 ID。OpenSlate 这类自研控制台是 zz_token，用户 ID 留空即可。',
      '改版 new-api（报 AUTH_UNAUTHORIZED 的那类）不再从前端存令牌，只发一个 HttpOnly 的 session Cookie，账号接口认的是它能换出来的短期 access_token。这种站把 session=... 那一段粘进上面的 Cookie 框，同步时会自动拿它换 token；只粘 nsrdid / sidebar_state / new_api_has_session 这些没用（那是界面 cookie）。',
      '找不到就最省事的一招：F12 → 网络 → 右键任意一条 /api/ 请求 → 复制 → 以 cURL (bash) 格式复制，把整段粘进上面的 Cookie 框（令牌框也行），里面的 Cookie、Authorization 会原样照搬。',
      '连不上站点 / 懒得翻 Cookie？用下面那块「复制脚本」：到站点控制台（F12 → Console）粘贴运行，账单会直接推回来。',
    ];
    for (const tip of tips) hint.append(el('p', tip));
    sb.append(hint);
    sb.append(syncScriptBlock());
  }

  function renderPaste(t, sb) {
    const f = formFor('paste', t);
    const ta = el('textarea', undefined, 'tb-rh-input tb-rh-textarea tb-rh-pastebox');
    ta.rows = 9;
    ta.value = f.json;
    ta.placeholder =
      '把后台接口返回的 JSON 贴进来，三种都认：\n\n1) one-api 的 {"data":{"items":[...]}} 或 {"data":[...]}\n2) 任意含 model / prompt_tokens / completion_tokens / cost 的明细数组\n3) 只有汇总的 {"total_requests":360,"total_cost":0.33721,"total_tokens":4300000}';
    ta.addEventListener('input', () => {
      f.json = ta.value;
    });
    ta.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      ta.classList.add('over');
    });
    ta.addEventListener('dragleave', () => ta.classList.remove('over'));
    ta.addEventListener('drop', (ev) => {
      ev.preventDefault();
      ta.classList.remove('over');
      const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        f.json = String(reader.result || '');
        ta.value = f.json;
      };
      reader.readAsText(file);
    });
    sb.append(ta);

    const row = el('div', undefined, 'tb-rh-form');
    const unitSel = rhSelect(
      [
        { value: 'auto', label: '自动判断' },
        { value: 'cny', label: '人民币（元）' },
        { value: 'quota', label: '站点内部额度' },
      ],
      f.unit
    );
    unitSel.style.width = '160px';
    unitSel.addEventListener('change', () => {
      f.unit = unitSel.value;
    });
    const unitBox = rhFieldBox('金额那一列是什么', unitSel);

    const clipBtn = rhBtn('从剪贴板粘贴', 'tb-ghost', async () => {
      try {
        const txt = await navigator.clipboard.readText();
        if (!txt || !txt.trim()) throw new Error('剪贴板是空的');
        f.json = txt;
        ta.value = txt;
        state.msg = '已从剪贴板读取 ' + txt.length + ' 个字符，点「解析导入」。';
        state.msgTone = 'good';
      } catch (e) {
        state.msg = '读不到剪贴板（' + String((e && e.message) || e) + '）：点一下上面的输入框，按 Ctrl+V 粘进去也一样。';
        state.msgTone = '';
      }
      render();
    });

    const fileIn = el('input');
    fileIn.type = 'file';
    fileIn.accept = '.json,.txt,application/json';
    fileIn.style.display = 'none';
    fileIn.addEventListener('change', () => {
      const file = fileIn.files && fileIn.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        f.json = String(reader.result || '');
        ta.value = f.json;
        state.msg = '已读取「' + file.name + '」，点「解析导入」。';
        state.msgTone = 'good';
        render();
      };
      reader.readAsText(file);
    });
    const fileBtn = rhBtn('选文件', 'tb-ghost', () => fileIn.click());

    const capBtn = rhBtn('采集脚本', 'tb-ghost', () => openScriptModal());

    const pasteBtn = rhBtn('解析导入', 'tb-primary', async () => {
      if (!f.json.trim()) {
        state.msg = '先把 JSON 贴进来';
        state.msgTone = 'bad';
        render();
        return;
      }
      pasteBtn.disabled = true;
      pasteBtn.textContent = '解析中…';
      const r = await rhPost(ctx, '/api/bill/paste', {
        target_id: t.id,
        json: f.json,
        cost_unit: f.unit,
      });
      pasteBtn.disabled = false;
      pasteBtn.textContent = '解析导入';
      if (!r.ok) {
        state.msg = r.error || '导入失败';
        state.msgTone = 'bad';
      } else {
        state.bill = r.data;
        state.bills.set(t.id, r.data);
        const tot = (r.data.latest && r.data.latest.totals) || {};
        state.msg = '导入完成：' + (tot.requests || 0) + ' 条记录 · ' + rhMoney(tot.cost) + '。';
        state.msgTone = 'good';
      }
      render();
    });

    row.append(unitBox, clipBtn, fileBtn, capBtn, pasteBtn, fileIn);
    sb.append(row);
    sb.append(
      el(
        'div',
        '三种喂法都行：「从剪贴板粘贴」（控制台脚本复制出来的数据，粘一下就好）、「选文件」或直接把文件拖进上面的大框、或手动 Ctrl+V 粘 JSON。金额大得离谱（上万块）说明那列是站点内部额度，把「金额那一列」改成「站点内部额度」再解析。',
        'tb-rh-note'
      )
    );

  }

  /* 粘贴导入用的采集脚本：弹窗，三步 + 脚本 + 复制 */
  function openScriptModal() {
    const wrap = el('div', undefined, 'tb-rh-mask');
    const panel = el('div', undefined, 'tb-rh-modal tb-rh-modal-wide');
    const head = el('div', undefined, 'tb-rh-modal-head');
    const titles = el('div');
    titles.append(el('div', '采集脚本 · 自研后台专用', 'tb-rh-modal-title'));
    titles.append(el('div', '三步拿到账单；脚本只在你自己的浏览器里跑', 'tb-rh-modal-sub'));
    const xBtn = rhBtn('×', 'tb-rh-x', close);
    head.append(titles, xBtn);

    const body = el('div', undefined, 'tb-rh-modal-body');
    const steps = el('ol', undefined, 'tb-rh-steps');
    for (const text of [
      '在中转站后台登录，点开「用量 / 账单 / 日志」页面，等数据加载出来。',
      '按 F12 → 切到 Console，整段粘贴下面的脚本，回车。',
      '看到「已复制」后回到这里，点「从剪贴板粘贴」→「解析导入」。',
    ]) {
      steps.append(el('li', text));
    }
    body.append(steps);
    const pre = el('pre', RH_SCRIPT_PASTE, 'tb-script');
    pre.tabIndex = 0;
    body.append(pre);
    body.append(
      el(
        'div',
        '脚本只在你自己的浏览器里跑：读本页 localStorage 里的登录令牌，重放这个站点自己的接口，把响应原样抓下来。不发往任何第三方，也不改你后台任何数据。',
        'tb-rh-note'
      )
    );

    const foot = el('div', undefined, 'tb-rh-modal-foot');
    const closeBtn = rhBtn('关闭', 'tb-ghost', close);
    const copyBtn = rhBtn('复制脚本', 'tb-primary', () => copyScript(copyBtn, RH_SCRIPT_PASTE));
    foot.append(closeBtn, copyBtn);
    panel.append(head, body, foot);
    wrap.append(panel);
    wrap.addEventListener('click', (ev) => {
      if (ev.target === wrap) close();
    });
    document.addEventListener('keydown', onKey);
    root.append(wrap);

    function close() {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(ev) {
      if (ev.key === 'Escape') close();
    }
  }

  /* 直连同步用的采集脚本：内联展开，脚本较长所以放在可滚动的代码块里 */
  function syncScriptBlock() {
    const det = el('details', undefined, 'tb-rh-hintbox tb-rh-collector');
    det.append(el('summary', '连不上站点 / 懒得翻 Cookie？在站点控制台粘一段脚本，账单直接推回来'));
    const cbody = el('div', undefined, 'tb-rh-collector-body');
    const steps = el('ol', undefined, 'tb-rh-steps');
    for (const text of [
      '在中转站后台登录，点开「用量 / 账单 / 日志」页面。',
      '按 F12 → Console，复制下面整段粘贴回车。它会读 /api/log/self 并直接推回本机。',
      '看到「已推送 N 条」后回面板，点「重新体检」。',
    ]) {
      steps.append(el('li', text));
    }
    cbody.append(steps);
    const pre = el('pre', RH_SCRIPT_SYNC, 'tb-script');
    pre.tabIndex = 0;
    cbody.append(pre);
    const copyBtn = rhBtn('复制脚本', 'tb-primary tb-rh-mini', () => copyScript(copyBtn, RH_SCRIPT_SYNC));
    cbody.append(copyBtn);
    det.append(cbody);
    return det;
  }

  async function copyScript(btn, text) {
    const old = btn.textContent;
    try {
      await rhCopy(text || RH_SCRIPT_PASTE);
      btn.textContent = '已复制 ✓';
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = old;
        btn.disabled = false;
      }, 1600);
    } catch (e) {
      btn.textContent = '复制失败：' + String((e && e.message) || e);
      setTimeout(() => {
        btn.textContent = old;
      }, 2600);
    }
  }

  function renderManual(t, sb) {
    const f = formFor('manual', t);
    const b = billingOf(t);

    const gridTop = el('div', undefined, 'tb-rh-form-grid tb-cols2');
    const gridTok = el('div', undefined, 'tb-rh-form-grid tb-cols3');
    let host = gridTop;
    const mk = (label, key, opts, hint) => {
      const inp = rhInput(
        Object.assign(
          { value: f[key] == null ? '' : f[key], placeholder: opts && opts.placeholder },
          opts || {}
        )
      );
      inp.addEventListener('input', () => {
        f[key] = inp.value;
        if (key === 'amount') refresh();
      });
      host.append(rhFieldBox(label, inp, hint));
      return inp;
    };

    mk('请求数', 'requests', { type: 'number', min: 0 });
    const amountIn = mk(
      '站点金额（站点显示的数）',
      'amount',
      { type: 'number', step: '0.000001', min: 0 },
      '照抄后台首页的消费金额，单位按站点（$ / 货币 / TCredits / 额度都行）'
    );
    sb.append(gridTop);
    host = gridTok;
    mk('输入 token', 'tin', { type: 'number', min: 0 });
    mk('输出 token', 'tout', { type: 'number', min: 0 });
    mk('缓存命中 token', 'tcache', { type: 'number', min: 0 }, '账单里「缓存 / 命中」那一列；没有就留空');
    sb.append(gridTok);

    /* 计价基准在页面最上面设置，这里只读 */
    const rateLine = el('div', undefined, 'tb-bill-pricehint');
    const rateText = el('span', '', 'tb-bill-pricehint-t');
    rateLine.append(el('span', '计价方式：', 'tb-rh-field-label'), rateText);
    rateLine.append(
      rhBtn('去设置', 'tb-rh-link', () => {
        const node = main.querySelector('.tb-bill-billing');
        if (node && node.scrollIntoView) node.scrollIntoView({ block: 'start', behavior: 'smooth' });
      })
    );
    sb.append(rateLine);

    const conv = el('div', undefined, 'tb-rh-conv');
    const convVal = el('b', '', 'tb-rh-conv-v');
    const convHint = el('span', '', 'tb-rh-conv-hint');
    conv.append(el('span', '折算成人民币：', 'tb-rh-field-label'), convVal, convHint);
    sb.append(conv);

    function refresh() {
      const rates = billingRates(billingOf(t));
      rateText.textContent = rates.rate
        ? (b.mode === 'package' ? '套餐' : '直充') + ' · 1 额度 ≈ ' + rhRate(rates.rate)
        : '还没填，先去上面「额度怎么买」设置';
      const amt = Number(amountIn.value) || 0;
      if (rates.rate) {
        convVal.textContent = rhMoney(amt * rates.rate);
        convHint.textContent = amt
          ? '  ' +
            trimNum(amt) +
            ' 额度 × ' +
            rhRate(rates.rate) +
            '（' +
            (b.mode === 'package' ? '套餐价' : '直充价') +
            '）'
          : '';
      } else {
        convVal.textContent = '—';
        convHint.textContent = ' 先在上面设置计价方式';
      }
    }
    refresh();

    const noteIn = rhInput({ value: f.note, placeholder: '如：后台首页 11-02 的累计数字' });
    noteIn.addEventListener('input', () => {
      f.note = noteIn.value;
    });
    sb.append(rhFieldBox('备注（可选）', noteIn));

    const row = el('div', undefined, 'tb-rh-row');
    const saveBtn = rhBtn('保存', 'tb-primary', async () => {
      const rates = billingRates(billingOf(t));
      const amt = Number(f.amount) || 0;
      const rate = rates.rate || 0;
      const cost = amt * rate;
      if (amt > 0 && !rate) {
        state.msg = '先在页面顶部「额度怎么买」里把计价方式填完，才能把站点金额换成人民币';
        state.msgTone = 'bad';
        render();
        return;
      }
      if (!Number(f.requests || 0) && !cost) {
        state.msg = '请求数和消费金额至少填一个';
        state.msgTone = 'bad';
        render();
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中…';
      const note = [
        '站点金额 ' +
          amt +
          ' × ' +
          rhRate(rate) +
          ' = ' +
          rhMoney(cost) +
          '（' +
          (b.mode === 'package' ? '套餐' : '直充') +
          '）',
        f.note,
      ]
        .filter(Boolean)
        .join(' · ');
      const r = await rhPost(ctx, '/api/bill/manual', {
        target_id: t.id,
        requests: f.requests,
        cost: cost,
        tin: f.tin,
        tout: f.tout,
        tcache: f.tcache,
        note: note,
      });
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
      if (!r.ok) {
        state.msg = r.error || '保存失败';
        state.msgTone = 'bad';
      } else {
        state.bill = r.data;
        state.bills.set(t.id, r.data);
        state.msg = '已保存：' + (f.requests || 0) + ' 次 · ' + rhMoney(cost) + '。';
        state.msgTone = 'good';
      }
      render();
    });
    row.append(saveBtn);
    sb.append(row);
    sb.append(
      el(
        'div',
        '只填后台首页那几个大数字也行，体检里能做的检查会少一些。缓存命中填了才能算「缓存真的省到钱没有」。',
        'tb-rh-note'
      )
    );
  }

  /* -------- 报告 / 概览 / 模型 / 历史 -------- */

  function renderReport(t, bill) {
    const a = bill.audit || {};
    const { sec, body: sb, head: sh } = rhSection('体检报告', '按当前账单 + 最近一次测速现算，换数据后点「重新体检」');
    const src = RH_SOURCE[(bill.latest || {}).source] || (bill.latest || {}).source || '';
    sh.append(el('span', rhTime((bill.latest || {}).taken_at) + ' · ' + src, 'tb-rh-sec-sub'));

    const score = el('div', undefined, 'tb-rh-score ' + (a.level || 'skip'));
    score.append(el('div', a.score == null ? '—' : String(a.score), 'tb-rh-score-n'));
    const txt = el('div', undefined, 'tb-rh-score-txt');
    txt.append(el('b', a.headline || '没有结论'));
    if (a.sub) txt.append(el('span', a.sub));
    score.append(txt);
    if (a.total_checks) score.append(rhTag('跑通 ' + (a.ran || 0) + '/' + a.total_checks + ' 项', 'gray'));
    sb.append(score);

    for (const c of a.checks || []) {
      const row = el('div', undefined, 'tb-rh-chk ' + (RH_LEVEL[c.level] || 'skip'));
      row.append(el('i', undefined, 'tb-rh-chk-dot'));
      row.append(el('div', c.title, 'tb-rh-chk-t'));
      const d = el('div');
      d.append(el('div', c.detail || '', 'tb-rh-chk-d'));
      if (c.hint) d.append(el('div', c.hint, 'tb-rh-chk-h'));
      row.append(d);
      sb.append(row);
    }
    return sec;
  }

  function renderCards(bill) {
    const latest = bill.latest || {};
    const tot = latest.totals || {};
    const a = bill.audit || {};
    const cost = a.cost || {};
    const sum = (Number(tot.in) || 0) + (Number(tot.out) || 0);
    const blended = sum > 0 && tot.cost > 0 ? (tot.cost / sum) * 1e6 : null;
    const cacheRate = tot.in > 0 ? (Number(tot.cache) || 0) / tot.in : null;
    const zhe = cost.official > 0 && cost.actual > 0 ? cost.actual / cost.official : null;

    const { sec, body: sb } = rhSection('账单概览');
    const grid = el('div', undefined, 'tb-rh-cards');
    const add = (k, v, tone, small) => {
      const c = el('div', undefined, 'tb-rh-card');
      c.append(el('div', k, 'tb-rh-card-k'));
      const val = el('div', undefined, 'tb-rh-card-v' + (tone ? ' ' + tone : ''));
      val.append(document.createTextNode(v));
      if (small) val.append(el('small', small));
      c.append(val);
      grid.append(c);
    };
    add('账单请求数', rhNum(tot.requests), '', ' 次');
    add('站点记的消费', rhMoney(tot.cost));
    add('综合单价', blended == null ? '—' : '¥' + blended.toFixed(3), '', blended == null ? '' : ' /M tok');
    add('缓存命中率', cacheRate == null ? '—' : Math.round(cacheRate * 100) + '%');
    add('对比官方直连', zhe == null ? '—' : rhZhe(zhe), zhe != null && zhe > 1.05 ? 'bad' : 'good');
    add('输入 / 输出', rhTok(tot.in) + ' / ' + rhTok(tot.out));
    if (tot.cache) add('缓存命中 token', rhTok(tot.cache));
    sb.append(grid);
    return sec;
  }

  function renderModels(t, latest) {
    const { sec, body: sb } = rhSection('模型分布', '账单里每个模型被叫了多少次');
    const models = latest.models || [];
    if (!models.length) {
      sb.append(rhEmpty('这份账单没有模型明细'));
      return sec;
    }
    const totalCalls = models.reduce((s, m) => s + (m.calls || 0), 0) || 1;
    const tb = rhTable([
      { title: '模型' },
      { title: '调用', align: 'right' },
      { title: 'token', align: 'right' },
      { title: '消费', align: 'right' },
      { title: '占比', align: 'right' },
    ]);
    for (const m of models) {
      const tr = el('tr');
      const name = el('td');
      name.append(el('b', m.model));
      name.append(m.model === t.model ? rhTag('你指定的', 'green') : rhTag('非指定', 'red'));
      tr.append(name);
      tr.append(el('td', rhNum(m.calls), 'ta-r'));
      tr.append(el('td', rhTok(m.tokens), 'ta-r'));
      tr.append(el('td', rhMoney(m.cost), 'ta-r'));
      tr.append(el('td', Math.round((m.calls / totalCalls) * 100) + '%', 'ta-r'));
      tb.tbody.append(tr);
    }
    sb.append(tb.wrap);
    return sec;
  }

  function renderHistory(bill) {
    const t = currentTarget();
    const { sec, body: sb, head: sh } = rhSection('历史账单', '最近 ' + Math.min(8, (bill.history || []).length) + ' 次');
    if (t) {
      const clr = rhBtn('清空账单', 'tb-rh-link danger', () => clearBill(t));
      sh.append(el('span', undefined, 'tb-rh-spacer'), clr);
    }
    const hist = (bill.history || []).slice(-8).reverse();
    if (!hist.length) {
      sb.append(rhEmpty('还没有历史记录'));
      return sec;
    }
    const tb = rhTable([
      { title: '抓取时间' },
      { title: '来源' },
      { title: '请求', align: 'right' },
      { title: '消费', align: 'right' },
      { title: '输入 / 输出', align: 'right' },
      { title: '缓存命中', align: 'right' },
    ]);
    for (const h of hist) {
      const tr = el('tr');
      const tot = h.totals || {};
      tr.append(el('td', h.taken_at || '—'));
      tr.append(el('td', RH_SOURCE[h.source] || h.source || '—'));
      tr.append(el('td', rhNum(tot.requests), 'ta-r'));
      tr.append(el('td', rhMoney(tot.cost), 'ta-r'));
      tr.append(el('td', rhTok(tot.in) + ' / ' + rhTok(tot.out), 'ta-r'));
      tr.append(el('td', tot.cache ? rhTok(tot.cache) : '—', 'ta-r'));
      tb.tbody.append(tr);
    }
    sb.append(tb.wrap);
    return sec;
  }

  async function clearBill(t) {
    const yes = await rhConfirm(root, '清空「' + t.name + '」的账单？', '只删这个站的账单记录，测速记录不动。', '清空');
    if (!yes) return;
    const r = await rhPost(ctx, '/api/bill/delete', { target_id: t.id, all: true });
    if (!r.ok) {
      await rhAlert(root, '清空失败', r.error || '服务没有给出原因');
      return;
    }
    await loadBill();
  }

  function offlineCard(msg) {
    const box = el('div', undefined, 'tb-rh-offline');
    box.append(el('div', '对照台服务没有连上', 'tb-rh-offline-title'));
    box.append(el('div', '服务没在运行：到「配置」页点一次「启动服务」再回来（也可以改成自动启动）。', 'tb-rh-offline-sub'));
    box.append(el('div', String(msg || ''), 'tb-rh-offline-err'));
    return box;
  }

  load();
}

/* ============================ 配置 ============================ */

function mountConfig(ctx) {
  const root = el('div', undefined, 'tb-root tb-rh');
  ctx.root.append(root);

  const head = el('div', undefined, 'tb-head');
  const titleWrap = el('div', undefined, 'tb-title-wrap');
  titleWrap.append(el('h2', '配置', 'tb-title'));
  titleWrap.append(el('span', '对照台服务 · 提醒阈值', 'tb-source'));
  head.append(titleWrap);
  root.append(head);

  const body = el('div', undefined, 'tb-rh-body');
  root.append(body);

  const state = { st: null, cfg: null, busy: false, msg: '', msgTone: '', loading: true };

  async function load() {
    state.loading = true;
    const [s, c] = await Promise.all([rhCall(ctx, 'relayStatus', []), rhCall(ctx, 'getCfg', [])]);
    state.st = s || {};
    state.cfg = c && c.ok ? c.cfg : null;
    state.loading = false;
    render();
  }

  async function start(mode) {
    if (state.busy) return;
    state.busy = true;
    state.msg = mode === 'restart' ? '正在重启服务…' : '正在启动服务…';
    state.msgTone = '';
    render();
    const r = await rhCall(ctx, 'relayStart', [mode === 'restart' ? 'restart' : undefined]);
    state.busy = false;
    if (r && r.ok) {
      state.msg = r.already ? '服务本来就在运行。' : mode === 'restart' ? '服务已重启。' : '服务已启动。';
      state.msgTone = 'good';
    } else {
      state.msg = (r && (r.message || r.error)) || '启动失败';
      state.msgTone = 'bad';
    }
    await load();
    state.msg = state.msg || '';
    render();
  }

  async function stop() {
    if (state.busy) return;
    const yes = await rhConfirm(root, '关闭对照台服务？', '「测速对照」和「账单核对」会暂时不可用，随时可以再启动。', '关闭服务');
    if (!yes) return;
    state.busy = true;
    state.msg = '正在关闭服务…';
    state.msgTone = '';
    render();
    const r = await rhCall(ctx, 'relayStop', []);
    state.busy = false;
    state.msg = r && r.ok ? '服务已关闭。' : (r && r.error) || '关闭失败';
    state.msgTone = r && r.ok ? 'good' : 'bad';
    await load();
    render();
  }

  async function save(patch, btn, okMsg) {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '保存中…';
    const r = await rhCall(ctx, 'saveCfg', [patch]);
    btn.disabled = false;
    btn.textContent = old;
    if (!r || !r.ok) {
      state.msg = (r && r.error) || '保存失败';
      state.msgTone = 'bad';
    } else {
      state.msg = okMsg || '已保存。';
      state.msgTone = 'good';
    }
    await load();
    render();
  }

  function render() {
    body.replaceChildren();
    const st = state.st || {};
    const cfg = state.cfg || {};
    const on = !!st.ok;

    /* 服务状态：状态栏只放在这一页 */
    const { sec: svc, body: sb } = rhSection('对照台服务', '独立进程，可设为自动启动，也可以手动启停');
    const bar = el('div', undefined, 'tb-rh-statusbar');
    const left = el('div', undefined, 'tb-rh-status-left');
    const dot = el('i', undefined, 'tb-relay-dot ' + (state.busy ? 'wait' : on ? 'on' : 'off'));
    const text = el('span', on ? '服务在线 · ' + (st.url || '') : '服务未启动 · ' + (st.url || ''), 'tb-rh-status-text');
    left.append(dot, text);
    const btns = el('div', undefined, 'tb-rh-row');
    const startBtn = rhBtn(state.busy ? (state.msg.indexOf('重启') >= 0 ? '重启中…' : '启动中…') : on ? '服务已启动' : '启动服务', 'tb-primary', () => start());
    startBtn.disabled = state.busy || on;
    const stopBtn = rhBtn('关闭服务', 'tb-ghost tb-rh-danger', stop);
    stopBtn.disabled = state.busy || !on;
    const restartBtn = rhBtn('重启服务', 'tb-ghost', () => start('restart'));
    restartBtn.disabled = state.busy;
    const checkBtn = rhBtn('重新检测', 'tb-ghost', () => {
      state.msg = '';
      load();
    });
    btns.append(startBtn, stopBtn, restartBtn, checkBtn);
    bar.append(left, btns);
    sb.append(bar);

    if (state.msg) sb.append(el('div', state.msg, 'tb-rh-msg ' + (state.msgTone || '')));

    /* 启动方式：自动 / 手动 */
    const auto = !!cfg.relayAutoStart;
    const modeRow = el('div', undefined, 'tb-rh-startmode');
    modeRow.append(el('span', '启动方式', 'tb-rh-field-label'));
    const mkStartMode = (key, title, desc) => {
      const btn = el('button', undefined, 'tb-rh-startmode-btn' + ((auto ? 'auto' : 'manual') === key ? ' on' : ''));
      btn.type = 'button';
      btn.append(el('b', title), el('span', desc));
      btn.addEventListener('click', () => {
        if (state.busy) return;
        save(
          { relayAutoStart: key === 'auto' },
          btn,
          key === 'auto' ? '已设为自动启动：下次启动 Coopanion 会自己拉起服务。' : '已设为手动启动：需要时点「启动服务」。'
        );
      });
      return btn;
    };
    modeRow.append(
      mkStartMode('manual', '手动启动', '默认，不拉服务；点「启动服务」才起来'),
      mkStartMode('auto', '自动启动', 'Coopanion 启动约 3 秒后自动拉起')
    );
    sb.append(modeRow);

    const info = el('div', undefined, 'tb-rh-kv');
    const addKV = (k, v) => {
      if (!v) return;
      const row = el('div', undefined, 'tb-rh-kv-row');
      row.append(el('span', k, 'tb-rh-kv-k'));
      const val = el('span', v, 'tb-rh-kv-v');
      val.title = v;
      row.append(val);
      info.append(row);
    };
    addKV('Python', st.python || '没找到（可在下面指定 pythonw.exe 路径）');
    addKV('日志', st.log);
    addKV('页面', st.server);
    sb.append(info);
    body.append(svc);

    /* 服务设置 */
    const { sec: set, body: setBody } = rhSection('服务设置', '目录搬家后改这里；保存后立即生效');
    const grid = el('div', undefined, 'tb-rh-form-grid');
    const mk = (label, key, value, placeholder, hint) => {
      const f = el('label', undefined, 'tb-rh-field');
      f.append(el('span', label, 'tb-rh-field-label'));
      const input = el('input', undefined, 'tb-rh-input');
      input.type = 'text';
      input.value = value == null ? '' : String(value);
      if (placeholder) input.placeholder = placeholder;
      f.append(input);
      if (hint) f.append(el('span', hint, 'tb-rh-field-hint'));
      grid.append(f);
      return input;
    };
    const urlIn = mk('对照台地址', 'relayUrl', cfg.relayUrl || (st.url || ''), 'http://127.0.0.1:8770/');
    const pyIn = mk('Python 路径（可选）', 'relayPython', cfg.relayPython || '', '留空自动查找（优先 pythonw.exe）', '填 pythonw.exe 的完整路径就不会弹命令行窗口');
    const scriptIn = mk('启动脚本路径', 'relayStartScript', cfg.relayStartScript || '', 'RelayHub-service.bat');
    setBody.append(grid);
    const saveSvc = rhBtn('保存服务设置', 'tb-primary', () =>
      save(
        {
          relayUrl: urlIn.value,
          relayPython: pyIn.value,
          relayStartScript: scriptIn.value,
        },
        saveSvc
      )
    );
    const saveRow = el('div', undefined, 'tb-rh-row');
    saveRow.append(saveSvc);
    setBody.append(saveRow);
    body.append(set);

    /* 用量提醒 */
    const { sec: alert, body: ab } = rhSection('用量提醒', '当日 token 总量超过阈值时，桌宠在对话里提醒一次（每天最多一次）');
    const row = el('div', undefined, 'tb-rh-form');
    const field = el('label', undefined, 'tb-rh-field inline');
    field.append(el('span', '每日提醒阈值（0 = 关闭提醒）', 'tb-rh-field-label'));
    const alertIn = el('input', undefined, 'tb-rh-input');
    alertIn.type = 'number';
    alertIn.min = '0';
    alertIn.value = String(cfg.dailyAlertTokens || 0);
    alertIn.style.width = '180px';
    field.append(alertIn);
    row.append(field);
    const saveAlert = rhBtn('保存阈值', 'tb-primary', () => save({ dailyAlertTokens: Number(alertIn.value) || 0 }, saveAlert));
    row.append(saveAlert);
    ab.append(row);
    ab.append(el('div', '也可以直接跟桌宠说「token 超过五千万提醒我」。', 'tb-rh-note'));
    body.append(alert);

    if (state.loading && !state.st) body.prepend(rhEmpty('正在读取服务状态…'));
  }

  load();
}

/* ---------------- 面板 ---------------- */

export default {
  panels: {
    /* ---------------- 测速对照 ---------------- */
    speed: { mount: mountSpeed },

    /* ---------------- 账单核对 ---------------- */
    bill: { mount: mountBill },

    /* ---------------- 配置（服务启停 + 阈值） ---------------- */
    config: { mount: mountConfig },

    board: {
      mount(ctx) {
        const root = el('div', undefined, 'tb-root');
        ctx.root.append(root);

        const state = {
          data: null, // summary 载荷
          date: null, // 选中的日期（null = 最新）
          metric: 'total',
          mode: 'bar',
          drill: null, // 下钻的小时（数字）或 null
          minutes: null, // minutes 载荷
          range: '14d', // 历史表范围：14d / week / month / all
          rangeData: null, // range 载荷
          loading: false,
        };

        const RANGES = [
          { key: '14d', name: '最近 14 天' },
          { key: 'week', name: '本周' },
          { key: 'month', name: '本月' },
          { key: 'all', name: '全部' },
        ];

        /* ---------- 顶部工具行 ---------- */
        const head = el('div', undefined, 'tb-head');
        const titleWrap = el('div', undefined, 'tb-title-wrap');
        const title = el('h2', '每小时 token 曲线', 'tb-title');
        const source = el('span', '…', 'tb-source');
        titleWrap.append(title, source);

        const tools = el('div', undefined, 'tb-tools');
        const dateSel = el('select', undefined, 'tb-select');
        const tabs = el('div', undefined, 'tb-tabs');
        for (const m of Object.values(METRICS)) {
          const b = el('button', m.name, 'tb-tab' + (m.key === state.metric ? ' on' : ''));
          b.type = 'button';
          b.title = m.hint || m.name;
          b.addEventListener('click', () => {
            state.metric = m.key;
            [...tabs.children].forEach((c) => c.classList.remove('on'));
            b.classList.add('on');
            renderAll();
          });
          tabs.append(b);
        }
        const modeBtn = el('button', '柱状', 'tb-ghost');
        modeBtn.type = 'button';
        modeBtn.addEventListener('click', () => {
          state.mode = state.mode === 'bar' ? 'line' : 'bar';
          modeBtn.textContent = state.mode === 'bar' ? '柱状' : '折线';
          renderChartArea();
        });
        const refreshBtn = el('button', '刷新', 'tb-ghost tb-refresh');
        refreshBtn.type = 'button';
        refreshBtn.addEventListener('click', () => reload());
        tools.append(dateSel, tabs, modeBtn, refreshBtn);
        head.append(titleWrap, tools);
        root.append(head);

        /* ---------- 汇总卡 ---------- */
        const cards = el('div', undefined, 'tb-cards');
        root.append(cards);

        /* ---------- 图表区 ---------- */
        const chartWrap = el('div', undefined, 'tb-chartwrap');
        root.append(chartWrap);

        /* ---------- 下钻区（点柱子后在下方展开这一小时的每分钟） ---------- */
        const drillWrap = el('div');
        root.append(drillWrap);

        /* ---------- 历史表 + 模型表 ---------- */
        const tables = el('div', undefined, 'tb-tables');
        root.append(tables);

        const foot = el(
          'div',
          '数据来自 Coopanion 本机用量日志（usage.jsonl）·总量 = 输入 + 输出，「缓存命中」为输入中命中前缀缓存的部分（单独计费折扣）·按本地区整点归档，灰色区域为尚未发生的小时。',
          'tb-foot'
        );
        root.append(foot);

        /* ---------- 渲染 ---------- */

        function metricOf(b) {
          return b ? b[state.metric] || 0 : 0;
        }

        function renderHead() {
          const d = state.data;
          if (!d || !d.ok) {
            source.textContent = '';
            dateSel.replaceChildren();
            const opt = el('option', '无数据');
            dateSel.append(opt);
            dateSel.disabled = true;
            return;
          }
          dateSel.disabled = false;
          dateSel.replaceChildren();
          for (const day of d.days.slice(0, 14)) {
            const opt = el('option', day);
            opt.value = day;
            dateSel.append(opt);
          }
          dateSel.value = d.date;
          source.textContent =
            d.date + ' · ' + (d.source || 'usage.jsonl') + (d.alertLimit > 0 ? ' · 提醒阈值 ' + fmtCn(d.alertLimit) : '');
        }

        function renderCards() {
          const d = state.data;
          cards.replaceChildren();
          if (!d || !d.ok) {
            const msg = el('div', undefined, 'tb-empty');
            msg.append(el('div', d && d.message ? d.message : '还没有数据', 'tb-empty-title'));
            if (d && d.file) msg.append(el('div', d.file, 'tb-empty-path'));
            cards.append(msg);
            return;
          }
          const t = d.totals;
          const elapsed = d.isToday ? d.nowHour + 1 : 24;
          const avgPerHour = t.total / Math.max(1, elapsed);

          // 卡1 当日总 token
          const c1 = el('div', undefined, 'tb-card');
          c1.append(el('div', '当日总 token', 'tb-card-label'));
          c1.append(el('div', fmtCn(t.total), 'tb-card-big'));
          c1.append(el('div', '平均 ' + fmtCn(avgPerHour) + '/时 · 已过 ' + elapsed + ' 小时', 'tb-card-sub'));

          // 卡2 当前小时进行中
          const c2 = el('div', undefined, 'tb-card');
          const ch = d.isToday ? d.hours[d.nowHour] : null;
          if (ch) {
            const folded = (ch.total / Math.max(1, d.nowMin + 1)) * 60;
            c2.append(el('div', pad2(d.nowHour) + ':00 进行中', 'tb-card-label'));
            c2.append(el('div', fmtCn(ch.total), 'tb-card-big'));
            c2.append(el('div', '已过 ' + (d.nowMin + 1) + ' 分 · 折合 ' + fmtCn(folded) + '/时', 'tb-card-sub'));
          } else {
            c2.append(el('div', '这一天', 'tb-card-label'));
            c2.append(el('div', fmtCn(t.total), 'tb-card-big'));
            c2.append(el('div', '已结束 · 共 ' + fmtInt(t.calls) + ' 次调用', 'tb-card-sub'));
          }

          // 卡3 峰值时段
          const c3 = el('div', undefined, 'tb-card');
          let peak = { h: -1, v: 0 };
          d.hours.forEach((b, h) => {
            if (b.total > peak.v) peak = { h, v: b.total };
          });
          if (peak.h >= 0 && peak.v > 0) {
            c3.append(el('div', '峰值时段', 'tb-card-label'));
            c3.append(el('div', pad2(peak.h) + ':00', 'tb-card-big'));
            c3.append(el('div', fmtCn(peak.v) + ' · 占全天 ' + fmtPct(peak.v / Math.max(1, t.total)) + (t.total ? '' : ''), 'tb-card-sub'));
          } else {
            c3.append(el('div', '峰值时段', 'tb-card-label'));
            c3.append(el('div', '—', 'tb-card-big'));
            c3.append(el('div', '这一时段还没有调用', 'tb-card-sub'));
          }

          // 卡4 缓存命中率
          const c4 = el('div', undefined, 'tb-card');
          const hitRate = t.input > 0 ? t.hit / t.input : 0;
          c4.append(el('div', '缓存命中率', 'tb-card-label'));
          c4.append(el('div', t.input > 0 ? fmtPct(hitRate) : '—', 'tb-card-big'));
          c4.append(
            el(
              'div',
              '命中 ' + fmtCn(t.hit) + ' / 输入 ' + fmtCn(t.input) + (t.input > 0 ? ' · 未命中 ' + fmtCn(t.input - t.hit) : ''),
              'tb-card-sub'
            )
          );

          // 卡5 较昨日同期
          const c5 = el('div', undefined, 'tb-card');
          c5.append(el('div', '较昨日同期', 'tb-card-label'));
          if (d.hasPrev && d.prevTotals) {
            const elapsedPrev = d.isToday
              ? d.prev.reduce((a, b, h) => (h <= d.nowHour ? a + (b.total || 0) : a), 0)
              : d.prevTotals.total;
            const diff = elapsedPrev - t.total;
            const pct = elapsedPrev > 0 ? diff / elapsedPrev : 0;
            c5.append(el('div', (diff >= 0 ? '-' : '+') + fmtPct(Math.abs(pct), 0), 'tb-card-big' + (diff >= 0 ? ' good' : ' warn')));
            c5.append(el('div', '今日 ' + fmtCn(t.total) + ' / 昨日 ' + fmtCn(elapsedPrev), 'tb-card-sub'));
          } else {
            c5.append(el('div', '—', 'tb-card-big'));
            c5.append(el('div', '昨天没有同期记录', 'tb-card-sub'));
          }
          cards.append(c1, c2, c3, c4, c5);
        }

        function hourItems() {
          const d = state.data;
          return d.hours.map((b, h) => ({
            label: pad2(h) + ':00',
            value: metricOf(b),
            calls: b.calls,
            input: b.input,
            output: b.output,
            hit: b.hit,
            total: b.total || 0,
            future: d.isToday && h > d.nowHour,
            current: d.isToday && h === d.nowHour,
          }));
        }

        function renderChartArea() {
          chartWrap.replaceChildren();
          const d = state.data;
          if (!d || !d.ok) {
            drillWrap.replaceChildren();
            drillWrap.className = '';
            return;
          }

          // 每小时图常驻
          const items = hourItems();
          const svg = renderChart(items, d.hasPrev ? d.prev : null, {
            metricKey: state.metric,
            mode: state.mode,
            picked: state.drill,
            mean: d.totals.total / Math.max(1, d.isToday ? d.nowHour + 1 : 24),
            meanLabel: '平均 ' + fmtCn(d.totals.total / Math.max(1, d.isToday ? d.nowHour + 1 : 24)) + '/时',
            nowText: d.isToday ? '现在 ' + pad2(d.nowHour) + ':' + pad2(d.nowMin) : '',
            onPick: (h) => openDrill(h),
            tip: { kind: 'hour', dayTotal: d.totals.total, prev: d.hasPrev ? d.prev : null },
          });
          chartWrap.append(svg);

          const legend = el('div', undefined, 'tb-legend');
          const dot = (cls, text) => {
            const s = el('span', undefined, 'tb-lg');
            s.append(el('i', undefined, cls), el('span', text));
            return s;
          };
          legend.append(
            dot('dot-blue', metricName(state.metric) + '（每小时）'),
            dot('dot-dash', '昨日同期 ' + d.prevDate),
            dot('dot-orange', '已发生时段均值'),
            el('span', '蓝框 = 进行中的小时 · 灰底 = 尚未发生 · 点柱子在下方展开这一小时的每分钟', 'tb-lg-plain')
          );
          chartWrap.append(legend);

          // 下钻区：选中才显示
          if (state.drill == null) {
            drillWrap.replaceChildren();
            drillWrap.className = '';
          } else {
            renderDrill();
          }
        }

        function renderDrill() {
          drillWrap.replaceChildren();
          drillWrap.className = 'tb-chartwrap tb-drillwrap';
          const m = state.minutes;
          if (!m || !m.ok) {
            drillWrap.append(
              el('div', m && m.message ? '读取失败：' + m.message : '正在读取这一小时的分钟数据…', 'tb-empty')
            );
            return;
          }
          const MH = el('div', undefined, 'tb-drill-head');
          const mk = METRICS[state.metric];
          MH.append(el('span', pad2(m.hour) + ':00–' + pad2(m.hour) + ':59 · 每分钟' + mk.name, 'tb-drill-title'));
          MH.append(
            el(
              'span',
              '本小时 ' +
                fmtCn(m.hourTotals.total) +
                ' · ' +
                fmtInt(m.hourTotals.calls) +
                ' 次调用 · 活跃 ' +
                m.active +
                '/60 分钟' +
                (m.peak && m.peak.total > 0 ? ' · 峰值 ' + m.peak.m + ' 分 ' + fmtCn(m.peak.total) : '') +
                (m.prevTotal > 0 ? ' · 昨日同期 ' + fmtCn(m.prevTotal) : ''),
              'tb-drill-sub'
            )
          );
          const closeBtn = el('button', '× 收起', 'tb-ghost tb-xs');
          closeBtn.type = 'button';
          closeBtn.addEventListener('click', () => closeDrill());
          MH.append(closeBtn);
          drillWrap.append(MH);

          // 这一天选中的小时是否是"正在进行"的那一小时
          const isCurrent = !!(m.isToday && state.data && state.data.ok && m.hour === state.data.nowHour);
          const elapsedMin = isCurrent ? Math.max(1, m.nowMin + 1) : 60;
          const items = m.mins.map((b) => ({
            label: pad2(m.hour) + ':' + pad2(b.m),
            shortLabel: ':' + pad2(b.m),
            value: b[state.metric] || 0,
            calls: b.calls,
            input: b.input,
            output: b.output,
            hit: b.hit,
            total: b.total || 0,
            future: m.isToday && (m.hour > state.data.nowHour || (isCurrent && b.m > m.nowMin)),
            current: false,
          }));
          const svg = renderChart(items, m.prev && m.prevTotal > 0 ? m.prev : null, {
            metricKey: state.metric,
            mode: state.mode === 'line' ? 'line' : 'bar',
            mean: m.hourTotals.total / elapsedMin,
            meanLabel: '平均 ' + fmtCn(m.hourTotals.total / elapsedMin) + '/分',
            tip: { kind: 'minute', hourTotal: m.hourTotals.total, prev: m.prev && m.prevTotal > 0 ? m.prev : null },
          });
          drillWrap.append(svg);
          drillWrap.append(el('div', '再点一次同一根柱子、点「× 收起」或按 Esc 收起这一段', 'tb-hint'));
        }

        function openDrill(h) {
          if (state.drill === h) {
            closeDrill();
            return;
          }
          state.drill = h;
          state.minutes = null; // 先渲染加载态
          renderChartArea();
          loadMinutes().then(() => {
            if (state.drill === h) renderChartArea();
          });
        }

        function closeDrill() {
          state.drill = null;
          state.minutes = null;
          renderChartArea();
        }

        function rangeBounds() {
          const d = state.data;
          if (!d || !d.ok || !d.days.length) return null;
          const latest = d.days[0];
          let from = d.days[d.days.length - 1];
          if (state.range === '14d') {
            from = d.days[Math.min(13, d.days.length - 1)];
          } else if (state.range === 'week') {
            const dt = new Date(latest + 'T00:00:00');
            dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7)); // 回到周一
            from = fmtDate(dt);
          } else if (state.range === 'month') {
            from = latest.slice(0, 8) + '01';
          }
          return { from, to: latest };
        }

        async function loadRange() {
          const b = rangeBounds();
          if (!b) {
            state.rangeData = null;
            return;
          }
          try {
            state.rangeData = await ctx.invoke('range', [b.from, b.to]);
          } catch (e) {
            state.rangeData = { ok: false, message: String((e && e.message) || e) };
          }
        }

        function renderTables() {
          tables.replaceChildren();
          const d = state.data;
          if (!d || !d.ok) return;

          // ---- 历史（带范围选择 + 合计行） ----
          const histCard = el('div', undefined, 'tb-tablecard');
          const histHead = el('div', undefined, 'tb-cardtitle-row');
          histHead.append(el('div', '历史（按本机日志统计）', 'tb-cardtitle'));
          const rangeSel = el('select', undefined, 'tb-select tb-xs-sel');
          for (const r of RANGES) {
            const opt = el('option', r.name);
            opt.value = r.key;
            if (r.key === state.range) opt.selected = true;
            rangeSel.append(opt);
          }
          rangeSel.addEventListener('change', () => {
            state.range = rangeSel.value;
            loadRange().then(renderTables);
          });
          histHead.append(rangeSel);
          histCard.append(histHead);
          const tbl1 = el('table', undefined, 'tb-table');
          const thead1 = el('thead');
          const trh = el('tr');
          for (const h of ['日期', '调用数量', '总 token', '输入 token', '输出 token', '缓存命中', '命中率']) {
            trh.append(el('th', h));
          }
          thead1.append(trh);
          tbl1.append(thead1);
          const tbody1 = el('tbody');
          const rd = state.rangeData;
          if (rd && rd.ok && rd.days.length) {
            for (const s of rd.days) {
              const tr = el('tr', undefined, s.date === d.date ? 'on' : '');
              const tdDate = el('td', s.date);
              tdDate.style.cursor = 'pointer';
              tdDate.title = '看这一天';
              tdDate.addEventListener('click', () => {
                state.date = s.date;
                state.drill = null;
                reload();
              });
              tr.append(
                tdDate,
                el('td', fmtInt(s.calls)),
                el('td', fmtCn(s.total)),
                el('td', fmtCn(s.input)),
                el('td', fmtCn(s.output)),
                el('td', fmtCn(s.hit)),
                el('td', s.input > 0 ? fmtPct(s.hit / s.input) : '—')
              );
              tbody1.append(tr);
            }
            const t = rd.totals;
            const trF = el('tr', undefined, 'sum');
            trF.append(
              el('td', '合计 ' + rd.days.length + ' 天'),
              el('td', fmtInt(t.calls)),
              el('td', fmtCn(t.total)),
              el('td', fmtCn(t.input)),
              el('td', fmtCn(t.output)),
              el('td', fmtCn(t.hit)),
              el('td', t.input > 0 ? fmtPct(t.hit / t.input) : '—')
            );
            tbody1.append(trF);
          } else {
            const tr = el('tr');
            tr.append(el('td', rd && rd.message ? '加载失败：' + rd.message : '这个范围还没有记录', 'tb-mono'));
            for (let i = 0; i < 6; i++) tr.append(el('td', '—'));
            tbody1.append(tr);
          }
          tbl1.append(tbody1);
          histCard.append(tbl1);
          histCard.append(el('div', '点日期可切换查看那一天；命中率 = 缓存命中 ÷ 输入。', 'tb-tblnote'));
          tables.append(histCard);

          // ---- 模型分布（按所选日期） ----
          const modelCard = el('div', undefined, 'tb-tablecard');
          modelCard.append(el('div', '模型分布 · ' + d.date, 'tb-cardtitle'));
          const tbl2 = el('table', undefined, 'tb-table');
          const thead2 = el('thead');
          const trh2 = el('tr');
          for (const h of ['模型', '调用', '词元（输入+输出）', '输入', '输出', '缓存命中']) {
            trh2.append(el('th', h));
          }
          thead2.append(trh2);
          tbl2.append(thead2);
          const tbody2 = el('tbody');
          const models = d.models.slice(0, 14);
          for (const mo of models) {
            const tr = el('tr');
            tr.append(
              el('td', mo.model, 'tb-mono'),
              el('td', fmtInt(mo.calls)),
              el('td', fmtCn(mo.total)),
              el('td', fmtCn(mo.input)),
              el('td', fmtCn(mo.output)),
              el('td', fmtCn(mo.hit))
            );
            tbody2.append(tr);
          }
          if (d.models.length > models.length) {
            const rest = d.models.slice(14);
            const sum = rest.reduce((a, b) => a + b.total, 0);
            const calls = rest.reduce((a, b) => a + b.calls, 0);
            const tr = el('tr', undefined, 'muted');
            tr.append(
              el('td', '其他 ' + rest.length + ' 个模型'),
              el('td', fmtInt(calls)),
              el('td', fmtCn(sum)),
              el('td', '—'),
              el('td', '—'),
              el('td', '—')
            );
            tbody2.append(tr);
          }
          tbl2.append(tbody2);
          modelCard.append(tbl2);
          modelCard.append(el('div', '按所选日期统计，只统计 Coopanion 本机日志里出现过的调用。', 'tb-tblnote'));
          tables.append(modelCard);
        }

        function renderAll() {
          renderCards();
          renderChartArea();
          renderTables();
        }

        /* ---------- 数据加载 ---------- */

        async function loadSummary() {
          try {
            const d = await ctx.invoke('summary', [state.date]);
            state.data = d;
          } catch (e) {
            state.data = { ok: false, message: '加载失败：' + (e && e.message ? e.message : e) };
          }
        }

        async function loadMinutes() {
          if (state.drill == null || !state.data || !state.data.ok) return;
          const wantHour = state.drill;
          try {
            const m = await ctx.invoke('minutes', [state.data.date, wantHour]);
            if (state.drill === wantHour) state.minutes = m; // 期间用户点了别的柱子就丢弃
          } catch (e) {
            if (state.drill === wantHour) state.minutes = { ok: false, message: String((e && e.message) || e) };
          }
        }

        async function reload(keepDrill = true) {
          if (state.loading) return;
          state.loading = true;
          refreshBtn.classList.add('spin');
          try {
            await loadSummary();
            if (state.drill != null && keepDrill) {
              if (state.drill > (state.data && state.data.ok ? state.data.nowHour : 23)) state.drill = null;
              if (state.drill != null) await loadMinutes();
            } else {
              state.drill = null;
            }
            if (state.data && state.data.ok) {
              await loadRange();
            } else {
              state.rangeData = null;
            }
            renderHead();
            renderAll();
          } finally {
            state.loading = false;
            refreshBtn.classList.remove('spin');
          }
        }

        dateSel.addEventListener('change', () => {
          state.date = dateSel.value || null;
          state.drill = null;
          reload();
        });

        const escHandler = (ev) => {
          if (ev.key === 'Escape' && state.drill != null) closeDrill();
        };
        window.addEventListener('keydown', escHandler);

        // 定时自刷：面板不可见或已卸载就停
        state.timer = setInterval(() => {
          if (!root.isConnected) {
            clearInterval(state.timer);
            window.removeEventListener('keydown', escHandler);
            hideTip();
            return;
          }
          if (document.visibilityState !== 'visible') return;
          reload();
        }, 30000);

        reload();
      },
    },
  },
};
