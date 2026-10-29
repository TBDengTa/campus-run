/**
 * Web 控制台前端逻辑（零依赖原生 JS）。
 *
 * ===== 两条硬约束（改这个文件前务必读完） =====
 * ① **服务端数据一律用 textContent，绝不用 innerHTML 拼接**。
 *    列表里渲染的是学生姓名、班级、学号、管理员备注 —— 姓名是用户可控输入，
 *    走 innerHTML 就是存储型 XSS（能带着会话调封禁接口）。
 *    只有完全静态、不含任何外部字段的结构才允许用 innerHTML 写死（见 tableHead）。
 * ② 不用内联 onclick / style。CSP 是 script-src 'self'（不放行内联脚本），
 *    内联事件属性会被拦掉，表现为「按钮点了没反应」这种最难查的静默失败。
 *    所以事件一律 addEventListener，样式一律走 class 或 .style.cssText（字符串里不含外部数据）。
 */
'use strict';

/* ==================== DOM 工具 ==================== */
function $(id) { return document.getElementById(id); }
function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
function clear(node) { node.innerHTML = ''; }
function show(id, on) { $(id).classList.toggle('hide', !on); }
function fmt(n) { return (Number(n) || 0).toLocaleString('zh-CN'); }
function pct(n) { return Math.round(Number(n) || 0) + '%'; }
function pad2(x) { return x < 10 ? '0' + x : String(x); }
function timeText(v) {
  if (!v) return '—';
  var d = new Date(v);
  if (isNaN(d.getTime())) return '—';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function ago(v) {
  if (!v) return '—';
  var ms = Date.now() - new Date(v).getTime();
  if (isNaN(ms)) return '—';
  var m = Math.floor(ms / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  var h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  return Math.floor(h / 24) + ' 天前';
}

var toastTimer = null;
function toast(msg, bad) {
  var t = $('toast');
  t.textContent = msg;
  t.classList.toggle('bad', !!bad);
  t.classList.remove('hide');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.add('hide'); }, bad ? 4200 : 2000);
}

/* ==================== API ==================== */
function api(path, opts) {
  opts = opts || {};
  return fetch('/console/api' + path, {
    method: opts.method || 'GET',
    credentials: 'same-origin',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  }).then(function (r) {
    return r.json().catch(function () {
      return { code: r.status, message: '服务响应异常（' + r.status + '）' };
    }).then(function (j) {
      if (r.status === 401) {
        var e = new Error(j.message || '登录已过期，请重新登录');
        e.unauthorized = true;
        throw e;
      }
      if (j.code !== 0) {
        var e2 = new Error(j.message || '请求失败');
        e2.code = j.code;
        throw e2;
      }
      return j.data;
    });
  });
}

/* ==================== 状态 ==================== */
var caps = { view: false, label: false, ban: false, manage: false };
var LABEL_TEXT = { cheat: '作弊', minor: '轻微违规', device: '设备/网络问题', normal: '正常' };
var LABEL_KINDS = ['cheat', 'minor', 'device', 'normal'];
var query = { status: 'open', source: 'all', label: '', keyword: '', page: 1 };
var listLimit = 30;
var pollTimer = null;
var banTargetId = '';

var STATUS_OPTS = [['open', '待研判'], ['banned', '已封禁'], ['dismissed', '已排除'], ['all', '全部']];
var SOURCE_OPTS = [['all', '全部来源'], ['werun', '微信同步'], ['gps', 'GPS 实跑']];
var STRICT_OPTS = [
  ['loose', '宽松', '只封明显作弊，宁漏不误伤（开学初 / 大型活动期用）'],
  ['balanced', '平衡', '默认档位，与历史校准基线一致'],
  ['strict', '严格', '宁可多抓，接受少量误伤（需要有人手复核待研判记录）'],
  ['custom', '自定义', '手调两个阈值（高级用法）'],
];

/* ==================== 视图切换 ==================== */
function currentView() {
  if (!$('vTrain').classList.contains('hide')) return 'train';
  if (!$('vCfg').classList.contains('hide')) return 'cfg';
  return 'dash';
}

