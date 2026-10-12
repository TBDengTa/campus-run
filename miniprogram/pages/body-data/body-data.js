const auth = require('../../utils/request');
const fmt = require('../../utils/format');

const BMI_LEVEL_TEXT = {
  underweight: '偏轻',
  normal: '正常',
  overweight: '超重',
  obese: '偏胖',
};

// 展示用：为计划补齐千分位步数与带单位距离
function planForDisplay(plan) {
  if (!plan) return null;
  return {
    ...plan,
    daily: plan.daily
      ? {
          ...plan.daily,
          stepsText: fmt.formatNumber(plan.daily.steps),
          distanceText: plan.daily.distance ? fmt.formatDistance(plan.daily.distance) : '--',
        }
      : plan.daily,
    weekly: plan.weekly
      ? {
          ...plan.weekly,
          stepsText: fmt.formatNumber(plan.weekly.steps),
          distanceText: plan.weekly.distance ? fmt.formatDistance(plan.weekly.distance) : '--',
        }
      : plan.weekly,
  };
}

Page({
  data: {
    height: '',
    weight: '',
    gender: 0,
    preferenceLevel: 'moderate',
    preferenceOptions: [
      { value: 'relaxed', label: '轻松', desc: '温和起步' },
      { value: 'moderate', label: '适中', desc: '稳步提升' },
      { value: 'intense', label: '进阶', desc: '挑战自我' },
    ],
    saved: null, // { bmi, bmiLevelText, plan }
    submitting: false,
  },

  onLoad(options) {
    // 首页「目标计划 / 身体数据」两个入口共用本页，用 focus 定位到对应区块
    this.focus = (options && options.focus) || '';
    this.load().then(() => this.scrollToFocus());
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const [doc, myPlan] = await Promise.all([
        auth.get('/api/goal/body-data'),
        auth.get('/api/goal/my-plan').catch(() => null),
      ]);
      // 我的计划：优先用已填充的预设计划（字段最全），否则退回用户计划快照
      let plan = null;
      if (myPlan && myPlan.planId && typeof myPlan.planId === 'object') {
        plan = myPlan.planId;
      } else if (myPlan && myPlan.planName) {
        plan = { name: myPlan.planName, daily: myPlan.daily, weekly: myPlan.weekly };
      }
      if (doc) {
        this.setData({
          height: String(doc.height || ''),
          weight: String(doc.weight || ''),
          preferenceLevel: doc.preferenceLevel || 'moderate',
          saved: doc.bmi
            ? { bmi: doc.bmi, bmiLevelText: BMI_LEVEL_TEXT[doc.bmiLevel] || '', plan: planForDisplay(plan) }
            : plan
              ? { bmi: null, bmiLevelText: '', plan: planForDisplay(plan) }
              : null,
        });
      } else if (plan) {
        this.setData({ saved: { bmi: null, bmiLevelText: '', plan: planForDisplay(plan) } });
      }
      const me = await auth.get('/api/auth/me').catch(() => null);
      if (me) this.setData({ gender: me.gender || 0 });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  // 根据 focus 参数滚动到目标区块
  scrollToFocus() {
    const focus = this.focus;
    if (!focus) return;
    const hasPlan = !!(this.data.saved && this.data.saved.plan);
    const selector = focus === 'plan' ? (hasPlan ? '#plan-card' : '') : '#base-card';
    if (!selector) {
      wx.showToast({ title: '填写身体数据后自动匹配目标计划', icon: 'none' });
      return;
    }
    setTimeout(() => {
      wx.pageScrollTo({ selector, duration: 300, fail: () => {} });
    }, 260);
  },

  inputHeight(e) {
    this.setData({ height: e.detail.value });
  },

  inputWeight(e) {
    this.setData({ weight: e.detail.value });
  },

  pickPreference(e) {
    this.setData({ preferenceLevel: e.currentTarget.dataset.value });
  },

  pickGender(e) {
    this.setData({ gender: Number(e.currentTarget.dataset.value) });
  },

  async submit() {
    const { height, weight, preferenceLevel, gender, submitting } = this.data;
    if (submitting) return;
    if (!height || !weight) {
      wx.showToast({ title: '请填写身高体重', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      const result = await auth.post('/api/goal/body-data', {
        height: Number(height),
        weight: Number(weight),
        preferenceLevel,
        gender,
      });
      this.setData({
        saved: {
          bmi: result.bodyData.bmi,
          bmiLevelText: BMI_LEVEL_TEXT[result.bodyData.bmiLevel] || '',
          plan: planForDisplay(result.plan),
        },
      });
      wx.showToast({ title: '已保存并匹配计划', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
