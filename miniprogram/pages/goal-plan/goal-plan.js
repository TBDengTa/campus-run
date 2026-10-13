const auth = require('../../utils/request');

const PREF_TEXT = { relaxed: '轻松', moderate: '适中', intense: '进阶' };
const BMI_LEVEL_TEXT = { underweight: '偏轻', normal: '正常', overweight: '超重', obese: '偏胖' };

// 展示装饰：计划补充千分位/距离文案 + 与用户 BMI 的匹配标记
function decoratePlan(p, bmi) {
  const suitable = bmi != null && bmi >= p.bmiMin && bmi < p.bmiMax;
  return {
    ...p,
    dailyStepsText: Number(p.daily.steps || 0).toLocaleString(),
    dailyDistanceText: p.daily.distance >= 1000 ? `${(p.daily.distance / 1000).toFixed(1)} km` : `${p.daily.distance} m`,
    weeklyStepsText: Number(p.weekly.steps || 0).toLocaleString(),
    bmiRangeText: `${p.bmiMin} ~ ${p.bmiMax}`,
    prefText: PREF_TEXT[p.preferenceLevel] || p.preferenceLevel,
    suitable,
  };
}

Page({
  data: {
    effective: null, // 当前生效目标
    sourceText: '',
    bmi: null,
    bmiLevelText: '',
    plans: [], // 候选计划（装饰后）
    aiLoading: false,
    aiResult: null, // { bmi, bmiLevelText, plan, reasons }
    applyingPlanId: '',
    loading: true,
  },

  onShow() {
    this.load();
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const [effective, plans, bodyData] = await Promise.all([
        auth.get('/api/goal/effective'),
        auth.get('/api/goal/plans').catch(() => []),
        auth.get('/api/goal/body-data').catch(() => ({ bodyData: null })),
      ]);
      const bmi = bodyData?.bodyData?.bmi ?? null;
      this.setData({
        loading: false,
        effective: {
          ...effective,
          dailyStepsText: Number(effective.daily.steps || 0).toLocaleString(),
          dailyDistanceText: effective.daily.distance >= 1000 ? `${(effective.daily.distance / 1000).toFixed(1)} km` : `${effective.daily.distance} m`,
          weeklyStepsText: Number(effective.weekly.steps || 0).toLocaleString(),
        },
        sourceText:
          effective.source === 'plan' ? (effective.autoMatched ? 'AI 智能匹配' : '手动设置') : '系统默认目标',
        bmi,
        bmiLevelText: bmi != null ? BMI_LEVEL_TEXT[goalsBmiLevel(bmi)] || '' : '',
        plans: (plans || []).map((p) => decoratePlan(p, bmi)),
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

// 前端 BMI 等级判定（与后端规则一致）
function goalsBmiLevel(bmi) {
  if (bmi == null) return '';
  if (bmi < 18.5) return 'underweight';
  if (bmi < 24) return 'normal';
  if (bmi < 28) return 'overweight';
  return 'obese';
}
