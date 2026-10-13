const auth = require('../../utils/request');

const PREF_TEXT = { relaxed: '轻松', moderate: '适中', intense: '进阶' };
const BMI_LEVEL_TEXT = { underweight: '偏轻', normal: '正常', overweight: '超重', obese: '偏胖' };

// 说明：手动可选范围 = 全部「适合你的」计划（不截断），AI 匹配区在上方优先展示
const MAX_SUITABLE = 4; // 仅用于兜底逻辑的注释参考：现在手动可选范围 = 全部匹配计划，不再截断

// 前端 BMI 等级判定（与后端 services/goals.js::bmiLevel 一致）
function goalsBmiLevel(bmi) {
  if (bmi == null) return '';
  if (bmi < 18.5) return 'underweight';
  if (bmi < 24) return 'normal';
  if (bmi < 28) return 'overweight';
  return 'obese';
}

// 与后端 goals.calcBmi 一致：body_data 里没存 bmi 时用身高体重兜底
function calcBmi(heightCm, weightKg) {
  if (!heightCm || !weightKg) return null;
  const h = heightCm / 100;
  return Math.round((weightKg / (h * h)) * 10) / 10;
}

// 计划模型里的 gender 取值是 male / female / all；用户 gender 是 0 未知 1 男 2 女
function genderKeyOf(gender) {
  if (gender === 1) return 'male';
  if (gender === 2) return 'female';
  return 'unknown';
}

function genderTextOf(g) {
  if (g === 'male') return '男生专属';
  if (g === 'female') return '女生专属';
  return '男女通用';
}

function fmtDistance(m) {
  const v = Number(m || 0);
  return v >= 1000 ? `${(v / 1000).toFixed(1)} km` : `${v} m`;
}

// 强度短标签：计划库按「轻松版 / 适中版 / 激进版」命名，而 preferenceLevel 只有 relaxed/moderate 两档，
// 区分不出「适中」与「激进」，所以优先从名字取，取不到再回退 preferenceLevel。
function levelOf(p) {
  const name = String((p && p.name) || '');
  if (/轻松/.test(name)) return 'relaxed';
  if (/适中/.test(name)) return 'moderate';
  if (/激进/.test(name)) return 'intense';
  return (p && p.preferenceLevel) || 'moderate';
}

const LEVEL_TEXT = { relaxed: '轻松', moderate: '适中', intense: '进阶' };
const LEVEL_ORDER = { relaxed: 0, moderate: 1, intense: 2 };

/**
 * 「适合你」判定 —— 与后端 services/goals.js::matchPlan 同维度：
 *   1) BMI 区间 ：bmi >= plan.bmiMin && bmi < plan.bmiMax
 *                 （计划数据里：偏轻 10~18.4、正常 18.5~23.9、偏重 24~100）
 *   2) 性别     ：plan.gender 为 'all' 通用；否则要与用户性别一致；性别未填时不做排除
 *   3) 运动强度 ：**不作为筛选条件** —— 三档强度（轻松/适中/激进）都留在候选里让用户自己挑，
 *                 只参与排序（符合偏好的排前面）。这样性别未填时，一个 BMI 档位能看到
 *                 3 档强度 × 2 性别 = 6 个计划；性别已知时是 3 个。
 * 说明：计划模型没有年龄字段，故 birthdate 只做展示参考，不参与匹配。
 */
