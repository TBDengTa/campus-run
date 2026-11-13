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
var query = { status: 'open', source: 'all', label: '', keyword: '', sort: '', minSteps: '', minDistance: '', page: 1 };
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
    .then(function () {
      $('inPassword').value = '';
      // ⚠️ 登录响应只有 {account,name,role,perms}，**没有 caps**；
      // enterApp 读的是 me.caps（能力表）。早前把 login 的返回值直接丢给 enterApp，
      // 于是 caps 恒为 undefined → 取默认 {view:false,...} → 页面报
      // 「这个账号没有任何反作弊查看权限」—— 连超级管理员（'*'）都被挡在门外。
      // 能力表只有 /me 一处产出（服务端逐项 hasPerm 计算），登录后必须再取一次。
      return api('/me');
    })
    .then(function (me) {
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

  // 自动处置开关状态（用户 2026-11-03「关了依旧会主动封禁」）：
  // 必须在状态台最显眼处可见，而不是藏在模型配置页里。
  var at = $('autoTag');
  clear(at);
  at.appendChild(el('span', 'pill ' + (d.autoDispose ? 'ok' : 'bad'), '自动处置 ' + (d.autoDispose ? '开启' : '已关闭')));
  at.appendChild(el('span', '', '数据每 30 秒自动刷新'));

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
  renderStages(d.stages || null);
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

/* ==================== 阶段性自升级（用户 2026-11-12） ====================
 *
 * 服务端已经把「阶梯 / 当前阶段 / 下一阶段缺什么 / 指标文案 / 历史」全部算好
 * （services/anticheat-upgrade.js::snapshot），这里**只做渲染 + 发动作**。
 * 为什么坚持这个分工：同一份判断要在 Web 与小程序管理端同时显示，
 * 两边各算一次必然漂移出「Web 说已达闸门、小程序说还差 3 条」这种无法解释的分歧。
 */
var lastStages = null;

function renderStages(st) {
  lastStages = st;
  var box = $('stageBox');
  if (!box) return;
  clear(box);
  var tag = $('stageTag');
  if (tag) {
    clear(tag);
    if (st) {
      var off = [];
      if (!st.autoUpgrade) off.push('自动升级已关');
      if (!st.autoDemote) off.push('自动降级已关');
      tag.appendChild(el('span', 'pill ' + (off.length ? 'warn' : 'ok'), off.length ? off.join(' · ') : '自动评估开启'));
    }
  }
  if (!st) { box.appendChild(el('div', 'note', '模型阶段数据加载失败（不影响判定，判定退回无监督）')); return; }

  box.appendChild(el('div', 'note', st.ruleText || ''));

  var srcs = st.sources || {};
  ['werun', 'gps'].forEach(function (key) {
    var s = srcs[key];
    if (!s) return;
    box.appendChild(renderStageSource(key, s, st));
  });
}

function renderStageSource(key, s, st) {
  var wrap = el('div', 'stage-src');

  // ---- 标题行：来源 · 当前阶段 · 模式 · 动作按钮 ----
  var head = el('div', 'stage-head');
  head.appendChild(el('b', 'stage-src-name', s.sourceText));
  head.appendChild(el('span', 'pill ' + (s.stage >= 2 ? 'bad' : s.stage === 1 ? 'warn' : 'mute'), s.stageText));
  if (s.mode === 'manual') head.appendChild(el('span', 'pill warn', '手动锁定'));
  head.appendChild(el('span', 'spacer'));
  if (caps.manage) {
    var btnEval = el('button', 'btn sm pri', '立即评估');
    btnEval.addEventListener('click', function () { evaluateStages(key, btnEval); });
    head.appendChild(btnEval);
    // 手动指定阶段 = 人工兜底（自动评估只写建议、绝不动手动锁定的阶段）
    var btnStage = el('button', 'btn sm', s.mode === 'manual' ? '恢复自动' : '手动指定');
    btnStage.addEventListener('click', function () { toggleManual(key, s, btnStage); });
    head.appendChild(btnStage);
  }
  wrap.appendChild(head);

  // ---- 三级阶梯 ----
  var ladder = el('div', 'stage-ladder');
  var list = s.ladder || [];
  for (var i = 0; i < list.length; i++) {
    var l = list[i];
    var node = el('div', 'stage-step' + (l.current ? ' current' : '') + (l.done ? ' done' : ''));
    node.appendChild(el('b', 'stage-step-t', (l.done ? '✓ ' : '') + l.text));
    node.appendChild(el('div', 'stage-step-d', l.desc));
    if (l.current) node.appendChild(el('span', 'pill ' + (s.stage >= 2 ? 'bad' : 'warn'), '当前阶段'));
    ladder.appendChild(node);
  }
  wrap.appendChild(ladder);

  // ---- 关键数字 ----
  var kvBox = el('div', 'kv-grid stage-kv');
  kvBox.appendChild(kv('可训练标注', fmt(s.sampleCount) + ' 条'));
  kvBox.appendChild(kv('生效阈值', Number(s.threshold.suspicious).toFixed(2) + ' / ' + Number(s.threshold.autoBan).toFixed(2)));
  if (s.metrics) {
    kvBox.appendChild(kv('交叉验证 AUC', s.metrics.aucText + (s.metrics.aucStd != null ? ' ± ' + Number(s.metrics.aucStd).toFixed(2) : '')));
    kvBox.appendChild(kv('可疑线精度', s.metrics.precisionSuspiciousText));
    kvBox.appendChild(kv('封禁线精度', s.metrics.precisionAutoBanText));
    kvBox.appendChild(kv('封禁线召回', s.metrics.recallAutoBanText));
  }
  kvBox.appendChild(kv('影子证据', fmt(s.shadow.samples) + ' 条 / 判可疑 ' + fmt(s.shadow.flaggedSuspicious) +
    ' 条' + (s.shadow.precisionSuspicious == null ? '' : ' · 实测精度 ' + Math.round(s.shadow.precisionSuspicious * 100) + '%')));
  if (s.model) {
    kvBox.appendChild(kv('模型特征', s.model.featureCount + ' 维（' + (s.model.features || []).join('/') + '）'));
  }
  wrap.appendChild(kvBox);

  // ---- 下一阶段：缺什么 / 已达闸门 ----
  if (s.next) {
    var nx = el('div', 'stage-next ' + (s.next.ok ? 'is-ok' : ''));
    nx.appendChild(el('div', 'stage-next-t',
      s.next.ok ? ('已达「' + s.next.targetText + '」闸门' + (st.autoUpgrade ? '——下一轮定时评估会自动升级（也可点「立即评估」）' : '——自动升级已关闭，可手动指定'))
        : ('距「' + s.next.targetText + '」还差：')));
    if (!s.next.ok) {
      for (var m = 0; m < s.next.missing.length; m++) nx.appendChild(el('div', 'stage-miss', '· ' + s.next.missing[m]));
    }
    wrap.appendChild(nx);
  } else {
    wrap.appendChild(el('div', 'stage-next is-ok', '已是最高阶段：有监督模型主判（仍受自动处置总开关约束）'));
  }

  // ---- 降级风险 ----
  if (s.demotion && s.demotion.willDemote) {
    wrap.appendChild(el('div', 'stage-warn', '⚠ 自动降级条件已满足：' + s.demotion.reason));
  } else if (s.demotion && s.demotion.missing && s.demotion.missing.length) {
    wrap.appendChild(el('div', 'note', '降级评估：' + s.demotion.missing.join('；')));
  }

  // ---- 最近一次评估与历史 ----
  if (s.lastEvaluatedAt) {
    wrap.appendChild(el('div', 'note', '上次评估 ' + ago(s.lastEvaluatedAt) + '：' + (s.lastReason || '—')));
  }
  if (s.history && s.history.length) {
    var his = el('div', 'stage-hist');
    his.appendChild(el('div', 'act-t', '阶段变更历史'));
    for (var h = 0; h < s.history.length; h++) {
      var row = s.history[h];
      his.appendChild(el('div', 'stage-hist-row',
        timeText(row.at) + ' · ' + row.fromText + ' → ' + row.toText + ' · ' + (row.operator || 'system') + ' · ' + (row.reason || '')));
    }
    wrap.appendChild(his);
  }
  return wrap;
}

function evaluateStages(key, btn) {
  btn.disabled = true;
  api('/model-evaluate', { method: 'POST', body: { source: key } })
    .then(function (r) {
      btn.disabled = false;
      var res = (r.results && r.results[0]) || {};
      var text = res.action === 'promote' ? ('已升级为「' + (res.nextStage === 2 ? '有监督主判' : '影子辅助') + '」')
        : res.action === 'demote' ? '已自动降级'
        : res.action === 'error' ? ('评估失败：' + res.reason)
        : '维持当前阶段';
      toast(text + (res.reason ? '（' + res.reason + '）' : ''));
      renderStages(r.snapshot);
    })
    .catch(function (e) { btn.disabled = false; toast(e.message || '评估失败', true); });
}

function toggleManual(key, s, btn) {
  if (s.mode === 'manual') {
    btn.disabled = true;
    api('/model-stage', { method: 'PUT', body: { source: key, mode: 'auto' } })
      .then(function (r) { btn.disabled = false; toast('已恢复自动评估'); renderStages(r.snapshot); })
      .catch(function (e) { btn.disabled = false; toast(e.message || '操作失败', true); });
    return;
  }
  // 手动指定：用 confirm 说明「锁定后自动评估只写建议」，避免管理员以为自动还在动它
  var cur = s.stage;
  var plan = prompt(
    '手动指定「' + s.sourceText + '」的阶段（0 无监督 / 1 影子辅助 / 2 有监督主判）。\n' +
    '注意：手动指定后自动评估只给建议、不再改阶段，可随时点「恢复自动」。',
    String(cur)
  );
  if (plan === null) return;
  var stage = Number(plan);
  if (!(stage === 0 || stage === 1 || stage === 2)) { toast('阶段只能是 0 / 1 / 2', true); return; }
  btn.disabled = true;
  api('/model-stage', { method: 'PUT', body: { source: key, stage: stage } })
    .then(function (r) { btn.disabled = false; toast('已手动指定并锁定阶段'); renderStages(r.snapshot); })
    .catch(function (e) { btn.disabled = false; toast(e.message || '操作失败', true); });
}

function renderRecent(bans) {
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
  // 排序 / 步数 / 距离三个下拉（选项是 index.html 里的静态 option，CSP 下不允许内联事件，
  // change 监听在 bindEvents 里挂一次）—— 这里只负责把当前 query 回填到控件，轮询重画后不串位
  $('selSort').value = query.sort;
  $('selSteps').value = query.minSteps;
  $('selDist').value = query.minDistance;
}

function loadList() {
  buildSegments();
  var qs =
    '?status=' + encodeURIComponent(query.status) +
    '&source=' + encodeURIComponent(query.source) +
    '&label=' + encodeURIComponent(query.label) +
    '&sort=' + encodeURIComponent(query.sort || 'score') +
    '&minSteps=' + encodeURIComponent(query.minSteps || '') +
    '&minDistance=' + encodeURIComponent(query.minDistance || '') +
    '&keyword=' + encodeURIComponent(query.keyword) +
    '&page=' + encodeURIComponent(query.page) +
    '&limit=' + encodeURIComponent(listLimit);
  api('/anomalies' + qs)
    .then(function (d) {
      if (d.labelText) LABEL_TEXT = d.labelText;
      if (d.labelKinds && d.labelKinds.length) LABEL_KINDS = d.labelKinds;
      listLimit = d.limit || listLimit;
      lastList = d.list || [];
      renderList(lastList);
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

// 最近一次列表数据（展开/收起只用缓存重画，不再发请求）
var lastList = [];
// 默认**全部展开**（用户 2026-11-03「不用非得折叠，默认展开方便快捷操作」）：
// collapsed 记录的是「被手动收起」的 id，点击行切换收起/展开。
var collapsed = {};
// 全展开后单页详情面板很长，默认页大小从 30 收到 15（分页仍可翻）
var listLimit = 15;

function renderList(list) {
  var box = $('listBox');
  clear(box);
  if (!list.length) { box.appendChild(el('div', 'note', '这个筛选条件下没有记录')); return; }
  var table = el('div', 'tbl');
  // 表头是纯静态文案（不含服务端数据）
  var head = el('div', 'tbl-head');
  head.appendChild(el('span', 'c-who', '学生'));
  head.appendChild(el('span', 'c-src', '来源'));
  head.appendChild(el('span', 'c-size', '步数 / 距离'));
  head.appendChild(el('span', 'c-score', '分数（疑 / AI）'));
  head.appendChild(el('span', 'c-label', '标注'));
  head.appendChild(el('span', 'c-status', '状态'));
  head.appendChild(el('span', 'c-op', ''));
  table.appendChild(head);
  for (var i = 0; i < list.length; i++) table.appendChild(renderItem(list[i]));
  box.appendChild(table);
}

function kv(k, v) {
  var n = el('div', 'kv');
  n.appendChild(el('span', '', k));
  n.appendChild(el('b', '', v));
  return n;
}

// 配速秒数 → 12'03" 文本
function paceText(secPerKm) {
  var v = Number(secPerKm);
  if (!v || v <= 0 || !isFinite(v)) return '—';
  var m = Math.floor(v / 60);
  var ss = Math.round(v % 60);
  return m + "'" + (ss < 10 ? '0' + ss : ss) + '"';
}
// m/s → km/h 文本（保留一位）
function kmh(mps) {
  var v = Number(mps);
  if (!v || v <= 0) return '—';
  return (v * 3.6).toFixed(1) + ' km/h';
}
function num2(v) { var n = Number(v); return isFinite(n) ? n.toFixed(2) : '—'; }
// 秒 → 18'22" / 1:02:03（不再裸发 "1234s"，用户 2026-11-03「时长等详细信息没有显示」）
function durText(sec) {
  var v = Math.round(Number(sec) || 0);
  if (v <= 0) return '—';
  var h = Math.floor(v / 3600);
  var m = Math.floor((v % 3600) / 60);
  var s = v % 60;
  if (h > 0) return h + ':' + pad2(m) + ':' + pad2(s);
  return m + "'" + pad2(s) + '"';
}

/** 行尾状态徽标：把「标注了但还没处置」显式表达出来（用户 2026-11-03） */
function statusPill(r) {
  if (r.status === 'banned') return { cls: 'pill bad', text: r.autoBanned ? '已封禁 · 系统' : '已封禁' };
  if (r.status === 'dismissed') return { cls: 'pill mute', text: '已排除' };
  if (r.label === 'cheat' || r.label === 'minor') return { cls: 'pill warn', text: '已判定 · 待处置' };
  return { cls: 'pill warn', text: '待研判' };
}

// 紧凑表格行（用户 2026-11-03「简约 B 端」）：一行一条线索，详情默认展开（点击行收起）。
function renderItem(r) {
  var wrap = el('div', 'tbl-wrap');
  var open = !collapsed[r.id];

  var row = el('div', 'tbl-row' + (open ? ' open' : ''));
  var who = el('span', 'c-who');
  who.appendChild(el('b', '', r.realName));
  who.appendChild(el('small', '', [r.className, r.studentId, r.date].filter(Boolean).join(' · ')));
  row.appendChild(who);
  row.appendChild(el('span', 'c-src', r.sourceText));

  // 数据量列（与 sort=size / 步数·距离筛选同一口径）：微信同步看当日步数，GPS 看距离。
  // 没有这一列，「步数/距离大优先」的排序依据就看不见了。
  var size = el('span', 'c-size');
  if (r.source === 'gps') {
    var distM = Number(r.features && r.features.distance) || 0;
    size.appendChild(el('b', 'num', distM > 0 ? (distM / 1000).toFixed(1) : '—'));
    if (distM > 0) size.appendChild(el('small', '', ' km'));
  } else {
    size.appendChild(el('b', 'num', fmt(r.cumulativeSteps)));
    size.appendChild(el('small', '', ' 步'));
  }
  row.appendChild(size);

  var score = el('span', 'c-score');
  score.appendChild(el('b', 'num', fmt(r.score)));
  score.appendChild(el('small', 'num', r.modelScore == null ? 'AI —' : 'AI ' + Number(r.modelScore).toFixed(2)));
  row.appendChild(score);

  var labCell = el('span', 'c-label');
  var labCls = !r.label ? 'pill mute' : r.label === 'normal' ? 'pill ok' : r.label === 'device' ? 'pill mute' : 'pill bad';
  labCell.appendChild(el('span', labCls, r.labelText || '未标注'));
  row.appendChild(labCell);

  var st = statusPill(r);
  var stCell = el('span', 'c-status');
  stCell.appendChild(el('span', st.cls, st.text));
  if (r.autoBanned && r.status === 'banned') stCell.appendChild(el('span', 'pill bad', 'AI'));
  row.appendChild(stCell);

  var op = el('span', 'c-op');
  op.appendChild(el('span', 'c-arr', open ? '▾' : '▸'));
  row.appendChild(op);

  row.addEventListener('click', function () {
    if (collapsed[r.id]) delete collapsed[r.id];
    else collapsed[r.id] = true;
    renderList(lastList); // 只用缓存重画，不发请求
  });
  wrap.appendChild(row);

  if (open) wrap.appendChild(buildDetail(r));
  return wrap;
}

/** 展开后的详情面板：指标 + GPS 路线图 + 理由 + 分组的判定/处置动作 */
function buildDetail(r) {
  var det = el('div', 'det');
  var main = el('div', 'det-main');
  var metrics = el('div', 'kv-grid');

  if (r.source !== 'gps') {
    metrics.appendChild(kv('当日步数', fmt(r.cumulativeSteps)));
    metrics.appendChild(kv('本次新增', fmt(r.deltaSteps)));
    metrics.appendChild(kv('同步时间', timeText(r.createdAt)));
    metrics.appendChild(kv('可疑分', fmt(r.score) + ' / 100'));
    metrics.appendChild(kv('AI 分', r.modelScore == null ? '—' : Number(r.modelScore).toFixed(3)));
    if (r.labeledBy) metrics.appendChild(kv('标注人', r.labeledBy + '（' + ago(r.labeledAt) + '）'));
    main.appendChild(metrics);
  } else {
    // GPS：先按判定快照（features）立刻出数，再懒加载轨迹接口补路线图与权威指标。
    var routeBox = el('div', 'route-box');
    routeBox.appendChild(el('div', 'route-loading', '轨迹加载中…'));
    var refresh = function (d) {
      clear(metrics);
      var m = (d && d.metrics) || null;
      var f = (d && d.features) || r.features || {};
      metrics.appendChild(kv('峰值速度', kmh(m && m.peakSpeed != null ? m.peakSpeed : f.peakSpeed)));
      metrics.appendChild(kv('平均速度', kmh(m && m.avgSpeed != null ? m.avgSpeed : f.speed)));
      metrics.appendChild(kv('配速', paceText(m && m.avgPaceSecPerKm != null ? m.avgPaceSecPerKm : f.paceSecPerKm) + '/km'));
      metrics.appendChild(kv('距离', fmt(Math.round((d && d.distance) || f.distance || 0)) + ' m'));
      metrics.appendChild(kv('时长', durText((d && d.durationSeconds) || f.duration)));
      metrics.appendChild(kv('轨迹点', fmt((m && m.pointCount) || f.pointCount || 0)));
      metrics.appendChild(kv('上传时间', timeText(r.createdAt)));
      metrics.appendChild(kv('可疑分', fmt(r.score) + ' / 100'));
      metrics.appendChild(kv('AI 分', r.modelScore == null ? '—' : Number(r.modelScore).toFixed(3)));
      if (r.labeledBy) metrics.appendChild(kv('标注人', r.labeledBy + '（' + ago(r.labeledAt) + '）'));
    };
    refresh(null);
    main.appendChild(metrics);
    main.appendChild(routeBox);
    loadRoute(r, routeBox, refresh);
  }
  det.appendChild(main);

  // 微信同步：当日逐次同步 + 增速历史（用户 2026-11-03「同步增速这种我要看历史增速的判断」）
  if (r.source !== 'gps') det.appendChild(buildSyncHistory(r));

  // GPS 轨迹质量（判定快照）：脚本/瞬移的特征藏在这里
  if (r.source === 'gps' && r.features) {
    var q = el('div', 'kv-grid det-quality');
    q.appendChild(kv('点间隔均值', num2((r.features.gapAvg || 0) / 1000) + 's'));
    q.appendChild(kv('最大间隔', num2((r.features.gapMax || 0) / 1000) + 's'));
    q.appendChild(kv('平滑度', num2(r.features.jitter)));
    det.appendChild(q);
  }

  var rs = el('div', 'reasons');
  var reasons = r.reasons || [];
  if (!reasons.length) rs.appendChild(el('span', '', '无附加理由'));
  for (var i = 0; i < reasons.length; i++) rs.appendChild(el('span', '', reasons[i]));
  det.appendChild(rs);
  if (r.handleNote) det.appendChild(el('div', 'note', '处置备注：' + r.handleNote));

  // ===== 动作区：判定 / 处置 两组分开 =====
  // （用户 2026-11-03「标记为轻微违规并没有处置，处置和标记是两码事，UI 理解不了」：
  //   正交设计保持不变，但界面上必须把「谁动训练集、谁动学生」说清楚。）
  var acts = el('div', 'det-acts');

  var g1 = el('div', 'act-group');
  g1.appendChild(el('div', 'act-t', '① 判定 · 喂 AI 训练（不动学生账号）'));
  if (r.status === 'open') {
    if (caps.label) {
      var b1 = el('div', 'act-btns');
      for (var k = 0; k < LABEL_KINDS.length; k++) {
        (function (id, kind, current) {
          var btn = el('button', 'btn sm' + (current === kind ? ' pri' : ''), LABEL_TEXT[kind]);
          btn.addEventListener('click', function () { labelIt(id, kind, btn); });
          b1.appendChild(btn);
        })(r.id, LABEL_KINDS[k], r.label);
      }
      g1.appendChild(b1);
      g1.appendChild(el('div', 'act-note', '标「正常 / 设备网络」= 无需处置，移出队列；标「作弊 / 轻微违规」= 留在队列等处置。'));
    } else {
      g1.appendChild(el('div', 'act-note', '需要 anticheat.label 权限才能标注。'));
    }
    acts.appendChild(g1);
  }

  if (r.status === 'open' && (caps.ban || caps.label)) {
    var g2 = el('div', 'act-group');
    g2.appendChild(el('div', 'act-t', '② 处置 · 处理这条线索（对学生生效）'));
    var b2 = el('div', 'act-btns');
    if (caps.ban) {
      var bb = el('button', 'btn sm danger', '封禁…');
      bb.addEventListener('click', function () { openBan(r); });
      b2.appendChild(bb);
    }
    if (caps.label) {
      var ab = el('button', 'btn sm', '归档 · 不封禁');
      ab.addEventListener('click', function () { archiveIt(r.id, ab); });
      b2.appendChild(ab);
    }
    g2.appendChild(b2);
    g2.appendChild(el('div', 'act-note', '封禁 = 限制学生账号（天数可调）；归档 = 记录违规但不限制，移出队列。'));
    acts.appendChild(g2);
  }

  if (!acts.childNodes.length) {
    acts.appendChild(el('div', 'act-note', r.status === 'open'
      ? '你只有查看权限（anticheat.view），不能标注或处置。'
      : '该记录已处理完毕（解封走学生申诉或管理端用户页）。'));
  }
  det.appendChild(acts);
  return det;
}

/** GPS 轨迹懒加载：详情展开时才取（列表接口不带轨迹，数据量太大） */
function loadRoute(r, routeBox, refreshMetrics) {
  api('/anomalies/' + encodeURIComponent(r.id) + '/gps')
    .then(function (d) {
      drawRoute(routeBox, d);
      refreshMetrics(d);
    })
    .catch(function (e) {
      clear(routeBox);
      routeBox.appendChild(el('div', 'route-none', '轨迹数据加载失败（' + (e.message || '网络异常') + '）'));
    });
}

var SVG_NS = 'http://www.w3.org/2000/svg';
var ROUTE_SRC_TEXT = {
  run_record: '原始跑步记录',
  legacy_match: '当天就近匹配的跑步记录',
  snapshot: '判定时的轨迹快照',
};

/** 画轨迹（内联 SVG，createElementNS 生成 —— CSP 下安全，无外部资源） */
function drawRoute(box, d) {
  clear(box);
  var pts = (d && d.points) || [];
  var bounds = d && d.bounds;
  if (!pts.length || pts.length < 2 || !bounds) {
    box.appendChild(el('div', 'route-none', '无轨迹数据（旧记录未存轨迹快照，且匹配不到当天的跑步记录）'));
    return;
  }
  var spanLat = bounds.maxLat - bounds.minLat;
  var spanLng = bounds.maxLng - bounds.minLng;
  var padLat = Math.max(spanLat * 0.1, 0.0004);
  var padLng = Math.max(spanLng * 0.1, 0.0004);
  // 纬度向北增大而 SVG 的 y 向下：用 (max+min−lat) 翻转，不改坐标本身
  var y0 = bounds.maxLat + bounds.minLat;

  var svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'route-svg');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('viewBox',
    (bounds.minLng - padLng) + ' ' + (y0 - bounds.maxLat - padLat) + ' ' +
    (spanLng + padLng * 2) + ' ' + (spanLat + padLat * 2));

  var line = document.createElementNS(SVG_NS, 'polyline');
  var coords = [];
  for (var i = 0; i < pts.length; i++) coords.push(pts[i].lng + ',' + (y0 - pts[i].lat));
  line.setAttribute('points', coords.join(' '));
  line.setAttribute('class', 'route-line');
  svg.appendChild(line);

  // 起终点圆点：半径随包围盒等比缩放（viewBox 单位是「度」）
  var r0 = (spanLng + padLng * 2) * 0.014;
  var mkDot = function (p, cls) {
    var c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', p.lng);
    c.setAttribute('cy', y0 - p.lat);
    c.setAttribute('r', r0);
    c.setAttribute('class', cls);
    svg.appendChild(c);
  };
  mkDot(pts[0], 'route-start');
  mkDot(pts[pts.length - 1], 'route-end');

  box.appendChild(svg);
  if (ROUTE_SRC_TEXT[d.dataSource]) {
    box.appendChild(el('div', 'route-cap', '路线图数据源：' + ROUTE_SRC_TEXT[d.dataSource] + ' · 绿点起点 · 橙点终点'));
  }
}

/** 当日同步历史（增速研判）：详情渲染时懒加载，与判定同源重算 */
function buildSyncHistory(r) {
  var box = el('div', 'sync-hist');
  box.appendChild(el('div', 'act-t', '当日同步历史（增速研判）'));
  var body = el('div', 'sync-hist-body', '同步历史加载中…');
  box.appendChild(body);
  api('/anomalies/' + encodeURIComponent(r.id) + '/sync-history')
    .then(function (d) { renderSyncHistory(body, d); })
    .catch(function (e) {
      body.textContent = '同步历史加载失败（' + (e.message || '网络异常') + '）';
    });
  return box;
}

function renderSyncHistory(body, d) {
  clear(body);
  var rows = d && d.rows ? d.rows : [];
  if (!rows.length) {
    body.textContent = '当天没有留存的同步记录（零增量的同步不落库）';
    return;
  }
  var head = el('div', 'sh-row sh-head');
  head.appendChild(el('span', '', '时间'));
  head.appendChild(el('span', 'r', '新增'));
  head.appendChild(el('span', 'r', '距上次'));
  head.appendChild(el('span', 'r', '增速'));
  body.appendChild(head);

  for (var i = 0; i < rows.length; i++) {
    var h = rows[i];
    var fast = h.perSec != null && Number(h.perSec) >= 15;
    var row = el('div', 'sh-row' + (h.short ? ' sh-short' : fast ? ' sh-fast' : ''));
    var t = new Date(h.at);
    if (isNaN(t.getTime())) {
      row.appendChild(el('span', 'num', '—'));
    } else {
      // 跨日补同步的行带日期前缀（服务端 dayText）——只显示时分秒会把次日的记录
      // 伪装成「当日更晚时分」，看起来像时间倒流（用户 2026-11-04）
      var timeStr = pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds());
      row.appendChild(el('span', 'num', h.dayText ? h.dayText + ' ' + timeStr : timeStr));
    }
    row.appendChild(el('span', 'r num', fmt(h.steps)));
    row.appendChild(el('span', 'r num', h.intervalSec == null ? '—' : durText(h.intervalSec)));
    // 窗口过短不给增速数字（判定也不看它）；首条没有前日参照时为 null
    row.appendChild(el('span', 'r num', h.short ? '窗口短' : h.perSec == null ? '—' : Number(h.perSec).toFixed(1) + ' 步/秒'));
    body.appendChild(row);
  }

  var s = (d && d.summary) || {};
  var cap =
    '当日 ' + fmt(s.syncs) + ' 次同步 · 高增速(≥15步/秒) ' + fmt(s.fastSyncs) +
    ' 次 · 口径：与判定同源；1 小时内多次同步合并为一条，间隔<3分钟不判增速';
  // 跨日补同步说明（文案服务端拼好下发，前端只搬运）
  if (s.crossDayText) cap += ' · ' + s.crossDayText;
  body.appendChild(el('div', 'route-cap', cap));
}

function labelIt(id, kind, btn) {
  btn.disabled = true;
  api('/anomalies/' + encodeURIComponent(id) + '/label', { method: 'POST', body: { label: kind } })
    .then(function (r) {
      // 必须说明「移出还是留下」（用户 2026-11-02「标注后依然显示待研判」）
      var dest = r.status === 'dismissed' ? '移出待研判'
        : r.status === 'banned' ? '已封禁'
        : '待处置（封禁或归档）';
      toast('已判定「' + (r.labelText || LABEL_TEXT[kind]) + '」→ ' + dest + (r.trainable ? '' : ' · 不进训练集'));
      loadList();
    })
    .catch(function (e) {
      btn.disabled = false;
      toast(e.message || '标注失败', true);
    });
}

/** 归档 = 记录违规、不封禁、移出队列（轻微违规的处置去向，用户 2026-11-03） */
function archiveIt(id, btn) {
  btn.disabled = true;
  api('/anomalies/' + encodeURIComponent(id) + '/archive', { method: 'POST', body: {} })
    .then(function () {
      toast('已归档（记录违规 · 不封禁）→ 移出待研判');
      loadList();
    })
    .catch(function (e) {
      btn.disabled = false;
      toast(e.message || '归档失败', true);
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

  // ===== 阶段性自升级开关（用户 2026-11-12）=====
  // 关掉 autoUpgrade/autoDemote 后：定时评估照跑、指标照更新，只是不改阶段。
  // 文案必须写清这一点，否则管理员会以为「关掉就不评估了」。
  var ub = $('autoUpgradeBox');
  clear(ub);
  var au = el('div', 'row-item');
  au.appendChild(el('div', 'ri-head', '自动升降级：' + (d.autoUpgrade ? '升级开' : '升级关') + ' · ' + (d.autoDemote ? '降级开' : '降级关')));
  au.appendChild(el('div', 'note', '关掉后评估仍会定时跑并更新指标，"已达闸门"照样显示，只是不自动改阶段（可到状态台手动指定）。'));
  var row2 = el('div', 'acts');
  var bUp = el('button', 'btn sm' + (d.autoUpgrade ? '' : ' pri'), d.autoUpgrade ? '关闭自动升级' : '开启自动升级');
  bUp.addEventListener('click', function () { saveCfg({ autoUpgrade: !d.autoUpgrade }); });
  var bDown = el('button', 'btn sm' + (d.autoDemote ? '' : ' pri'), d.autoDemote ? '关闭自动降级' : '开启自动降级');
  bDown.addEventListener('click', function () { saveCfg({ autoDemote: !d.autoDemote }); });
  row2.appendChild(bUp); row2.appendChild(bDown);
  au.appendChild(row2);
  ub.appendChild(au);
}

function saveCfg(patch) {
  api('/model-config', { method: 'PUT', body: patch })
    .then(function (r) {
      var keys = Object.keys((r && r.changed) || {});
      toast('已保存：' + (keys.length ? keys.join(' / ') : '无变化'));
      loadCfg();
      // 自升级开关变了 → 状态台的阶段卡片也要跟着刷新（它展示开关状态）
      if (lastStages) loadDash();
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

  // 排序 / 数据量筛选（选项在 index.html 静态写好，这里只挂事件）
  $('selSort').addEventListener('change', function () { query.sort = this.value; query.page = 1; loadList(); });
  $('selSteps').addEventListener('change', function () { query.minSteps = this.value; query.page = 1; loadList(); });
  $('selDist').addEventListener('change', function () { query.minDistance = this.value; query.page = 1; loadList(); });

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
