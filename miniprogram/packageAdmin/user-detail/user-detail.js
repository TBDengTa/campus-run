const auth = require('../../utils/request');
const fmt = require('../../utils/format');

function fmtTime(v) {
  return v ? String(v).slice(0, 16).replace('T', ' ') : '';
}

// 日期 → 「M月D日」
function dateText(dateKey) {
  if (!dateKey) return '';
  return `${Number(dateKey.slice(5, 7))}月${Number(dateKey.slice(8, 10))}日`;
}

// 运动明细每页条数（按钮翻页）
const PAGE_SIZE = 10;

// 页码条：页数少时全列，多时首尾 + 当前页附近，间隔用省略号
function buildPageItems(current, total) {
  const out = [];
  const push = (page, label) => out.push({ k: `${page}-${out.length}`, page, label: label || String(page) });
  if (total <= 7) {
    for (let i = 1; i <= total; i += 1) push(i);
    return out;
  }
  push(1);
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) push(0, '…');
  for (let i = start; i <= end; i += 1) push(i);
  if (end < total - 1) push(0, '…');
  push(total);
  return out;
}

// 班名前缀推年级：'25大数据与会计' → '2025'；'23级机电1班' → '2023'（与 roster 口径一致）
function gradeOfClassName(name) {
  const m = String(name || '').match(/^(\d{2,4})/);
  if (!m) return '';
  const n = Number(m[1]);
  if (m[1].length === 4) return n >= 1900 && n <= 2099 ? String(n) : '';
  return n >= 0 && n <= 99 ? String(2000 + n) : '';
}

// ===== 徽章发放抽屉：定义 → 抽屉行 =====
// 条件类型中文（与 services/badges.js 的达成条件一一对应，仅用于抽屉副标题展示）
const BADGE_TYPE_TEXT = {
  total_steps: '累计步数',
  total_distance: '累计距离',
  total_days: '累计打卡',
  goal_days: '达标天数',
  single_steps: '单日步数',
  single_distance: '单次距离',
  streak_days: '连续打卡',
  points: '累计跑分',
  rank: '跑分总榜',
};

// 徽章定义 → 可读的达成条件（如「累计步数 · 100,000 步」「跑分总榜 · 前 100 名」）
function badgeDesc(def) {
  const label = BADGE_TYPE_TEXT[def.type] || '';
  const target = fmt.formatNumber(def.target || 0);
  if (!label) return def.description || '';
  if (def.type === 'rank') return `${label} · 前 ${target} 名`;
  if (def.type === 'total_distance' || def.type === 'single_distance') return `${label} · ${target} 米`;
  if (def.type === 'total_days' || def.type === 'goal_days' || def.type === 'streak_days') return `${label} · ${target} 天`;
  if (def.type === 'points') return `${label} · ${target} 分`;
  return `${label} · ${target} 步`;
}

// 定义列表 → 抽屉行：独立徽章一行；等级徽章（同 tierGroup）折叠成一组，组内按 tierLevel 排级别
//   prevItems 用于保留「上一轮哪些组是展开的」（发放后刷新数据不收起已展开的组）
function buildBadgeItems(definitions, prevItems) {
  const expanded = {};
  (prevItems || []).forEach((it) => {
    if (it.kind === 'group') expanded[it.tierGroup] = !!it.expanded;
  });
  const singles = [];
  const groups = new Map();
  for (const d of definitions || []) {
    const g = String(d.tierGroup || '').trim();
    if (g) {
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(d);
    } else {
      singles.push(d);
    }
  }
  const entries = [];
  singles.forEach((d) => {
    entries.push({
      sort: Number(d.sort) || 0,
      item: {
        k: `s:${d.key}`,
        kind: 'single',
        key: d.key,
        name: d.name,
        icon: d.icon || '',
        tierColor: d.tierColor || '',
        desc: badgeDesc(d),
        earned: !!d.earned,
      },
    });
  });
  groups.forEach((list, g) => {
    const levels = [...list].sort((a, b) => (Number(a.tierLevel) || 0) - (Number(b.tierLevel) || 0));
    const rows = levels.map((d) => ({
      key: d.key,
      name: d.name,
      icon: d.icon || '',
      tierColor: d.tierColor || '',
      desc: `Lv${Number(d.tierLevel) || 0} · ${badgeDesc(d)}`,
      earned: !!d.earned,
    }));
    entries.push({
      sort: Math.min(...levels.map((d) => Number(d.sort) || 0)),
      item: {
        k: `g:${g}`,
        kind: 'group',
        tierGroup: g,
        name: g,
        desc: badgeDesc(levels[0]),
        levelCount: rows.length,
        earnedCount: rows.filter((r) => r.earned).length,
        expanded: !!expanded[g],
        levels: rows,
      },
    });
  });
  entries.sort((a, b) => a.sort - b.sort);
  return entries.map((e) => e.item);
}