function decoratePlan(p, ctx) {
  const bmiHit = ctx.bmi != null && ctx.bmi >= p.bmiMin && ctx.bmi < p.bmiMax;
  const genderHit = p.gender === 'all' ? true : ctx.gender === 'unknown' ? null : p.gender === ctx.gender;
  const suitable = bmiHit && genderHit !== false;

  const level = levelOf(p);
  const prefMatched = ctx.pref == null || level === ctx.pref;

  // 命中理由（最多 2 条，卡片上信息别堆太多）
  const reasons = [];
  if (bmiHit) reasons.push(`BMI ${ctx.bmi} 匹配`);
  if (prefMatched && ctx.pref != null) reasons.push('符合你的强度偏好');
  if (genderHit === null) reasons.push('性别待完善');

  return {
    ...p,
    dailyStepsText: Number((p.daily && p.daily.steps) || 0).toLocaleString(),
    dailyDistanceText: fmtDistance(p.daily && p.daily.distance),
    dailyCaloriesText: `${Number((p.daily && p.daily.calories) || 0)}`,
    weeklyStepsText: Number((p.weekly && p.weekly.steps) || 0).toLocaleString(),
    bmiRangeText: `${p.bmiMin} ~ ${p.bmiMax}`,
    prefText: PREF_TEXT[p.preferenceLevel] || p.preferenceLevel,
    level,
    levelText: LEVEL_TEXT[level] || '适中',
    genderText: genderTextOf(p.gender),
    suitable,
    isCurrent: !!ctx.currentPlanId && String(p._id) === String(ctx.currentPlanId),
    prefMatched,
    reasons: reasons.slice(0, 2),
    // 排序用：BMI 区间越窄越精准（与后端 sort 一致）、性别专属优先、强度由轻到重
    bmiSpan: (p.bmiMax || 0) - (p.bmiMin || 0),
    genderAll: p.gender === 'all',
    steps: (p.daily && p.daily.steps) || 0,
  };
}

function sortPlans(list) {
  return list.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1; // 当前生效的排最前
    if (a.prefMatched !== b.prefMatched) return a.prefMatched ? -1 : 1; // 符合强度偏好的靠前
    if (a.bmiSpan !== b.bmiSpan) return a.bmiSpan - b.bmiSpan; // 区间越窄＝越精准
    if (a.genderAll !== b.genderAll) return a.genderAll ? 1 : -1; // 性别专属优先
    const la = LEVEL_ORDER[a.level] ?? 1;
    const lb = LEVEL_ORDER[b.level] ?? 1;
    if (la !== lb) return la - lb; // 轻松 → 适中 → 进阶
    return a.steps - b.steps;
  });
}