function switchView(v) {
  $('vDash').classList.toggle('hide', v !== 'dash');
  $('vTrain').classList.toggle('hide', v !== 'train');
  $('vCfg').classList.toggle('hide', v !== 'cfg');
  var tabs = document.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('on', tabs[i].getAttribute('data-v') === v);
  stopPoll();
  if (v === 'dash') loadDash();
  if (v === 'train') loadList();
  if (v === 'cfg') loadCfg();
}

// 状态台 30 秒自动刷新。用 setTimeout 链而不是 setInterval：
// 上一次请求没回来就再发一轮会把慢接口叠起来（列表页历史上就是这么卡死的）。
function startPoll() {
  stopPoll();
  pollTimer = setTimeout(function () {
    if (currentView() === 'dash' && !$('viewApp').classList.contains('hide')) {
      loadDash(true);
    } else if (currentView() === 'train' && !$('viewApp').classList.contains('hide')) {
      loadList(true);
    }
  }, 30000);
}
function stopPoll() { clearTimeout(pollTimer); pollTimer = null; }

/* ==================== 登录 / 会话 ==================== */
function doLogin() {
  var acc = $('inAccount').value.trim();
  var pw = $('inPassword').value;
  var err = $('loginErr');
  if (!acc || !pw) { err.textContent = '请输入姓名和密码'; show('loginErr', true); return; }
  $('btnLogin').disabled = true;
  show('loginErr', false);
  api('/login', { method: 'POST', body: { account: acc, password: pw } })
    .then(function (me) {
      $('inPassword').value = '';
      $('btnLogin').disabled = false;
      enterApp(me);
    })
    .catch(function (e) {
      $('btnLogin').disabled = false;
      err.textContent = e.message || '登录失败';
      show('loginErr', true);
    });
}

function enterApp(me) {
  caps = (me && me.caps) || { view: false, label: false, ban: false, manage: false };
  $('who').textContent = (me.name || me.account || '') + '（' + (me.role === 'teacher' ? '教师' : me.role || '') + '）';
  // 没有 manage 权限就藏起「模型配置」页签（服务端仍会 403，前端只是体验）；
  // 没有 view 权限直接停在登录页 —— 三个页面全都需要 view。
  var cfgTab = document.querySelector('.tab[data-v="cfg"]');
  if (cfgTab) cfgTab.classList.toggle('hide', !caps.manage);
  if (!caps.view) {
    show('viewApp', false);
    show('viewLogin', true);
    $('loginErr').textContent = '这个账号没有任何反作弊查看权限，控制台暂不可用';
    show('loginErr', true);
    return;
  }
  show('viewLogin', false);
  show('viewApp', true);
  switchView('dash');
}

function toLogin() {
  stopPoll();
  show('viewApp', false);
  show('viewLogin', true);
  $('btnLogin').disabled = false;
  bootStatus();
}

// 登录页的自检信息：**只有运行指标，没有任何反作弊参数**。
// 旧版根状态页会显示待研判数量与 AI 阈值；根路径现在对公网开放，
// 「刷到多少分会被封」告诉任何人等于教人绕过硬禁，所以这些数字只在登录后取。
function bootStatus() {
  api('/public-status')
    .then(function (s) {
      var box = $('opsStatus');
      clear(box);
      var line = el('div');
      line.appendChild(el('span', 'dot' + (s.dbReady ? '' : ' bad')));
      line.appendChild(el('span', '', '服务' + (s.apiOk ? '运行中' : '异常') + ' · 版本 ' + (s.version || '—')));
      box.appendChild(line);
      box.appendChild(el('div', '', '启动 ' + (s.bootText || '—') + ' · 已运行 ' + (s.upText || '—')));
      box.appendChild(el('div', '', '数据库 ' + (s.dbReady ? '已连接' : '未连接') + ' · 本次响应 ' + (s.costText || '—') + ' ms'));
    })
    .catch(function () {
      $('opsStatus').textContent = '状态获取失败（不影响登录）';
    });
}

