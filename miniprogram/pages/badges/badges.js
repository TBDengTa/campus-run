const auth = require('../../utils/request');
const fmt = require('../../utils/format');

// 徽章阈值单位（仅用于展示）
const UNIT_MAP = {
  total_distance: 'm',
  single_distance: 'm',
  total_steps: '步',
  single_steps: '步',
};

// 距离类徽章的 target 单位是米，展示统一换成 km
const DISTANCE_TYPES = ['total_distance', 'single_distance'];

// 米 → km 文案（整数不带小数：5000 → 5，2500 → 2.5）
function kmText(meters) {
  const km = (Number(meters) || 0) / 1000;
  return Number.isInteger(km) ? String(km) : km.toFixed(1);
}

// ===== 达成条件的中文文案（页面常量）=====
// 后端只下发 type + target，人类可读文案在页面翻译，后端不改。
// points / rank 是跑分体系的新数据源（后端由另一处实现），前端已就位：
//   points → 累计跑分达标；rank → 跑分总榜排名（数值越小越好，读作「前 N 名」）
const CONDITION_TEXT = {
  goal_days: (n) => `累计达标天数 ≥ ${fmt.formatNumber(n)} 天`,
  total_steps: (n) => `累计步数 ≥ ${fmt.formatNumber(n)}`,
  streak_days: (n) => `连续打卡 ≥ ${fmt.formatNumber(n)} 天`,
  single_steps: (n) => `单日步数 ≥ ${fmt.formatNumber(n)}`,
  single_distance: (n) => `单次距离 ≥ ${kmText(n)} km`,
  total_distance: (n) => `累计距离 ≥ ${kmText(n)} km`,
  total_days: (n) => `累计打卡 ≥ ${fmt.formatNumber(n)} 天`,
  points: (n) => `累计跑分 ≥ ${fmt.formatNumber(n)} 分`,
  rank: (n) => `跑分排名前 ${fmt.formatNumber(n)} 名`,
};

const isDistance = (type) => DISTANCE_TYPES.includes(type);
const unitOf = (type) => UNIT_MAP[type] || '天';

// 阈值文案（详情弹窗里每一级的「达标线 ≥ X」）
function targetTextOf(type, target) {
  const n = Number(target) || 0;
  if (isDistance(type)) return `${kmText(n)} km`;
  if (type === 'points') return `${fmt.formatNumber(n)} 分`;
  if (type === 'rank') return `前 ${fmt.formatNumber(n)} 名`;
  return `${fmt.formatNumber(n)}${unitOf(type)}`;
}


// 达成条件文案（未知 type 走通用兜底，不会出现空白）
function conditionOf(type, target) {
  const n = Number(target) || 0;
  const fn = CONDITION_TEXT[type];
  return fn ? fn(n) : `达到目标 ${targetTextOf(type, n)}`;
}

// 「当前 X / 目标 Y」进度文案（按 type 给单位：跑分/排名/距离/步数/天数）
function progressPairText(progress, goal, type) {
  const p = Number(progress) || 0;
  const g = Number(goal) || 0;
  if (isDistance(type)) return `当前 ${kmText(p)} / 目标 ${kmText(g)} km`;
  if (type === 'points') return `当前 ${fmt.formatNumber(p)} / 目标 ${fmt.formatNumber(g)} 分`;
  if (type === 'rank') return `当前第 ${fmt.formatNumber(p)} 名 / 目标前 ${fmt.formatNumber(g)} 名`;
  return `当前 ${fmt.formatNumber(p)} / 目标 ${fmt.formatNumber(g)}${unitOf(type)}`;
}

// 矩阵格子的一行小字（更短）：跑分/排名等新类型同样给对单位
function compactProgressText(progress, target, type) {
  const p = Number(progress) || 0;
  const t = Number(target) || 0;
  if (isDistance(type)) return `${kmText(p)}/${kmText(t)} km`;
  if (type === 'points') return `${fmt.formatNumber(p)}/${fmt.formatNumber(t)} 分`;
  if (type === 'rank') return `第${fmt.formatNumber(p)}/前${fmt.formatNumber(t)}`;
  return `${fmt.formatNumber(p)}/${fmt.formatNumber(t)}${unitOf(type)}`;
}

// 进度条宽度：统一在这里算好，WXML 里不写内联 style
function widthOf(percent) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  return `width:${p}%`;
}

