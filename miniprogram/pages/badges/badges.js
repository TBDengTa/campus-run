const auth = require('../../utils/request');
const fmt = require('../../utils/format');

// 徽章阈值单位（仅用于展示）
const UNIT_MAP = {
  total_distance: 'm',
  single_distance: 'm',
  total_steps: '步',
  single_steps: '步',
};

// 进度条宽度：统一在这里算好，WXML 里不写内联 style
function widthOf(percent) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  return `width:${p}%`;
}

Page({
  data: {
    loading: true,
    list: [], // 独立徽章（含 tierGroup 为空的）
    groups: [], // 等级徽章：一组一张卡
    expanded: {}, // { [group]: true } 展开态
    earnedCount: 0,
    total: 0,
    percent: 0,
    percentStyle: 'width:0%',
    // 独立徽章分组自身的计数（**不是**全站 total，见 load() 里的注释）
    singleEarned: 0,
    singleTotal: 0,
  },

  onShow() {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    this.load();
  },

  // 点击等级徽章卡：展开 / 收起该组全部等级明细
  toggleGroup(e) {
    const { group } = e.currentTarget.dataset;
    if (!group) return;
    this.setData({ [`expanded.${group}`]: !this.data.expanded[group] });
  },

  // 登录后按需检测：先让服务端评估「当前登录用户是否达成」并幂等补发，再拉列表。
  // 顺序不能反过来——否则会出现「进度条满格但 0 已获得」的假象（用户截图里的问题 1）。
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
      await this.checkBadges();
      const data = await auth.get('/api/badges');
      const total = Number(data.total) || 0;
      const earnedCount = Number(data.earnedCount) || 0;
      const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((earnedCount / total) * 100))) : 0;
      const unitOf = (type) => UNIT_MAP[type] || '天';

      // 仅补充展示用字段，接口数据原样保留（progress / nextTarget / percent 来自服务端）
      const list = (data.list || []).map((b) => ({
        ...b,
        targetText: `${fmt.formatNumber(b.target)}${unitOf(b.type)}`,
        nextText: b.nextTarget ? `${fmt.formatNumber(b.nextTarget)}${unitOf(b.type)}` : '',
        percentStyle: widthOf(b.percent),
      }));

      // 等级徽章按 tierGroup 分组；独立徽章（无 tierGroup）保持单卡
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

      const groups = [];
      for (const [group, items] of groupMap) {
        const levels = [...items].sort(
          (a, b) => (Number(a.tierLevel) || 0) - (Number(b.tierLevel) || 0)
        );
        const minLevel = Number(levels[0] && levels[0].tierLevel) || 1;
        const earnedLevels = levels.filter((l) => l.earned);
        const anyEarned = earnedLevels.length > 0;
        // 卡面优先级：当前最高已获得等级 → 一级都没获得时显示**最低级**（Lv1）作为下一目标
        const current = anyEarned
          ? earnedLevels[earnedLevels.length - 1]
          : levels.find((l) => (Number(l.tierLevel) || 0) === minLevel) || levels[0];
        const currentLevel = Math.max(1, Number(current.tierLevel) || 1);
        // 下一级：已获得的找当前等级之上最近的一级；一级都没获得时目标就是最低级（Lv1），
        // 此时 next === current，文案走「下一目标 Lv1 · 徽章名」，「当前 X / 目标 Y」里的 Y 就是 Lv1 的达标线。
        const next = anyEarned
          ? levels.find((l) => (Number(l.tierLevel) || 0) > currentLevel)
          : current;
        const progress = Math.max(0, Number(current.progress) || 0);
        // 进度基线：已获得则从当前等级阈值起算（Lv2 → Lv3 之间）；未获得从 0 起算。
        // 但 1.0 迁移过来的等级行是「历史发放」——用户当前的累计值可能已经低于现阈值
        // （记录被清理/口径变化），这时不能把基线压到当前值，否则进度条会显示成空槽。
        // 处理：真实进度低于阈值时，槽位「底」仍取阈值（已达成部分的视觉基线），
        // 槽位「顶」是下一级阈值；一级都没获得时基线必须是 0（进度条要反映真实进度）。
        const floor = anyEarned ? Number(current.target) || 0 : 0;
        const baseline = Math.min(floor, progress);
        const goal = next ? Number(next.target) || 0 : 0;
        let groupPercent = 100;
        if (next && goal > baseline) {
          groupPercent = Math.round(((progress - baseline) / (goal - baseline)) * 100);
        }
        groupPercent = Math.max(0, Math.min(100, groupPercent));
        const unit = unitOf(current.type);
        // 兜底：progress 已达标但这一行还没发放（老数据；正常走过 /api/badges/check 后不会出现）。
        // 此时不能只给一条满格进度条 + 「未获得」，必须明确提示「可点亮」。
        const reachable = !!next && goal > 0 && progress >= goal;
        const nextLevelText = next ? `Lv${Number(next.tierLevel) || currentLevel}` : '';
        // 卡面语义（问题 3）：一级都没获得时，Lv1 是**下一目标**而不是「当前等级」——
        // 否则会出现「Lv1 = 当前等级」和「下一级 Lv1」自相矛盾。
        // 等级徽章的 name 本身就带等级含义（初级·运动达人），所以拼成「下一目标 Lv1 · 初级·运动达人」。
        const levelTag = anyEarned ? `Lv${currentLevel}` : '未获得';
        const badgeName = anyEarned
          ? current.name
          : `下一目标 ${nextLevelText} · ${current.name}`;
        // 「当前 X / 目标 Y」——X 为累计进度，Y 为下一级阈值（已满级时为当前级阈值）
        const progressText = `当前 ${fmt.formatNumber(progress)} / 目标 ${fmt.formatNumber(goal || baseline)}${unit}`;

        groups.push({
          group,
          current,
          next,
          levels: levels.map((l) => ({
            ...l,
            levelText: `Lv${Number(l.tierLevel) || 0}`,
          })),
          earnedLevels: earnedLevels.length,
          totalLevels: levels.length,
          anyEarned,
          cardDim: !anyEarned, // 一级都没获得：卡面灰度
          levelTag,
          badgeName,
          progressText,
          // 已达标未发放 → 「可点亮」；否则给下一级目标文案
          nextText: reachable
            ? next
              ? `下一级 ${nextLevelText} · ${next.name} · 达成即点亮`
              : '已是最高等级 🎉'
            : next
            ? `下一级 ${nextLevelText} · ${next.name} · ${fmt.formatNumber(goal)}${unit}`
            : '已是最高等级 🎉',
          reachable,
          percent: groupPercent,
          percentStyle: widthOf(groupPercent),
        });
      }
      // 卡片顺序按组内最低等级的排序值，与徽章页原来的排序一致
      groups.sort(
        (a, b) => (Number(a.levels[0] && a.levels[0].sort) || 0) - (Number(b.levels[0] && b.levels[0].sort) || 0)
      );

      this.setData({
        loading: false,
        list: singles,
        groups,
        earnedCount,
        total,
        percent,
        percentStyle: widthOf(percent),
        // 独立徽章分组的计数 = 该组内已获得 / 该组总数。
        // 之前这里用的是全站 earnedCount/total（含等级徽章），于是刚上线只有 1 枚独立徽章时
        // 会显示成「0/10 已获得」，与上面等级分组的「已点亮 0/3 级」自相矛盾。
        singleEarned: singles.filter((b) => b.earned).length,
        singleTotal: singles.length,
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
});