// 在抽屉行里按 badgeKey 找目标（独立徽章直接命中；等级徽章命中组内某一级）
function findBadgeItem(items, key) {
  for (const it of items || []) {
    if (it.kind === 'single' && it.key === key) return it;
    if (it.kind === 'group') {
      const hit = (it.levels || []).find((lv) => lv.key === key);
      if (hit) return hit;
    }
  }
  return null;
}

Page({
  data: {
    id: '',
    user: null,
    bans: [],
    loading: true,
    // ===== 视角（管理端 / 班级域）=====
    scope: 'admin', // admin | class
    readonlyScope: false, // 班级域打开时是否为只读降级视图（管理权限不足才会走到这里）
    className: '',
    classOnly: false, // true = 用班级域数据渲染（无管理权限的班主任 / 班委）
    classMissing: false, // 班级域回退也拿不到该生数据
    classInfo: null, // 班级域的今日 / 本周摘要
    fallbackName: '',
    isTeacherUser: false, // 目标账号是教师：不展示运动 / 跑分 / 考核内容
    isSuper: false,
    // 当前登录者权限：编辑资料/重置密码/删除账户需 permission.manage，解绑微信需 user.manage
    canManagePerms: false,
    canManageUser: false,
    // 徽章发放 / 回收需 badge.manage（服务端 requirePermission('badge.manage') 同步拦，前端只控显隐）
    canManageBadges: false,
    // 当前生效的限制（限制登录 / 限制微信同步 / 限制 GPS）
    restrictions: [],
    // 「限制账号功能」抽屉
    banSheet: { visible: false, user: null, busy: false },
    // ===== 考核与运动全景 =====
    rates: null,
    goal: null,
    // 跑分汇总（{ totalText, todayText, weekText, enabled, configText }）
    points: null,
    recordTab: 'daily', // 最近运动 runs | 日记录 daily | 周记录 weekly | 饮水 water | 徽章 badges
    // 运动明细：按 Tab 分页缓存（每页 PAGE_SIZE 条，按钮翻页，不是触底追加）
    records: { runs: [], daily: [], weekly: [], water: [], badges: [] },
    recordPages: { runs: 1, daily: 1, weekly: 1, water: 1, badges: 1 }, // 各 Tab 记忆自己的页码
    recordTotals: { runs: 0, daily: 0, weekly: 0, water: 0, badges: 0 },
    recordPage: 1,
    recordPagesTotal: 1,
    recordTotal: 0,
    pageItems: [], // 页码条：[{ k, label, page }]
    recordLoading: false,
    loginInfo: null,
    unbinding: false,
    // ===== 班级身份（班主任班级 / 班委，需 user.manage）=====
    canManageClass: false,
    homeroomClasses: [], // 教师：已分配的班主任班级（多选）
    isClassOfficer: false, // 学生：是否班委
    classSheetVisible: false,
    classOptions: [], // 班级候选（/api/admin/users/filters 的 classes → [{label,value}]）
    classMeta: [], // 每班 { className, grade, departmentName, schoolName }
    classFiltered: [], // 应用筛选后真正渲染的候选
    classKeyword: '',
    classSchool: '',
    classDept: '',
    classGrade: '',
    classSchoolRange: ['全部院系'],
    classDeptRange: ['全部系部'],
    classGradeRange: ['全部年级'],
    classSchoolIndex: 0,
    classDeptIndex: 0,
    classGradeIndex: 0,
    classDraft: [],
    classSaving: false,
    officerSaving: false,
    // ===== 徽章发放抽屉（需 badge.manage）=====
    badgeSheetVisible: false,
    badgeSheetLoading: false,
    badgeItems: [], // [{ kind:'single'|'group', ... }]（等级组可展开选级别）
    badgeGranting: '', // 正在发放的 badgeKey（防连点）
  },

  onLoad(options) {
    const scope = options.scope === 'class' ? 'class' : 'admin';
    this.setData({
      id: options.id || '',
      scope,
      readonlyScope: scope === 'class',
      className: options.className ? decodeURIComponent(options.className) : '',
      fallbackName: options.name ? decodeURIComponent(options.name) : '',
    });
    this.load();
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const me = (getApp().globalData.userInfo || {}).effectivePermissions || [];
      this.setData({
        canManagePerms: me.includes('*') || me.includes('permission.manage'),
        canManageUser: me.includes('*') || me.includes('user.manage'),
        // 班级身份（班主任班级 / 班委）在本页分配，需 user.manage
        canManageClass: me.includes('*') || me.includes('user.manage'),
        // 徽章发放 / 回收：独立权限项 badge.manage（不与 content.manage 复用）
        canManageBadges: me.includes('*') || me.includes('badge.manage'),
      });
      // 班级域打开时：先按管理端权限取资料（有权限 → 与管理面板完全一致）；
      // 无权限（403）才降级为班级域只读数据，绝不绕过服务端权限
      let detail = null;
      try {
        detail = await auth.get(`/api/admin/users/${this.data.id}`);
      } catch (e) {
        if (this.data.scope !== 'class') throw e;
        detail = null;
      }
      if (!detail) {
        await this.loadClassScope();
        return;
      }
      const [sportDetail] = await Promise.all([
        auth.get(`/api/admin/users/${this.data.id}/sport-detail`).catch(() => null),
      ]);
      const { user, bans, sport: sportArg, goal: goalArg, loginInfo, restrictions } = detail;
      const SCOPE_TEXT = { login: '限制登录', sync: '限制微信同步', gps: '限制 GPS', manual: '限制登录' };
      // 限制类型对应图标（在 JS 里算好：WXML 的三元表达式会让静态检查把 'sync' 当成图标名）
      const SCOPE_ICON = { login: 'lock-on', sync: 'logo-wechat-stroke', gps: 'location' };
      const recentRuns = ((sportArg && sportArg.recentRuns) || []).map((r) => ({
        ...r,
        dateText: dateText(r.date),
        distanceText: fmt.formatDistance(r.distance),
        durationText: fmt.formatDuration(r.durationSeconds),
        sourceText: r.source === 'gps' ? 'GPS 实跑' : '微信运动',
      }));

      const rates = sportDetail && sportDetail.rates;
      const goal = (sportDetail && sportDetail.goal) || goalArg || null;
      // 跑分汇总（学校衡量标准）：total 全历史 / today 今日 / week 本周（周一起）
      const pts = (sportDetail && sportDetail.points) || null;
      this.setData({
        loading: false,
        // 目标账号是教师：教师不参与运动记录与排名 → 隐藏运动 / 跑分 / 考核内容（班级身份与账号操作保留）
        isTeacherUser: user.role === 'teacher',
        classOnly: false,
        classMissing: false,
        classInfo: null,
        isSuper: (user.permissionGroups || []).includes('superadmin'),
        homeroomClasses: user.homeroomClasses || [],
        isClassOfficer: !!user.isClassOfficer,
        user: {
          ...user,
          createdText: fmtTime(user.createdAt),
          bannedUntilText: user.bannedUntil ? user.bannedUntil.slice(0, 16).replace('T', ' ') : '',
        },
        bans: bans.map((b) => ({
          ...b,
          timeText: fmtTime(b.createdAt),
          typeText: SCOPE_TEXT[b.banType] || (b.banType === 'manual' ? '限制登录' : '功能限制'),
        })),
        restrictions: (restrictions || []).map((r) => ({
          ...r,
          icon: SCOPE_ICON[r.scope] || 'lock-on',
          untilText: r.until ? fmtTime(r.until) : '永久',
        })),
        sport: {
          totalStepsText: fmt.formatNumber(user.totalSteps || 0),
          totalDistanceText: fmt.formatDistance(user.totalDistance || 0),
          totalDays: user.totalDays || 0,
          badgeCount: (sportArg && sportArg.badgeCount) || 0,
          waterToday: (sportArg && sportArg.waterToday) || { total: 0, target: 0 },
          recentRuns,
        },
        rates: rates
          ? {
              dailyRateText: rates.dailyRate == null ? '—' : `${rates.dailyRate}%`,
              weeklyRateText: rates.weeklyRate == null ? '—' : `${rates.weeklyRate}%`,
              dailyText: rates.dailyTotal ? `达标 ${rates.dailyAchieved} / ${rates.dailyTotal} 天` : '暂无记录',
              weeklyText: rates.weeklyTotal ? `达标 ${rates.weeklyAchieved} / ${rates.weeklyTotal} 周` : '暂无记录',
            }
          : null,
        goal: goal
          ? {
              planName: goal.planName || '默认目标',
              dailyStepsText: fmt.formatNumber(goal.daily && goal.daily.steps),
              weeklyStepsText: fmt.formatNumber(goal.weekly && goal.weekly.steps),
            }
          : null,
        points: pts
          ? {
              totalText: fmt.formatNumber(pts.total || 0),
              todayText: fmt.formatNumber(pts.today || 0),
              weekText: fmt.formatNumber(pts.week || 0),
              enabled: !pts.config || pts.config.enabled !== false,
              configText: pts.config
                ? `日目标 +${pts.config.dailyGoal} · 周目标 +${pts.config.weeklyGoal} · 超出日目标后每再多达成个人目标的 ${pts.config.extraPercent}% 加 ${pts.config.perStepScore} 分（单日上限 +${pts.config.dailyExtraCap}）`
                : '',
            }
          : null,
        // 明细列表改由 /:id/records 分页加载（见 loadRecords），这里不再接收全量
        loginInfo: loginInfo
          ? {
              ...loginInfo,
              wechatBoundAtText: fmtTime(loginInfo.wechatBoundAt),
              lastLoginText: fmtTime(loginInfo.lastLogin),
              lastWxSessionText: fmtTime(loginInfo.lastWxSessionAt),
              lastSyncText: fmtTime(loginInfo.lastSyncAt),
              devices: (loginInfo.devices || []).map((d) => ({
                ...d,
                lastUsedText: fmtTime(d.lastUsedAt || d.createdAt),
                expireText: d.revoked ? '已吊销' : fmtTime(d.expiresAt) + ' 过期',
              })),
            }
          : null,
        // 换用户时清空明细分页缓存，随后按当前 Tab 拉第一页
        records: { runs: [], daily: [], weekly: [], water: [], badges: [] },
        recordPages: { runs: 1, daily: 1, weekly: 1, water: 1, badges: 1 },
        recordTotals: { runs: 0, daily: 0, weekly: 0, water: 0, badges: 0 },
        recordPage: 1,
        recordPagesTotal: 1,
        recordTotal: 0,
        pageItems: [],
      });
      this.loadRecords(this.data.recordTab, 1);
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  // ===== 班级域只读视图（scope=class 且无管理端权限：班主任 / 班委）=====
  // 数据只用 /api/class/*（服务端成员资格校验、只读），不出现任何写操作
  async loadClassScope() {
    const { id, className, fallbackName } = this.data;
    const cls = className || '';
    let row = null;
    try {
      const res = await auth.get('/api/class/students', { className: cls, keyword: id, page: 1, limit: 5 });
      const list = (res && res.list) || [];
      row = list.find((s) => s.userId === id) || null;
    } catch (e) {
      row = null;
    }
    if (!row) {
      this.setData({ loading: false, classOnly: true, classMissing: true });
      return;
    }
    const todayTarget = Number(row.todayTarget) || 0;
    const weekTarget = Number(row.weekTarget) || 0;
    this.setData({
      loading: false,
      classOnly: true,
      classMissing: false,
      isTeacherUser: false,
      isSuper: false,
      // 走到回退分支就说明管理端资料接口 403：管理类操作一律不渲染（班委仅查看）
      canManagePerms: false,
      canManageUser: false,
      canManageClass: false,
      // 班委/班主任的班级只读视角绝不渲染徽章发放与回收入口（服务端也会按 badge.manage 拦）
      canManageBadges: false,
      badgeSheetVisible: false,
      badgeItems: [],
      bans: [],
      restrictions: [],
      loginInfo: null,
      rates: null,
      goal: null,
      points: null,
      homeroomClasses: [],
      isClassOfficer: !!row.isClassOfficer,
      user: {
        _id: id,
        realName: row.name || fallbackName || '未命名',
        nickname: '',
        className: cls,
        studentId: row.studentId || '',
        role: 'student',
        isClassOfficer: !!row.isClassOfficer,
      },
      // hero 四项换成班级域口径（累计字段班级接口不提供，只有本周 / 活跃 / 跑分）
      sport: {
        totalStepsText: fmt.formatNumber(row.weekSteps),
        totalDistanceText: fmt.formatDistance(row.weekDistance),
        totalDays: row.activeDays || 0,
        badgeCount: 0,
        weekPointsText: fmt.formatNumber(row.weekPoints || 0),
        waterToday: null,
        recentRuns: [],
        classScope: true,
      },
      classInfo: {
        todayStepsText: fmt.formatNumber(row.todaySteps),
        todayTargetText: fmt.formatNumber(todayTarget),
        weekStepsText: fmt.formatNumber(row.weekSteps),
        weekTargetText: fmt.formatNumber(weekTarget),
        achievedToday: !!row.achievedToday,
        achievedWeek: !!row.achievedWeek,
        syncText: row.lastSyncAt ? fmtTime(row.lastSyncAt) : '从未同步',
        totalStepsText: fmt.formatNumber(row.totalSteps || 0),
        totalDays: row.totalDays || 0,
      },
      records: { runs: [], daily: [], weekly: [], water: [], badges: [] },
      recordPages: { runs: 1, daily: 1, weekly: 1, water: 1, badges: 1 },
      recordTotals: { runs: 0, daily: 0, weekly: 0, water: 0, badges: 0 },
      recordPage: 1,
      recordPagesTotal: 1,
      recordTotal: 0,
      pageItems: [],
      recordTab: 'daily',
    });
    this.loadRecords('daily', 1);
  },

  // 明细 Tab 切换：首次进入该 Tab 才拉数据；已加载过则恢复它自己的页码
  switchRecordTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.recordTab) return;
    const cached = ((this.data.records || {})[tab] || []).length > 0;
    const pages = this.data.recordPages || {};
    const totals = this.data.recordTotals || {};
    const page = cached ? pages[tab] || 1 : 1;
    const total = cached ? totals[tab] || 0 : 0;
    this.setData({
      recordTab: tab,
      recordPage: page,
      recordTotal: total,
      recordPagesTotal: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      pageItems: buildPageItems(page, Math.max(1, Math.ceil(total / PAGE_SIZE))),
    });
    if (!cached) this.loadRecords(tab, 1);
  },

  // 运动明细分页加载：每次只取一页（type: runs|daily|weekly|water|badges）
  // 班级域回退（classOnly）走 /api/class/student/:id/records，只有 runs|daily|weekly 三类
  async loadRecords(tab, page) {
    const type = tab || this.data.recordTab;
    if (this.data.recordLoading) return;
    const p = Math.max(1, page || 1);
    this.setData({ recordLoading: true });
    try {
      const res = this.data.classOnly
        ? await auth.get(`/api/class/student/${this.data.id}/records`, {
            className: this.data.className,
            type,
            page: p,
            limit: PAGE_SIZE,
          })
        : await auth.get(`/api/admin/users/${this.data.id}/records`, { type, page: p, limit: PAGE_SIZE });
      const list = ((res && res.list) || []).map((it) => this.fmtRecord(type, it));
      const total = (res && res.total) || 0;
      const pagesTotal = Math.max(1, Math.ceil(total / PAGE_SIZE));
      this.setData({
        records: { ...this.data.records, [type]: list },
        recordPages: { ...this.data.recordPages, [type]: p },
        recordTotals: { ...this.data.recordTotals, [type]: total },
        recordPage: p,
        recordTotal: total,
        recordPagesTotal: pagesTotal,
        pageItems: buildPageItems(p, pagesTotal),
      });
    } catch (e) {
      wx.showToast({ title: e.message || '明细加载失败', icon: 'none' });
    } finally {
      this.setData({ recordLoading: false });
    }
  },

  // 各类型明细的展示字段（与详情接口口径一致）
  fmtRecord(type, it) {
    if (type === 'runs') {
      return {
        ...it,
        dateText: dateText(it.date),
        distanceText: fmt.formatDistance(it.distance),
        durationText: fmt.formatDuration(it.durationSeconds),
        sourceText: it.source === 'gps' ? 'GPS 实跑' : '微信运动',
      };
    }
    if (type === 'daily') {
      return { ...it, dateText: dateText(it.date), stepsText: fmt.formatNumber(it.steps), pointsText: fmt.formatNumber(it.points || 0) };
    }
    if (type === 'weekly') {
      return {
        ...it,
        rangeText: `${String(it.weekStart).slice(5).replace('-', '.')} - ${String(it.weekEnd).slice(5).replace('-', '.')}`,
        stepsText: fmt.formatNumber(it.steps),
        pointsText: fmt.formatNumber(it.points || 0),
      };
    }
    if (type === 'water') return { ...it, dateText: dateText(it.date) };
    // 徽章：管理端这个 Tab 只返回「已获得」的行，所以图标一律原色（不做灰度）；
    // 等级徽章补上「达标里程 · Lv2」上下文，独立徽章保持原样
    const lv = Number(it.level) || Number(it.tierLevel) || 0;
    const group = String(it.tierGroup || '').trim();
    const groupText = group ? `${group} · Lv${lv}` : '';
    return {
      ...it,
      earnedText: groupText ? `${groupText} · ${fmtTime(it.earnedAt)}` : fmtTime(it.earnedAt),
    };
  },

  // 按钮翻页：上一页 / 指定页 / 下一页
  goRecordPage(e) {
    const p = Number(e.currentTarget.dataset.page) || 0;
    if (!p || p === this.data.recordPage) return;
    if (p < 1 || p > this.data.recordPagesTotal) return;
    this.loadRecords(this.data.recordTab, p);
  },

  prevRecordPage() {
    if (this.data.recordPage > 1) this.loadRecords(this.data.recordTab, this.data.recordPage - 1);
  },

  nextRecordPage() {
    if (this.data.recordPage < this.data.recordPagesTotal) {
      this.loadRecords(this.data.recordTab, this.data.recordPage + 1);
    }
  },

  // 解绑微信：二次确认后清除绑定（可被新微信重新绑定）
  unbindWechat() {
    const that = this;
    wx.showModal({
      title: '解绑微信',
      content: '解绑后该账号将被此微信退出登录，可由任意微信重新绑定姓名密码；其运动等数据保留。确认解绑？',
      confirmColor: '#e5484d',
      success: async (res) => {
        if (!res.confirm) return;
        that.setData({ unbinding: true });
        try {
          await auth.post(`/api/admin/users/${that.data.id}/unbind-wechat`);
          wx.showToast({ title: '已解绑', icon: 'success' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        } finally {
          that.setData({ unbinding: false });
        }
      },
    });
  },

  // 单条运动详情：管理端走 /api/admin/users/:uid/runs/:runId；
  // 班级域（班主任 / 班委）走 /api/class/student/:uid/run/:runId（成员资格校验、只读、隐藏「再跑一次」）
  openRun(e) {
    const runId = e.currentTarget.dataset.id;
    if (!runId) return;
    const url = this.data.classOnly
      ? `/pages/run/detail?id=${runId}&scope=class&uid=${this.data.id}&className=${encodeURIComponent(this.data.className)}`
      : `/pages/run/detail?id=${runId}&admin=1&uid=${this.data.id}`;
    wx.navigateTo({ url });
  },

  // 日/周记录 → 时段明细页（日：当天逐条；周：按天拆分）
  // 班级视角必须带上 scope=class，明细页才会走 /api/class/student/:id/period（只读）
  openPeriod(e) {
    const { type, date } = e.currentTarget.dataset;
    if (!date) return;
    const u = this.data.user || {};
    const name = u.realName || u.nickname || '';
    const scopeQuery = this.data.classOnly
      ? `&scope=class&className=${encodeURIComponent(this.data.className)}`
      : '';
    wx.navigateTo({
      url: `/packageAdmin/user-detail/period-detail/period-detail?id=${this.data.id}&type=${type || 'day'}&date=${date}&name=${encodeURIComponent(name)}${scopeQuery}`,
    });
  },

  goEdit() {
    wx.navigateTo({ url: `/packageAdmin/users/account-edit/account-edit?id=${this.data.id}` });
  },

  // 返回：班级视角下数据缺失时的兜底出口
  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/home/home' });
  },

  // 限制账号功能（类型 + 时长 + 原因）——走 ban-sheet 抽屉
  openBanSheet() {
    const u = this.data.user || {};
    this.setData({
      banSheet: { visible: true, user: { _id: this.data.id, account: u.account || u.nickname || u.realName || '' }, busy: false },
    });
  },

  onBanSheetClose() {
    this.setData({ 'banSheet.visible': false });
  },

  async onBanSubmit(e) {
    const { scope, days, reason } = e.detail || {};
    this.setData({ 'banSheet.busy': true });
    try {
      await auth.post(`/api/admin/users/${this.data.id}/ban`, { scope, days, reason: reason || '违反社区规范' });
      const text = { login: '限制登录', sync: '限制微信同步', gps: '限制 GPS' }[scope] || '已限制';
      wx.showToast({ title: `${text}${days > 0 ? ' ' + days + ' 天' : '（永久）'}`, icon: 'none' });
      this.setData({ 'banSheet.visible': false });
      this.load();
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' });
    } finally {
      this.setData({ 'banSheet.busy': false });
    }
  },

  // 解除限制：列出生效中的限制，再补固定三类 + 全部解除
  unban() {
    const that = this;
    const items = [{ label: '全部解除', scope: 'all' }];
    (this.data.restrictions || []).forEach((r) => items.push({ label: `解除「${r.text}」`, scope: r.scope }));
    [
      { label: '解除限制登录', scope: 'login' },
      { label: '解除微信同步限制', scope: 'sync' },
      { label: '解除 GPS 限制', scope: 'gps' },
    ].forEach((f) => {
      if (!items.some((i) => i.scope === f.scope)) items.push(f);
    });
    wx.showActionSheet({
      itemList: items.map((i) => i.label),
      success: async (res) => {
        const scope = (items[res.tapIndex] || {}).scope || 'all';
        try {
          const r = await auth.post(`/api/admin/users/${that.data.id}/unban`, { scope });
          wx.showToast({ title: r && r.lifted && r.lifted.length ? '已解除' : '该类型当前无生效限制', icon: 'none' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },

  // 删除账户：与列表左滑「删除」同一接口，删完返回列表
  removeAccount() {
    const that = this;
    const u = this.data.user || {};
    const name = u.account || u.nickname || u.realName || '该用户';
    wx.showModal({
      title: '删除账户',
      content: `将删除「${name}」及其全部运动 / 饮水 / 徽章等数据，不可恢复！确认删除？`,
      confirmText: '删除',
      confirmColor: '#e5484d',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.del(`/api/admin/users/${that.data.id}`);
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 600);
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },

  // ===== 班级身份：班主任班级（教师多选抽屉）/ 班委（学生开关）=====
  // 接口 PUT /api/admin/users/:id/class-roles（需 user.manage）
  async openClassSheet() {
    if (!this.data.canManageClass) {
      wx.showToast({ title: '需要「封禁/解封用户」权限', icon: 'none' });
      return;
    }
    this.setData({ classSheetVisible: true, classDraft: [...(this.data.homeroomClasses || [])] });
    if (!this.data.classOptions.length) {
      try {
        // 班级候选复用管理端筛选接口：classes（在用班级名）+ classMeta（每班的年级/院系/系部，供抽屉筛选）
        const f = await auth.get('/api/admin/users/filters');
        const meta = (f.classMeta || []).length
          ? f.classMeta
          : (f.classes || []).map((c) => ({ className: c, grade: gradeOfClassName(c), departmentName: '', schoolName: '' }));
        const schools = [...new Set(meta.map((m) => m.schoolName).filter(Boolean))].sort();
        const grades = [...new Set(meta.map((m) => m.grade).filter(Boolean))].sort().reverse();
        this.setData({
          classOptions: (f.classes || []).map((c) => ({ label: c, value: c })),
          classMeta: meta,
          classSchoolRange: ['全部院系', ...schools],
          classGradeRange: ['全部年级', ...grades],
        });
        this.applyClassFilter();
      } catch (e) {
        wx.showToast({ title: e.message || '班级列表加载失败', icon: 'none' });
      }
    }
  },

  // 按 搜索 / 院系 / 系部 / 年级 过滤班级候选（系部候选随院系联动）
  applyClassFilter() {
    const { classMeta, classKeyword, classSchool, classDept, classGrade } = this.data;
    const kw = String(classKeyword || '').trim();
    const list = (classMeta || []).filter((m) => {
      if (classSchool && m.schoolName !== classSchool) return false;
      if (classDept && m.departmentName !== classDept) return false;
      if (classGrade && m.grade !== classGrade) return false;
      if (kw && !String(m.className).includes(kw)) return false;
      return true;
    });
    const depts = [
      ...new Set(
        (classMeta || [])
          .filter((m) => !classSchool || m.schoolName === classSchool)
          .map((m) => m.departmentName)
          .filter(Boolean)
      ),
    ].sort();
    this.setData({
      classFiltered: list.map((m) => ({ label: m.className, value: m.className })),
      classDeptRange: ['全部系部', ...depts],
    });
  },

  onClassKeyword(e) {
    this.setData({ classKeyword: e.detail.value || '' }, () => this.applyClassFilter());
  },

  onClassSchool(e) {
    const i = Number(e.detail.value) || 0;
    this.setData(
      { classSchoolIndex: i, classSchool: i ? this.data.classSchoolRange[i] : '', classDeptIndex: 0, classDept: '' },
      () => this.applyClassFilter()
    );
  },

  onClassDept(e) {
    const i = Number(e.detail.value) || 0;
    this.setData({ classDeptIndex: i, classDept: i ? this.data.classDeptRange[i] : '' }, () => this.applyClassFilter());
  },

  onClassGrade(e) {
    const i = Number(e.detail.value) || 0;
    this.setData({ classGradeIndex: i, classGrade: i ? this.data.classGradeRange[i] : '' }, () => this.applyClassFilter());
  },

  clearClassFilter() {
    this.setData(
      { classKeyword: '', classSchool: '', classDept: '', classGrade: '', classSchoolIndex: 0, classDeptIndex: 0, classGradeIndex: 0 },
      () => this.applyClassFilter()
    );
  },

  onClassSheetVisible(e) {
    this.setData({ classSheetVisible: !!(e.detail && e.detail.visible) });
  },

  closeClassSheet() {
    this.setData({ classSheetVisible: false });
  },

  onClassDraftChange(e) {
    const value = Array.isArray(e.detail) ? e.detail : (e.detail && e.detail.value) || [];
    this.setData({ classDraft: value });
  },

  // 保存班主任班级（多选；清空 = 取消班主任）
  async saveHomeroomClasses() {
    if (this.data.classSaving) return;
    this.setData({ classSaving: true });
    try {
      const r = await auth.put(`/api/admin/users/${this.data.id}/class-roles`, { homeroomClasses: this.data.classDraft });
      const list = r.homeroomClasses || [];
      this.setData({ homeroomClasses: list, classSheetVisible: false });
      wx.showToast({ title: list.length ? `已分配 ${list.length} 个班` : '已取消班主任', icon: 'none' });
    } catch (err) {
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ classSaving: false });
    }
  },

  // 班委开关（学生）：即时保存，失败回滚
  async onOfficerChange(e) {
    const value = !!(e.detail && e.detail.value);
    if (this.data.officerSaving) return;
    const prev = this.data.isClassOfficer;
    this.setData({ isClassOfficer: value, officerSaving: true });
    try {
      await auth.put(`/api/admin/users/${this.data.id}/class-roles`, { isClassOfficer: value });
      wx.showToast({ title: value ? '已设为班委（仅查看本班）' : '已取消班委', icon: 'none' });
    } catch (err) {
      this.setData({ isClassOfficer: prev });
      wx.showToast({ title: err.message || '设置失败', icon: 'none' });
    } finally {
      this.setData({ officerSaving: false });
    }
  },

  // ===== 徽章：手工发放 / 回收（需 badge.manage；服务端 requirePermission 同步拦）=====
  // 打开发放抽屉（先拉「全部启用中的定义 + 已获得」，再渲染）
  openBadgeSheet() {
    if (!this.data.canManageBadges) {
      wx.showToast({ title: '需要「发放与回收徽章」权限', icon: 'none' });
      return;
    }
    this.setData({ badgeSheetVisible: true });
    this.loadBadgeSheet();
  },

  closeBadgeSheet() {
    this.setData({ badgeSheetVisible: false });
  },

  onBadgeSheetVisible(e) {
    this.setData({ badgeSheetVisible: !!(e.detail && e.detail.visible) });
  },

  // 拉徽章定义与已获得列表 → 组装抽屉（等级组按组折叠，保留上一轮展开状态）
  async loadBadgeSheet() {
    this.setData({ badgeSheetLoading: true });
    try {
      const r = await auth.get(`/api/admin/users/${this.data.id}/badges`);
      this.applyBadgeCount((r && r.list) || []);
      this.setData({ badgeItems: buildBadgeItems((r && r.definitions) || [], this.data.badgeItems) });
    } catch (e) {
      wx.showToast({ title: e.message || '徽章加载失败', icon: 'none' });
    } finally {
      this.setData({ badgeSheetLoading: false });
    }
  },

  // 等级组展开 / 收起
  toggleBadgeGroup(e) {
    const group = e.currentTarget.dataset.group;
    if (!group) return;
    this.setData({
      badgeItems: (this.data.badgeItems || []).map((it) =>
        it.kind === 'group' && it.tierGroup === group ? { ...it, expanded: !it.expanded } : it
      ),
    });
  },

  // 发放（幂等：重复发放不会重复记录，服务端返回 granted=false）
  async grantBadge(e) {
    const { key, name } = e.currentTarget.dataset;
    if (!key || this.data.badgeGranting) return;
    const hit = findBadgeItem(this.data.badgeItems, key);
    if (hit && hit.earned) {
      wx.showToast({ title: `「${name || key}」已获得`, icon: 'none' });
      return;
    }
    this.setData({ badgeGranting: key });
    try {
      const r = await auth.post(`/api/admin/users/${this.data.id}/badges`, { badgeKey: key });
      wx.showToast({ title: r && r.granted ? `已发放「${name || key}」` : `「${name || key}」已获得`, icon: 'none' });
      this.applyBadgeCount((r && r.list) || []);
      await this.loadBadgeSheet();
    } catch (err) {
      wx.showToast({ title: err.message || '发放失败', icon: 'none' });
    } finally {
      this.setData({ badgeGranting: '' });
    }
  },

  // 回收（删除获得记录）：必须二次确认，文案写清「再次满足条件会自动重新获得」
  revokeBadge(e) {
    const { key, name } = e.currentTarget.dataset;
    if (!key) return;
    const that = this;
    wx.showModal({
      title: '回收徽章',
      content: `确认回收「${name || key}」？回收 = 删除该获得记录，回收后用户再次满足条件会自动重新获得（解封/到期不会自动恢复）。`,
      confirmText: '回收',
      confirmColor: '#e5484d',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const r = await auth.del(`/api/admin/users/${that.data.id}/badges/${encodeURIComponent(key)}`);
          wx.showToast({ title: r && r.revoked ? '已回收' : '该用户未获得此徽章', icon: 'none' });
          that.applyBadgeCount((r && r.list) || []);
          if (that.data.badgeSheetVisible) await that.loadBadgeSheet();
        } catch (err) {
          wx.showToast({ title: err.message || '回收失败', icon: 'none' });
        }
      },
    });
  },

  // 发放 / 回收后的本地同步：身份卡与「徽章」计数更新，徽章 Tab 的已获得快照失效
  // （正在看徽章 Tab 时立即重拉；否则切回该 Tab 时再拉，避免打乱当前 Tab 的分页状态）
  applyBadgeCount(list) {
    const count = Array.isArray(list) ? list.length : null;
    const patch = { records: { ...this.data.records, badges: [] } };
    if (count != null) {
      patch.recordTotals = { ...this.data.recordTotals, badges: count };
      if (this.data.sport) patch['sport.badgeCount'] = count;
    }
    this.setData(patch);
    if (this.data.recordTab === 'badges') this.loadRecords('badges', 1);
  },

  // 重置登录密码：恢复为初始密码（学号/身份证后8），需 permission.manage
  resetPassword() {
    const that = this;
    wx.showModal({
      title: '重置登录密码',
      content: '该用户的密码将重置为初始密码，并要求下次登录时修改。确认重置？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const r = await auth.post(`/api/admin/users/${that.data.id}/reset-password`);
          wx.showModal({ title: '已重置', content: r.message, showCancel: false });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },
});