Page({
  data: {
    effective: null, // 当前生效目标
    sourceText: '',
    bmi: null,
    bmiLevelText: '',
    matchBasisText: '', // 匹配依据文案（展示在「适合你的计划」右侧）
    needBodyData: false, // 没填身高体重 → 无法按 BMI 匹配
    suitablePlans: [], // 适合你的计划（= 手动可选的完整范围，已排序）
    plans: [], // 全部候选计划（装饰后，保留原字段以兼容）
    aiLoading: false,
    aiResult: null, // { bmi, bmiLevelText, plan, reasons }
    applyingPlanId: '',
    loading: true,
  },

  onShow() {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    this.load();
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const [effective, plans, bodyResp] = await Promise.all([
        auth.get('/api/goal/effective'),
        auth.get('/api/goal/plans').catch(() => []),
        auth.get('/api/goal/body-data').catch(() => ({ bodyData: null })),
      ]);

      const body = (bodyResp && bodyResp.bodyData) || null;
      const bmi = (body && body.bmi) || calcBmi(body && body.height, body && body.weight);
      // 运动强度偏好来自身体数据（后端 matchPlan 也是取这里的 preferenceLevel）
      const pref = (body && body.preferenceLevel) || 'moderate';
      // 性别来自用户资料（0 未知 / 1 男 / 2 女）
      const user = (getApp().globalData && getApp().globalData.userInfo) || auth.getUser() || {};
      const ctx = {
        bmi,
        pref,
        gender: genderKeyOf(user.gender),
        currentPlanId: (bodyResp && bodyResp.currentPlan && bodyResp.currentPlan._id) || null,
      };

      const decorated = (plans || []).map((p) => decoratePlan(p, ctx));
      // 只展示匹配的计划（不截断：手动调整的可选范围就是匹配结果，不能让用户选不到）
      let suitable = sortPlans(decorated.filter((p) => p.suitable));

      // 同强度去重：通用计划（gender=all，区间 10~30 的兜底计划）与性别专属计划强度重复时，
      // 只保留更精准的性别专属计划 —— 这样每个 BMI 档位都是「轻松/适中/进阶」三档：
      // 性别已知 3 个；性别未填时 3 档 × 2 性别 = 6 个（原话：三种运动强度也就是 6 个）。
      const specificLevels = new Set(suitable.filter((p) => p.gender !== 'all').map((p) => p.level));
      suitable = suitable.filter((p) => p.gender !== 'all' || !specificLevels.has(p.level));

      // 与后端一致的回退：一条都不匹配时用默认计划兜底（例如 BMI 正好落在 18.4~18.5 的空档）
      if (!suitable.length) {
        suitable = decorated
          .filter((p) => p.isDefault)
          .map((p) => ({ ...p, reasons: ['暂无完全匹配，回退系统默认'] }));
      }

      const basis = [];
      if (bmi != null) basis.push(`BMI ${bmi}`);
      basis.push(ctx.gender === 'male' ? '男生' : ctx.gender === 'female' ? '女生' : '性别未填');
      basis.push(`${PREF_TEXT[pref] || pref}强度`);

      this.setData({
        loading: false,
        effective: {
          ...effective,
          dailyStepsText: Number((effective.daily && effective.daily.steps) || 0).toLocaleString(),
          dailyDistanceText: fmtDistance(effective.daily && effective.daily.distance),
          dailyCaloriesText: `${Number((effective.daily && effective.daily.calories) || 0)}`,
          weeklyStepsText: Number((effective.weekly && effective.weekly.steps) || 0).toLocaleString(),
        },
        sourceText: effective.source === 'plan' ? (effective.autoMatched ? 'AI 智能匹配' : '手动设置') : '系统默认目标',
        bmi,
        bmiLevelText: bmi != null ? BMI_LEVEL_TEXT[goalsBmiLevel(bmi)] || '' : '',
        matchBasisText: basis.join(' · '),
        needBodyData: bmi == null,
        suitablePlans: suitable,
        plans: decorated,
      });
    } catch (e) {
      this.setData({ loading: false });
      if (e.code === 403003) return;
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  // AI 智能匹配
  async aiMatch() {
    if (this.data.aiLoading) return;
    this.setData({ aiLoading: true });
    try {
      const res = await auth.post('/api/goal/ai-match', {});
      this.setData({ aiResult: res });
      wx.vibrateShort({ type: 'light' });
    } catch (e) {
      if (e.code === 400 && /身高/.test(e.message)) {
        wx.showModal({
          title: '需要身体数据',
          content: 'AI 匹配需要您的身高体重信息，是否前往填写？',
          confirmText: '去填写',
          success: (r) => {
            if (r.confirm) wx.navigateTo({ url: '/pages/body-data/body-data?focus=body' });
          },
        });
        return;
      }
      wx.showToast({ title: e.message || 'AI 匹配失败', icon: 'none' });
    } finally {
      this.setData({ aiLoading: false });
    }
  },

  // 应用 AI 推荐的计划
  async applyAi() {
    const plan = this.data.aiResult && this.data.aiResult.plan;
    if (plan) this.applyPlan(plan._id);
  },

  // 应用某个候选计划
  applyCandidate(e) {
    this.applyPlan(e.currentTarget.dataset.id);
  },

  async applyPlan(planId) {
    if (this.data.applyingPlanId) return;
    this.setData({ applyingPlanId: planId });
    try {
      await auth.post('/api/goal/apply', { planId });
      wx.showToast({ title: '目标计划已更新', icon: 'success' });
      await this.load();
    } catch (e) {
      wx.showToast({ title: e.message || '应用失败', icon: 'none' });
    } finally {
      this.setData({ applyingPlanId: '' });
    }
  },

  goBodyData() {
    wx.navigateTo({ url: '/pages/body-data/body-data?focus=body' });
  },
});

