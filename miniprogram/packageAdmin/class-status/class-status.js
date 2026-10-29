// 班级状态总览（用户 2026-10-29）：
//   「增加班级状态页面显示所有班级的考勤、校园跑达标(日、周)，并且可以复制到文本如未达标班级等」
//
// ===== 与「班级管理」的分工（别把两个页搞混）=====
//   · 班级管理 `/packageAdmin/class-manage/class-manage`：**改台账**（早操/校园跑标记、教室、宿舍）
//   · 本页 `班级状态`：**只看不改**，全校 43 个班一眼看谁没达标，并能一键复制成文字发到工作群
// 权限：复用 `class.view`（服务端 GET /api/admin/class/status-board）。
//   没有新开权限项 —— 学生处/年级组长本来就靠 class.view 看班级台账，
//   新开一项会让他们突然失去入口，而他们恰恰最需要这张表。
//
// ===== 数据口径由服务端算好，前端只展示 =====
// 达标口径（个人计划优先、周为 ISO 周一）与「可复制的文案」都在
// services/class-status-board.js 生成。前端**不做任何二次计算**：
// 一旦前端自己再算一遍，就会出现「列表写 87%、复制出的文案写 88%」这种对不上话的问题，
// 老师发到群里之后被问住，很难解释。
const auth = require('../../utils/request');
const adminPerm = require('../../utils/admin-perm');

// 视图切换：总览 / 未达标 / 考勤
const TABS = [
  { key: 'overview', label: '总览' },
  { key: 'notAchieved', label: '未达标' },
  { key: 'attendance', label: '考勤' },
];