/* ==================== 状态台 ==================== */
function statCard(k, v, m) {
  var box = el('div', 'stat');
  box.appendChild(el('div', 'k', k));
  box.appendChild(el('div', 'v', v));
  if (m) box.appendChild(el('div', 'm', m));
  return box;
}

function loadDash() {
  api('/dashboard')
    .then(function (d) {
      renderDash(d);
      startPoll();
    })
    .catch(function (e) {
      if (e.unauthorized) return toLogin();
      toast(e.message, true);
      startPoll();
    });
}

function renderDash(d) {
  if (d.labelText) LABEL_TEXT = d.labelText;
  if (d.labelKinds && d.labelKinds.length) LABEL_KINDS = d.labelKinds;

  var q = d.queue || {};
  var svc = $('svcGrid');
  clear(svc);
  svc.appendChild(statCard('待研判', fmt(q.open), '需要人工看的线索'));
  svc.appendChild(statCard('24h 新增待标', fmt(q.unlabeledToday), '还没人标注的量'));
  svc.appendChild(statCard('24h 已封禁', fmt(q.bannedToday), '含系统自动与人工'));
  svc.appendChild(statCard('限制中人数', fmt(d.activeRestricted), '当前处于限制状态'));

  var m = d.models || {};
  var w = m.werun || {};
  var g = m.gps || {};
  var mg = $('modelGrid');
  clear(mg);
  mg.appendChild(statCard(
    '微信同步模型',
    w.ready ? fmt(w.rows) + ' 条样本' : '预热中…',
    w.trees ? w.trees + ' 棵树 · 训练于 ' + ago(w.trainedAt) : '首次判定前自动预热'
  ));
  mg.appendChild(statCard(
    'GPS 实跑模型',
    g.ready ? fmt(g.rows) + ' 条样本' : '预热中…',
    g.trees ? g.trees + ' 棵树 · 训练于 ' + ago(g.trainedAt) : '首次判定前自动预热'
  ));

  var bothReady = !!w.ready && !!g.ready;
  var tag = $('aiStateTag');
  clear(tag);
  tag.appendChild(el('span', 'pill ' + (bothReady ? 'ok' : 'warn'), bothReady ? '两个模型都在跑' : '预热中'));
  tag.appendChild(el('span', '', ' 在线会话 ' + fmt(d.online)));

  var th = d.threshold || {};
  var tg = $('threshGrid');
  clear(tg);
  tg.appendChild(statCard('可疑线（进待研判）', th.suspiciousText || '—', 'AI 分高于它会被记为线索'));
  tg.appendChild(statCard('自动封禁线', th.autoBanText || '—', 'AI 分高于它直接限制同步'));
  tg.appendChild(statCard('服务器时间', timeText(d.serverTime), '标注与处置按这个时间记录'));

  renderMatrix(q.matrix);
  renderUpgrade(d.upgrade || {});
  renderRecent(d.recentBans || []);

  // 服务运行指标（登录后才给，含请求数与内存）
  var og = $('opsGrid');
  clear(og);
  var ops = d.ops || {};
  og.appendChild(statCard('累计请求', fmt(ops.served), '自本次启动起'));
  og.appendChild(statCard('运行时长', ops.upText || '—', '启动于 ' + (ops.bootText || '—')));
  og.appendChild(statCard('内存占用', (ops.rssMb || 0) + ' MB', ''));
  og.appendChild(statCard('数据库', ops.dbReady ? '已连接' : '未连接', ''));
}

