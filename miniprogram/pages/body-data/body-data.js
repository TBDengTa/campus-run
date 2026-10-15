const auth = require('../../utils/request');
const fmt = require('../../utils/format');

const BMI_LEVEL_TEXT = {
  underweight: '偏轻',
  normal: '正常',
  overweight: '超重',
  obese: '偏胖',
};

// BMI 等级 → 一句话解读
const BMI_TIP = {
  underweight: '偏轻，建议循序渐进增加运动量',
  normal: '正常，保持规律运动维持状态',
  overweight: '超重，建议加强有氧运动改善体质',
  obese: '偏胖，建议从低强度有氧开始',
};

const GENDER_TEXT = { 0: '保密', 1: '男', 2: '女' };
const PREF_TEXT = { relaxed: '轻松', moderate: '适中', intense: '进阶' };

const NO_BMI_TIP = '填写身高与体重，自动算出 BMI 并匹配目标计划';
const NO_PLAN_SUMMARY = '进入目标计划中心，按 BMI 智能匹配并应用计划';

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

// 计划一句话摘要（每日/每周明细在 pages/goal-plan 独立页面）
function planSummaryText(plan) {
  const daily = plan && plan.daily;
  if (!daily) return NO_PLAN_SUMMARY;
  const parts = [];
  if (daily.stepsText) parts.push(`${daily.stepsText} 步`);
  if (daily.distanceText && daily.distanceText !== '--') parts.push(daily.distanceText);
  if (daily.calories) parts.push(`${daily.calories} 千卡`);
  return parts.length ? `每日 ${parts.join(' · ')}` : '查看每日 / 每周目标';
}

// 组装页面展示用 saved（bodyData 可为 null，plan 可为 null）
function buildSaved(bodyData, plan) {
  const hasBmi = !!(bodyData && bodyData.bmi);
  const level = (bodyData && bodyData.bmiLevel) || '';
  return {
    bmi: hasBmi ? bodyData.bmi : null,
    bmiLevel: hasBmi ? level : '',
    bmiLevelText: hasBmi ? BMI_LEVEL_TEXT[level] || '' : '',
    plan: planForDisplay(plan) || null,
  };
}

Page({
  data: {
    height: '',
    weight: '',
    gender: 0,
    genderText: '保密',
    preferenceLevel: 'moderate',
    preferenceText: '适中',
    preferenceOptions: [
      { value: 'relaxed', label: '轻松', desc: '温和起步' },
      { value: 'moderate', label: '适中', desc: '稳步提升' },
      { value: 'intense', label: '进阶', desc: '挑战自我' },
    ],
    weightUnit: 'kg', // kg | jin（斤），提交后端始终为 kg
    saved: null, // { bmi, bmiLevel, bmiLevelText, plan }
    bmiTip: NO_BMI_TIP,
    planSummary: NO_PLAN_SUMMARY,
    submitting: false,
    // 流量主横幅（ad-banner）闸门：首帧都是 false（不渲染），load() 里 ensureLogin 之后才置真
    isTeacher: false,
    showAd: false,
  },

  onLoad(options) {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    // 首页「目标计划 / 身体数据」两个入口共用本页，用 focus 定位到对应区块
    this.focus = (options && options.focus) || '';
    this.load().then(() => this.scrollToFocus());
  },

  async load() {
    try {
      await getApp().ensureLogin();
      // 流量主横幅（ad-banner）的两道闸门：角色已确认是学生才渲染，教师整块不进 DOM
      getApp().applyAdGate(this);
      // 注意：/api/goal/body-data 返回 { bodyData, currentPlan, planName, autoMatched, effective }，身体数据在 bodyData 内
      const [res, myPlan] = await Promise.all([
        auth.get('/api/goal/body-data'),
        auth.get('/api/goal/my-plan').catch(() => null),
      ]);
      const bodyData = (res && res.bodyData) || null;

      // 我的计划：优先用已填充的预设计划（字段最全），其次用户计划快照，最后用同一次请求里带的计划
      let plan = null;
      if (myPlan && myPlan.planId && typeof myPlan.planId === 'object') {
        plan = myPlan.planId;
      } else if (myPlan && myPlan.planName) {
        plan = { name: myPlan.planName, daily: myPlan.daily, weekly: myPlan.weekly };
      } else if (res && res.currentPlan) {
        plan = res.currentPlan;
      }

      const saved = buildSaved(bodyData, plan);
      const preferenceLevel = (bodyData && bodyData.preferenceLevel) || this.data.preferenceLevel;

      this.setData({
        height: bodyData ? String(bodyData.height || '') : '',
        weight: bodyData ? this.formatWeight(bodyData.weight) : '',
        preferenceLevel,
        preferenceText: PREF_TEXT[preferenceLevel] || '适中',
        saved,
        bmiTip: saved.bmi ? BMI_TIP[saved.bmiLevel] || '' : NO_BMI_TIP,
        planSummary: planSummaryText(saved.plan),
      });

      const me = await auth.get('/api/auth/me').catch(() => null);
      if (me) {
        const gender = me.gender || 0;
        this.setData({ gender, genderText: GENDER_TEXT[gender] || '保密' });
      }
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  // 体重显示换算（kg 存库，斤 = kg×2）
  formatWeight(kg) {
    if (!kg) return '';
    const n = Number(kg);
    return this.data.weightUnit === 'jin' ? String(Math.round(n * 2 * 10) / 10) : String(n);
  },

  // 体重单位切换（斤 / kg，显示换算，提交始终为 kg）
  switchUnit(e) {
    const unit = e.currentTarget.dataset.unit;
    if (unit === this.data.weightUnit) return;
    const weight = Number(this.data.weight);
    let converted = '';
    if (weight > 0) {
      converted = unit === 'jin' ? String(Math.round(weight * 2 * 10) / 10) : String(Math.round((weight / 2) * 10) / 10);
    }
    this.setData({ weightUnit: unit, weight: converted });
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
    const preferenceLevel = e.currentTarget.dataset.value;
    this.setData({ preferenceLevel, preferenceText: PREF_TEXT[preferenceLevel] || '适中' });
  },

  pickGender(e) {
    const gender = Number(e.currentTarget.dataset.value);
    this.setData({ gender, genderText: GENDER_TEXT[gender] || '保密' });
  },

  async submit() {
    const { height, weight, weightUnit, preferenceLevel, gender, submitting } = this.data;
    if (submitting) return;
    if (!height || !weight) {
      wx.showToast({ title: '请填写身高体重', icon: 'none' });
      return;
    }
    // 斤 → kg 换算（后端只收 kg）
    const weightKg = weightUnit === 'jin' ? Number(weight) / 2 : Number(weight);
    if (weightKg < 20 || weightKg > 300) {
      wx.showToast({ title: weightUnit === 'jin' ? '体重数值不合理（斤）' : '体重数值不合理（kg）', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      const result = await auth.post('/api/goal/body-data', {
        height: Number(height),
        weight: weightKg,
        preferenceLevel,
        gender,
      });
      const saved = buildSaved(result.bodyData, result.plan);
      this.setData({
        saved,
        weight: result.bodyData ? this.formatWeight(result.bodyData.weight) || weight : weight,
        bmiTip: saved.bmi ? BMI_TIP[saved.bmiLevel] || '' : NO_BMI_TIP,
        planSummary: planSummaryText(saved.plan),
      });
      wx.showToast({ title: '已保存并匹配计划', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  // 进入目标计划中心（AI 匹配 / 候选计划 / 一键应用）
  goGoalPlan() {
    wx.navigateTo({ url: '/pages/goal-plan/goal-plan' });
  },
});