Page({
  data: {
    loading: true,
    // 混排后的列表行：等级组压成一行（kind='tier'）+ 独立徽章各占一行（kind='single'）
    rows: [],
    earnedCount: 0,
    total: 0,
    percent: 0,
    percentStyle: 'width:0%',
    // 流量主横幅（ad-banner）闸门：首帧都是 false（不渲染），load() 里 ensureLogin 之后才置真
    isTeacher: false,
    showAd: false,
    // 详情底部弹窗（点击列表行打开）
    sheet: { visible: false, levels: [] },
  },

  onShow() {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    this.load();
  },

  // 点击列表行：底部弹窗看详情（不再内联展开）
  openDetail(e) {
    const { id } = e.currentTarget.dataset;
    const row = (this.data.rows || []).find((r) => r.id === id);
    if (!row) return;
    this.setData({ sheet: this.buildSheet(row) });
  },

  closeDetail() {
    this.setData({ 'sheet.visible': false });
  },

  // 点遮罩 / 下滑关闭时同步状态（t-popup 既有行为）
  onSheetVisibleChange(e) {
    const visible = !!(e.detail && e.detail.visible);
    if (visible !== this.data.sheet.visible) this.setData({ 'sheet.visible': visible });
  },

  // 详情弹窗数据：等级组列出该组全部等级（标出「当前等级」「下一目标」），独立徽章只列自身
  buildSheet(row) {
    const isTier = row.kind === 'tier';
    const levels = isTier
      ? (row.levels || []).map((l) => {
          const lv = Number(l.tierLevel) || 0;
          const isCurrent = !!row.anyEarned && lv === row.currentLevel;
          const isNext = !isCurrent && lv > 0 && lv === row.nextTierLevel;
          return {
            key: l.key,
            levelText: `Lv${lv}`,
            name: l.name,
            icon: l.icon || '',
            earned: !!l.earned,
            targetLine: `达标线 ≥ ${targetTextOf(l.type, l.target)}`,
            state: isCurrent ? '当前等级' : isNext ? '下一目标' : '',
          };
        })
      : [];
    return {
      visible: true,
      id: row.id,
      kind: row.kind,
      name: row.name,
      icon: row.icon || '',
      dim: !!row.dim,
      badgeName: row.badgeName || row.name,
      tag: row.tag || '',
      tagDim: !!row.tagDim,
      description: row.description || '',
      conditionText: row.conditionText || '',
      progressText: row.progressText || '',
      percentText: `${Number(row.percent) || 0}%`,
      percentStyle: row.percentStyle || 'width:0%',
      levels,
    };
  },

  // 登录后按需检测：先让服务端评估「当前登录用户是否达成」并幂等补发，再拉列表。
  // 顺序不能反过来——否则会出现「进度条满格但 0 已获得」的假象。
  // 接口幂等，失败一律静默：不阻塞列表展示。
  async checkBadges() {
    try {
      await auth.post('/api/badges/check');
    } catch (e) {
      // 静默：教师账号 / 网络异常都不影响列表
    }
  },

  async load() {
    try {
      await getApp().ensureLogin();
      // 流量主横幅（ad-banner）的两道闸门：角色已确认是学生才渲染，教师整块不进 DOM
      getApp().applyAdGate(this);
      await this.checkBadges();
      const data = await auth.get('/api/badges');
      const total = Number(data.total) || 0;
      const earnedCount = Number(data.earnedCount) || 0;
      const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((earnedCount / total) * 100))) : 0;

      // 仅补充展示用字段，接口数据原样保留（progress / nextTarget / percent 来自服务端）
      const list = (data.list || []).map((b) => ({
        ...b,
        percentStyle: widthOf(b.percent),
        conditionText: conditionOf(b.type, b.target),
      }));

      // 等级徽章（tierGroup 非空）按组压成一行；其余各占一行
      const singles = [];
      const groupMap = new Map();
      for (const b of list) {
        const group = String(b.tierGroup || '').trim();
        const isTier = b.mode === 'tier' || (b.mode !== 'single' && group);
        if (!isTier || !group) {
          singles.push(b);
          continue;
        }
        if (!groupMap.has(group)) groupMap.set(group, []);
        groupMap.get(group).push(b);
      }

      const sortOf = (b) => Number(b.sort) || 0;
      const rows = [];

      for (const b of singles) {
        const earned = !!b.earned;
        rows.push({
          kind: 'single',
          id: `single:${b.key}`,
          key: b.key,
          name: b.name,
          icon: b.icon || '',
          dim: !earned,
          earned,
          tag: earned ? '已获得' : '未获得',
          tagDim: !earned,
          // 格子小字（一行）：已获得看达成条件，未获得看「当前/目标」紧凑进度
          sub: earned ? b.conditionText : compactProgressText(b.progress, b.target, b.type),
          badgeName: b.name,
          description: b.description || '',
          conditionText: b.conditionText,
          progressText: progressPairText(b.progress, b.target, b.type),
          percent: Math.max(0, Math.min(100, Number(b.percent) || 0)),
          percentStyle: b.percentStyle,
          levels: [],
          anyEarned: false,
          currentLevel: 0,
          nextTierLevel: 0,
          sort: sortOf(b),
        });
      }

      for (const [group, items] of groupMap) {
        const levels = [...items].sort((a, b) => (Number(a.tierLevel) || 0) - (Number(b.tierLevel) || 0));
        const minLevel = Number(levels[0] && levels[0].tierLevel) || 1;
        const earnedLevels = levels.filter((l) => l.earned);
        const anyEarned = earnedLevels.length > 0;
        // 行面优先级：当前最高已获得等级 → 一级都没获得时显示最低级（Lv1）作为下一目标
        const current = anyEarned
          ? earnedLevels[earnedLevels.length - 1]
          : levels.find((l) => (Number(l.tierLevel) || 0) === minLevel) || levels[0];
        const currentLevel = Math.max(1, Number(current.tierLevel) || 1);
        // 下一级：已获得的找当前等级之上最近的一级；一级都没获得时目标就是最低级（Lv1）
        const next = anyEarned
          ? levels.find((l) => (Number(l.tierLevel) || 0) > currentLevel)
          : current;
        const nextTierLevel = next ? Math.max(1, Number(next.tierLevel) || currentLevel) : 0;
        const progress = Math.max(0, Number(current.progress) || 0);
        // 进度基线：已获得则从当前等级阈值起算（Lv2 → Lv3 之间）；未获得从 0 起算。
        // 但 1.0 迁移过来的等级行是「历史发放」——用户当前累计值可能已低于现阈值
        // （记录被清理/口径变化），这时不能把基线压到当前值，否则进度条会显示成空槽。
        const floor = anyEarned ? Number(current.target) || 0 : 0;
        const baseline = Math.min(floor, progress);
        const goal = next ? Number(next.target) || 0 : 0;
        let groupPercent = 100;
        if (next && goal > baseline) {
          groupPercent = Math.round(((progress - baseline) / (goal - baseline)) * 100);
        }
        groupPercent = Math.max(0, Math.min(100, groupPercent));
        // 兜底：progress 已达标但这一行还没发放（老数据；正常走过 /api/badges/check 后不会出现）
        const reachable = !!next && goal > 0 && progress >= goal;
        const progressText = progressPairText(progress, goal || baseline, current.type);
        const tag = anyEarned ? `Lv${currentLevel}/${levels.length}` : '未获得';
        // 格子小字（一行）：等级组显示当前最高等级 LvN/总数（已达标未发放时提示可点亮）；
        // 一级都没有时显示「未获得 · Lv1」
        const sub = anyEarned ? (reachable ? `${tag} · 可点亮` : tag) : `未获得 · Lv${minLevel}`;

        rows.push({
          kind: 'tier',
          id: `tier:${group}`,
          group,
          name: group,
          icon: current.icon || '',
          dim: !anyEarned,
          anyEarned,
          currentLevel,
          nextTierLevel,
          tag,
          tagDim: !anyEarned,
          sub,
          badgeName: current.name,
          description: current.description || '',
          conditionText: conditionOf(current.type, current.target),
          progressText,
          percent: groupPercent,
          percentStyle: widthOf(groupPercent),
          levels: levels.map((l) => ({
            key: l.key,
            name: l.name,
            icon: l.icon || '',
            earned: !!l.earned,
            tierLevel: Number(l.tierLevel) || 0,
            type: l.type,
            target: l.target,
          })),
          // 等级组按组内最低等级的排序值参与混排（沿用现有 sort 字段）
          sort: sortOf(levels[0]),
        });
      }

      // 混排：统一按 sort 升序；sort 相同时保持接口返回的原始顺序
      const seq = new Map(list.map((b, i) => [b.key, i]));
      const seqOf = (r) => {
        if (r.kind === 'tier') {
          const first = (r.levels[0] && r.levels[0].key) || '';
          return seq.has(first) ? seq.get(first) : 0;
        }
        return seq.has(r.key) ? seq.get(r.key) : 0;
      };
      rows.sort((a, b) => a.sort - b.sort || seqOf(a) - seqOf(b));

      this.setData({
        loading: false,
        rows,
        earnedCount,
        total,
        percent,
        percentStyle: widthOf(percent),
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
});