function renderMatrix(matrix) {
  var box = $('matrixBox');
  clear(box);
  var m = matrix || {};
  var cols = ['unlabeled'].concat(LABEL_KINDS);
  var names = { unlabeled: '未标注' };
  for (var i = 0; i < LABEL_KINDS.length; i++) names[LABEL_KINDS[i]] = LABEL_TEXT[LABEL_KINDS[i]];

  var tb = el('table');
  // 表头是**纯静态**内容（列名来自 LABEL_TEXT 常量表，非用户数据），允许 innerHTML
  var head = '<thead><tr><th>来源</th>';
  for (var c = 0; c < cols.length; c++) head += '<th class="r">' + names[cols[c]] + '</th>';
  head += '</tr></thead>';
  tb.innerHTML = head;

  var tbody = el('tbody');
  var rows = [['werun', '微信同步'], ['gps', 'GPS 实跑']];
  for (var r = 0; r < rows.length; r++) {
    var tr = el('tr');
    tr.appendChild(el('td', '', rows[r][1]));
    var bucket = m[rows[r][0]] || {};
    for (var k = 0; k < cols.length; k++) {
      var v = Number(bucket[cols[k]]) || 0;
      tr.appendChild(el('td', 'r num', fmt(v)));
    }
    tbody.appendChild(tr);
  }
  tb.appendChild(tbody);
  box.appendChild(tb);
}

function renderUpgrade(up) {
  var ub = $('upgradeBox');
  clear(ub);
  var head = el('div');
  head.appendChild(el('span', 'pill ' + (up.ready ? 'ok' : 'mute'), up.ready ? '可以升级' : '积累中'));
  head.appendChild(el('span', '', ' 进度 ' + pct(up.progress)));
  ub.appendChild(head);

  var bar = el('div', 'bar');
  var fill = el('i');
  fill.style.width = (Number(up.progress) || 0) + '%';
  bar.appendChild(fill);
  ub.appendChild(bar);
  ub.appendChild(el('div', 'note', up.suggestion || '—'));

  var pc = up.perClass || {};
  var st = el('div', 'note');
  st.textContent =
    '可训练标注 ' + fmt(up.total) + ' 条 · 作弊 ' + fmt(pc.cheat) +
    ' · 轻微 ' + fmt(pc.minor) + ' · 正常 ' + fmt(pc.normal) +
    ' · 设备问题 ' + fmt(pc.device) + '（不进训练集）';
  ub.appendChild(st);
}

function renderRecent(bans) {
  var rb = $('recentBox');
  clear(rb);
  if (!bans.length) { rb.appendChild(el('div', 'note', '近期没有封禁处置')); return; }
  var tb = el('table');
  tb.innerHTML = '<thead><tr><th>时间</th><th>类型</th><th class="r">天数</th><th>操作人</th><th>原因</th></tr></thead>';
  var tbody = el('tbody');
  for (var i = 0; i < bans.length; i++) {
    var b = bans[i];
    var tr = el('tr');
    tr.appendChild(el('td', 'num', timeText(b.at)));
    tr.appendChild(el('td', '', b.scope === 'gps' ? 'GPS' : b.scope === 'sync' ? '微信同步' : '登录'));
    tr.appendChild(el('td', 'r num', b.days ? b.days + ' 天' : '永久'));
    tr.appendChild(el('td', '', b.operator || 'system'));
    tr.appendChild(el('td', '', b.reason || ''));
    tbody.appendChild(tr);
  }
  tb.appendChild(tbody);
  rb.appendChild(tb);
}

/* ==================== AI 训练台 ==================== */
function buildSegments() {
  var s1 = $('segStatus');
  clear(s1);
  for (var i = 0; i < STATUS_OPTS.length; i++) {
    (function (val, text) {
      var n = el('i', query.status === val ? 'on' : '', text);
      n.addEventListener('click', function () {
        query.status = val; query.page = 1; loadList();
      });
      s1.appendChild(n);
    })(STATUS_OPTS[i][0], STATUS_OPTS[i][1]);
  }
  var s2 = $('segSource');
  clear(s2);
  for (var j = 0; j < SOURCE_OPTS.length; j++) {
    (function (val, text) {
      var n = el('i', query.source === val ? 'on' : '', text);
      n.addEventListener('click', function () {
        query.source = val; query.page = 1; loadList();
      });
      s2.appendChild(n);
    })(SOURCE_OPTS[j][0], SOURCE_OPTS[j][1]);
  }
  var sel = $('selLabel');
  if (!sel.options.length) {
    var build = function (val, text) {
      var op = document.createElement('option');
      op.value = val;
      op.textContent = text;
      sel.appendChild(op);
    };
    build('', '标注：全部');
    build('unlabeled', '标注：未标注');
    for (var k = 0; k < LABEL_KINDS.length; k++) build(LABEL_KINDS[k], '标注：' + LABEL_TEXT[LABEL_KINDS[k]]);
    sel.addEventListener('change', function () { query.label = sel.value; query.page = 1; loadList(); });
  }
  sel.value = query.label;
}

