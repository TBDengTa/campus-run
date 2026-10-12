const auth = require('../../utils/request');

const BMI_LEVEL_TEXT = {
  underweight: '偏轻',
  normal: '正常',
  overweight: '超重',
  obese: '偏胖',
};

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

  onLoad() {
    this.load();
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const doc = await auth.get('/api/goal/body-data');
      if (doc) {
        this.setData({
          height: String(doc.height || ''),
          weight: String(doc.weight || ''),
          preferenceLevel: doc.preferenceLevel || 'moderate',
          saved: doc.bmi ? { bmi: doc.bmi, bmiLevelText: BMI_LEVEL_TEXT[doc.bmiLevel] || '' } : null,
        });
      }
      const me = await auth.get('/api/auth/me').catch(() => null);
      if (me) this.setData({ gender: me.gender || 0 });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
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
          plan: result.plan,
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