Page({
  data: {
    tabs: TABS,
    tab: 'overview',

    loading: true,
    today: '',
    weekStart: '',
    from: '',
    days: 7,
    dayOptions: [3, 7, 14, 30],

    totals: null,
    rows: [],
    // 当前 tab 显示的列表（overview 显示全部；notAchieved 显示未达标；attendance 显示考勤）
    shown: [],
    // 未达标清单（服务端生成，含日/周/考勤待补三组）
    notAchieved: { daily: [], weekly: [], attendanceMissing: [] },
    // 可复制文本（服务端生成，前端不拼）
    copyText: '',
    // 只读用户也能复制（复制不是写操作），所以不 gate 在 canManage 上
    canView: false,

    // 搜索（按班名/系部过滤，纯前端过滤，不改服务端口径）
    keyword: '',
  },

  onLoad() {
    if (!getApp().requireLogin()) return;
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    // 读权限：class.view 或 *（与后端前缀守卫一致）
    adminPerm.applyManage(this, 'class.view').then(() => {
      this.setData({ canView: !!this.data.canManage });
      this.load();
    });
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    if (this.data.loading === false) this.setData({ loading: true });
    try {
      const res = await auth.get('/api/admin/class/status-board', { days: this.data.days });
      const d = res || {};
      this.setData({
        loading: false,
        today: d.today || '',
        weekStart: d.weekStart || '',
        from: d.from || '',
        days: d.days || this.data.days,
        totals: d.totals || null,
        rows: d.rows || [],
        notAchieved: d.notAchieved || { daily: [], weekly: [], attendanceMissing: [] },
        copyText: d.copyText || '',
      });
      this.applyTab(this.data.tab);
    } catch (e) {
      this.setData({ loading: false });
      // 403 → 无权限（服务端判定），不要弹成「加载失败」，否则用户以为是网络问题
      if (e.code === 403002 || e.code === 403) {
        wx.showToast({ title: '没有查看班级状态的权限（需要 class.view）', icon: 'none' });
        return;
      }
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  // 切换 tab：只换 shown 数组，不重新请求（已一次性拿到全部数据）
  onTab(e) {
    const tab = (e.currentTarget.dataset || {}).tab || 'overview';
    if (tab === this.data.tab) return;
    this.setData({ tab }, () => this.applyTab(tab));
  },

  applyTab(tab) {
    const { rows, notAchieved, keyword } = this.data;
    let list = [];
    if (tab === 'notAchieved') {
      // 未达标：合并日与周两组（同一班可能两边都未达标，按班名去重，优先展示日）
      const byName = new Map();
      for (const x of notAchieved.daily || []) byName.set(x.className, { ...x, kind: 'daily' });
      for (const x of notAchieved.weekly || []) if (!byName.has(x.className)) byName.set(x.className, { ...x, kind: 'weekly' });
      list = [...byName.values()];
    } else if (tab === 'attendance') {
      list = (rows || []).slice();
    } else {
      list = (rows || []).slice();
    }

    // 关键词过滤（前端本地过滤，不改服务端口径）
    const kw = String(keyword || '').trim();
    if (kw) {
      list = list.filter(
        (r) => (r.className || '').includes(kw) || (r.departmentName || '').includes(kw)
      );
    }

    // 视图专用的展示字段在 JS 里算（只做格式化，不做业务判定）
    this.setData({ shown: list.map((r) => this.decorate(r)) });
  },

  // 只做**展示格式化**：达标率文案、颜色档位。判定（是否达标）一律用服务端给的数字。
  decorate(r) {
    // 未达标 tab 的行可能没有 run 结构（notAchieved 简报），兼容两种形状
    const dailyRate = r.run ? r.run.dailyRate : r.dailyRate;
    const weeklyRate = r.run ? r.run.weeklyRate : r.weeklyRate;
    const achievedToday = r.run ? r.run.achievedToday : r.achievedToday;
    const achievedWeek = r.run ? r.run.achievedWeek : r.achievedWeek;
    const rateLevel = (v) => (v === null || v === undefined ? 'none' : v >= 100 ? 'ok' : v >= 60 ? 'warn' : 'bad');
    return {
      ...r,
      dailyRateText: dailyRate === null || dailyRate === undefined ? '—' : `${dailyRate}%`,
      weeklyRateText: weeklyRate === null || weeklyRate === undefined ? '—' : `${weeklyRate}%`,
      achievedText: `${achievedToday || 0}/${r.studentCount || 0}`,
      achievedWeekText: `${achievedWeek || 0}/${r.studentCount || 0}`,
      dailyLevel: rateLevel(dailyRate),
      weeklyLevel: rateLevel(weeklyRate),
      attendanceText:
        r.attendance && r.attendance.ratePercent !== null && r.attendance.ratePercent !== undefined
          ? `${r.attendance.ratePercent}%`
          : '无记录',
      attendanceLevel:
        r.attendance && r.attendance.ratePercent !== null && r.attendance.ratePercent !== undefined
          ? r.attendance.ratePercent >= 90
            ? 'ok'
            : r.attendance.ratePercent >= 70
              ? 'warn'
              : 'bad'
          : 'none',
      // 参跑标记：不参跑的班在总览里要能看出来，否则会被误认为是「0 达标」
      runDisabled: r.run ? r.run.enabled === false : false,
    };
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value }, () => this.applyTab(this.data.tab));
  },

  clearKeyword() {
    this.setData({ keyword: '' }, () => this.applyTab(this.data.tab));
  },

  // 统计天数切换（考勤回看窗口）
  onDays(e) {
    const days = Number((e.currentTarget.dataset || {}).days) || 7;
    if (days === this.data.days) return;
    this.setData({ days }, () => this.load());
  },

  // 复制到剪贴板（用户明确要「可以复制到文本如未达标班级等」）。
  // 文案由服务端生成，这里只负责搬运 —— 前端绝不自己拼，
  // 否则「列表 87%、文案 88%」这种不一致会被老师当场指出来。
  copyText() {
    const text = this.data.copyText;
    if (!text) {
      wx.showToast({ title: '还没有可复制的数据', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: text,
      success: () => {
        // setClipboardData 自带「已复制」提示，这里补一句用途，避免老师不知道该粘到哪
        wx.showToast({ title: '已复制，可直接粘贴到工作群', icon: 'none', duration: 2200 });
      },
      fail: () => wx.showToast({ title: '复制失败，请长按文本手动复制', icon: 'none' }),
    });
  },

  // 复制当前 tab 的简表（未达标班逐个列，方便只发名单）
  copyList() {
    const list = this.data.shown || [];
    if (!list.length) {
      wx.showToast({ title: '当前列表为空', icon: 'none' });
      return;
    }
    const tab = this.data.tab;
    const lines = [];
    if (tab === 'notAchieved') {
      lines.push(`【未达标班级 ${this.data.today}】`);
      for (const r of list) {
        const d = r.dailyRateText;
        const w = r.weeklyRateText;
        lines.push(`· ${r.className}：今日 ${r.achievedText} 人（${d}），本周 ${r.achievedWeekText} 人（${w}）`);
      }
    } else if (tab === 'attendance') {
      lines.push(`【班级考勤 ${this.data.from} ~ ${this.data.today}】`);
      for (const r of list) {
        const mods = r.attendance && r.attendance.modules ? r.attendance.modules : {};
        const parts = [];
        for (const k of Object.keys(mods)) {
          const m = mods[k];
          if (m.ratePercent === null || m.ratePercent === undefined) {
            if (m.late) parts.push(`${m.name}迟到${m.late}人`);
          } else {
            parts.push(`${m.name}${m.ratePercent}%`);
          }
        }
        lines.push(`· ${r.className}：综合 ${r.attendanceText}${parts.length ? `（${parts.join('、')}）` : '（无记录）'}`);
      }
    } else {
      lines.push(`【班级状态总览 ${this.data.today}】`);
      for (const r of list) {
        lines.push(`· ${r.className}：今日 ${r.dailyRateText}，本周 ${r.weeklyRateText}，考勤 ${r.attendanceText}`);
      }
    }
    wx.setClipboardData({
      data: lines.join('\n'),
      success: () => wx.showToast({ title: '已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' }),
    });
  },

  // 点班级 → 进「我的班级」看该班明细（班主任/班委视角）
  openClass(e) {
    const className = (e.currentTarget.dataset || {}).name;
    if (!className) return;
    wx.navigateTo({
      url: `/packageAdmin/class/class?className=${encodeURIComponent(className)}&scope=admin`,
    });
  },
});