function loadList() {
  buildSegments();
  var qs =
    '?status=' + encodeURIComponent(query.status) +
    '&source=' + encodeURIComponent(query.source) +
    '&label=' + encodeURIComponent(query.label) +
    '&keyword=' + encodeURIComponent(query.keyword) +
    '&page=' + encodeURIComponent(query.page) +
    '&limit=' + encodeURIComponent(listLimit);
  api('/anomalies' + qs)
    .then(function (d) {
      if (d.labelText) LABEL_TEXT = d.labelText;
      if (d.labelKinds && d.labelKinds.length) LABEL_KINDS = d.labelKinds;
      listLimit = d.limit || listLimit;
      renderList(d.list || []);
      $('listCount').textContent = '共 ' + fmt(d.total) + ' 条';
      var pages = Math.max(1, Math.ceil((d.total || 0) / (d.limit || listLimit)));
      $('pageTag').textContent = '第 ' + (d.page || 1) + ' / ' + pages + ' 页';
      $('btnPrev').disabled = (d.page || 1) <= 1;
      $('btnNext').disabled = !d.hasMore;
      startPoll();
    })
    .catch(function (e) {
      if (e.unauthorized) return toLogin();
      toast(e.message, true);
      startPoll();
    });
}

function renderList(list) {
  var box = $('listBox');
  clear(box);
  if (!list.length) { box.appendChild(el('div', 'note', '这个筛选条件下没有记录')); return; }
  for (var i = 0; i < list.length; i++) box.appendChild(renderItem(list[i]));
}

function kv(k, v) {
  var n = el('div', 'ri-kv');
  n.appendChild(el('span', '', k));
  n.appendChild(el('b', '', v));
  return n;
}

function renderItem(r) {
  var box = el('div', 'row-item');

  var head = el('div', 'ri-head');
  head.appendChild(el('span', 'ri-name', r.realName));
  head.appendChild(el('span', 'ri-meta', (r.className || '') + (r.studentId ? ' · ' + r.studentId : '') + ' · ' + r.date));
  head.appendChild(el('span', 'pill mute', r.sourceText));
  if (r.autoBanned) head.appendChild(el('span', 'pill warn', '系统自动封禁'));
  head.appendChild(el(
    'span',
    'pill ' + (r.status === 'banned' ? 'bad' : r.status === 'dismissed' ? 'mute' : 'warn'),
    r.status === 'banned' ? '已封禁' : r.status === 'dismissed' ? '已排除' : '待研判'
  ));
  var labCls = !r.label ? 'mute' : r.label === 'normal' ? 'ok' : r.label === 'device' ? 'mute' : 'bad';
  head.appendChild(el('span', 'pill ' + labCls, '标注：' + (r.labelText || '未标注')));
  box.appendChild(head);

  var body = el('div', 'ri-body');
  if (r.source !== 'gps') {
    body.appendChild(kv('当日步数', fmt(r.cumulativeSteps)));
    body.appendChild(kv('本次新增', fmt(r.deltaSteps)));
  }
  body.appendChild(kv('可疑分', fmt(r.score) + ' / 100'));
  body.appendChild(kv('AI 分', r.modelScore == null ? '—' : Number(r.modelScore).toFixed(3)));
  if (r.labeledBy) body.appendChild(kv('标注人', r.labeledBy + '（' + ago(r.labeledAt) + '）'));
  box.appendChild(body);

  var rs = el('div', 'reasons');
  var reasons = r.reasons || [];
  if (!reasons.length) rs.appendChild(el('span', '', '无附加理由'));
  for (var i = 0; i < reasons.length; i++) rs.appendChild(el('span', '', reasons[i]));
  box.appendChild(rs);
  if (r.handleNote) box.appendChild(el('div', 'note', '处置备注：' + r.handleNote));

  var acts = el('div', 'acts');
  if (caps.label && r.status === 'open') {
    for (var k = 0; k < LABEL_KINDS.length; k++) {
      (function (id, kind, current) {
        var b = el('button', 'btn sm' + (current === kind ? ' pri' : ''), LABEL_TEXT[kind]);
        b.addEventListener('click', function () { labelIt(id, kind, b); });
        acts.appendChild(b);
      })(r.id, LABEL_KINDS[k], r.label);
    }
  }
  if (caps.ban && r.status === 'open') {
    var bb = el('button', 'btn sm danger', '封禁');
    bb.addEventListener('click', function () { openBan(r); });
    acts.appendChild(bb);
  }
  if (!caps.label && !caps.ban) acts.appendChild(el('span', 'card-sub', '你只有查看权限（anticheat.view），看不到标注与封禁按钮'));
  box.appendChild(acts);
  return box;
}

function labelIt(id, kind, btn) {
  btn.disabled = true;
  api('/anomalies/' + encodeURIComponent(id) + '/label', { method: 'POST', body: { label: kind } })
    .then(function (r) {
      toast('已标注为「' + (r.labelText || LABEL_TEXT[kind]) + '」' + (r.trainable ? '' : '（不进训练集）'));
      loadList();
    })
    .catch(function (e) {
      btn.disabled = false;
      toast(e.message || '标注失败', true);
    });
}

/* ==================== 封禁 ==================== */
function openBan(r) {
  banTargetId = r.id;
  $('banWho').textContent = r.realName + ' · ' + (r.className || '') + ' · ' + r.date;
  $('banNote').value = (r.reasons || []).join('；').slice(0, 120);
  show('banErr', false);
  $('banMask').classList.remove('hide');
}
function closeBan() { $('banMask').classList.add('hide'); banTargetId = ''; }

function submitBan() {
  if (!banTargetId) return;
  var days = Number($('banDays').value) || 7;
  var note = $('banNote').value;
  var btn = $('banOk');
  btn.disabled = true;
  api('/anomalies/' + encodeURIComponent(banTargetId) + '/ban', { method: 'POST', body: { days: days, note: note } })
    .then(function (r) {
      closeBan();
      btn.disabled = false;
      toast('已封禁 ' + r.days + ' 天（限制微信同步）');
      loadList();
    })
    .catch(function (e) {
      btn.disabled = false;
      $('banErr').textContent = e.message || '封禁失败';
      show('banErr', true);
    });
}

/* ==================== 模型配置 ==================== */
function loadCfg() {
  api('/model-status')
    .then(function (d) { renderCfg(d); startPoll(); })
    .catch(function (e) {
      if (e.unauthorized) return toLogin();
      toast(e.message, true);
    });
}

function renderCfg(d) {
  var box = $('strictBox');
  clear(box);
  var cur = d.aiStrictness || 'balanced';
  var eff = d.effective || {};
  var presets = d.strictnessOptions || {};

  for (var i = 0; i < STRICT_OPTS.length; i++) {
    (function (key, name, desc) {
      var row = el('div', 'row-item');
      var h = el('div', 'ri-head');
      h.appendChild(el('span', 'ri-name', name));
      var radio = el('button', 'btn sm' + (cur === key ? ' pri' : ''), cur === key ? '当前档位' : '切到此档');
      radio.disabled = !!d.readonly;
      radio.addEventListener('click', function () { saveCfg({ aiStrictness: key }); });
      h.appendChild(radio);
      row.appendChild(h);
      row.appendChild(el('div', 'note', desc));
      var p = presets[key];
      if (p) row.appendChild(el('div', 'card-sub', '档位基线：可疑 ' + p.suspicious + ' / 封禁 ' + p.autoBan));
      box.appendChild(row);
    })(STRICT_OPTS[i][0], STRICT_OPTS[i][1], STRICT_OPTS[i][2]);
  }

  var curRow = el('div', 'row-item');
  curRow.appendChild(el('div', 'card-sub',
    '当前生效（含在线校准）：可疑 ' + Number(eff.suspicious).toFixed(3) +
    ' / 自动封禁 ' + Number(eff.autoBan).toFixed(3) + ' · 档位 ' + (eff.mode || cur)));
  var fr = el('div', 'acts');
  var sLbl = el('span', 'card-sub', '可疑线');
  var sIn = el('input'); sIn.type = 'number'; sIn.step = '0.01'; sIn.min = '0.3'; sIn.max = '0.95';
  sIn.value = d.aiSuspiciousThreshold == null ? 0.62 : d.aiSuspiciousThreshold;
  var aLbl = el('span', 'card-sub', '封禁线');
  var aIn = el('input'); aIn.type = 'number'; aIn.step = '0.01'; aIn.min = '0.4'; aIn.max = '0.99';
  aIn.value = d.aiAutoBanThreshold == null ? 0.78 : d.aiAutoBanThreshold;
  var save = el('button', 'btn sm pri', '保存为自定义');
  save.addEventListener('click', function () {
    saveCfg({
      aiStrictness: 'custom',
      aiSuspiciousThreshold: Number(sIn.value),
      aiAutoBanThreshold: Number(aIn.value),
    });
  });
  fr.appendChild(sLbl); fr.appendChild(sIn); fr.appendChild(aLbl); fr.appendChild(aIn); fr.appendChild(save);
  curRow.appendChild(fr);
  curRow.appendChild(el('div', 'note', '保存后自动封禁线会被抬到「可疑线 + 0.02」以上（低于则改写），避免一到可疑就直接封。'));
  box.appendChild(curRow);

  var eb = $('enableBox');
  clear(eb);
  var en = el('div', 'row-item');
  en.appendChild(el('div', 'ri-head', '自动封禁总开关：' + (d.enabled ? '已开启' : '已关闭')));
  en.appendChild(el('div', 'note', '关闭后 AI 仍会打分并进入待研判队列，但不再自动限制学生同步。'));
  var btn2 = el('button', 'btn sm' + (d.enabled ? '' : ' pri'), d.enabled ? '关闭自动封禁' : '开启自动封禁');
  btn2.addEventListener('click', function () { saveCfg({ enabled: !d.enabled }); });
  en.appendChild(btn2);
  eb.appendChild(en);
}

function saveCfg(patch) {
  api('/model-config', { method: 'PUT', body: patch })
    .then(function (r) {
      var keys = Object.keys((r && r.changed) || {});
      toast('已保存：' + (keys.length ? keys.join(' / ') : '无变化'));
      loadCfg();
    })
    .catch(function (e) { toast(e.message || '保存失败', true); });
}

/* ==================== 事件绑定（无内联 onclick，见文件头约束 ②） ==================== */
function bindEvents() {
  $('btnLogin').addEventListener('click', doLogin);
  $('inPassword').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  $('inAccount').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('inPassword').focus(); });

  $('btnLogout').addEventListener('click', function () {
    api('/logout', { method: 'POST' }).catch(function () {}).then(function () { toLogin(); });
  });
  $('btnRefresh').addEventListener('click', function () { switchView(currentView()); });

  var tabs = document.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function () { switchView(this.getAttribute('data-v')); });
  }

  $('btnSearch').addEventListener('click', function () {
    query.keyword = $('inKeyword').value.trim();
    query.page = 1;
    loadList();
  });
  $('inKeyword').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('btnSearch').click();
  });
  $('btnPrev').addEventListener('click', function () {
    if (query.page > 1) { query.page -= 1; loadList(); }
  });
  $('btnNext').addEventListener('click', function () { query.page += 1; loadList(); });

  $('banCancel').addEventListener('click', closeBan);
  $('banOk').addEventListener('click', submitBan);
  $('banMask').addEventListener('click', function (e) { if (e.target === this) closeBan(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeBan();
  });
}

function init() {
  bindEvents();
  // 带着有效 Cookie 直接进控制台；否则停在登录页（两种情况都不报错，401 是预期路径）
  api('/me').then(enterApp).catch(function () { toLogin(); });
}

init();
