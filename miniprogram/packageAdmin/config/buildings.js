// 楼名管理（系统设置）：教学用楼 / 宿舍用楼两份白名单
//
// 用户 2026-10-21「为了防止教室、宿舍被学生不统一填写。请在系统设置中增加教学用楼的楼名列表
// 与宿舍用楼的楼名列表，这样学生先选择楼名自己再去填写门牌号(纯数字)这样就统一了。」
//
// 为什么是两份而不是一份：
//   教学楼不会出现在查宿名单里，宿舍楼也不会被当成教室。混成一份会让人选错楼，
//   而选错楼导致的错数据比不填更难发现（门牌号看起来是对的，只是楼错了）。
//
// 路径：本文件在 miniprogram/packageAdmin/config/ → 到 miniprogram/utils 是 ../../utils
// （写成 ../../../utils/request 会 require 失败 → 页面 JS 直接抛错 → 整页点击全部失效）
const auth = require('../../utils/request');

Page({
  // 权限重算（用户 2026-10-22「登录账户时一定要刷新缓存」）：
  // 换账号登录后页面 data 里的 canManage 可能还是上一个身份的结论 ——
  // 表现就是「只读账号仍看到操作按钮」。onShow 与登录回调都会调这里。
  refreshPermission() {
    const user = getApp().globalData.userInfo || {};
    const perms = user.effectivePermissions || [];
    this.setData({ canManage: perms.includes('*') || perms.includes('building.manage') || perms.includes('config.manage') });
  },

  data: {
    loading: true,
    canManage: false,
    teaching: [], // 教学用楼楼名
    dorm: [], // 宿舍用楼楼名
    teachingInput: '',
    dormInput: '',
  },

  onLoad() {
    if (!getApp().requireLogin()) return;
    const user = getApp().globalData.userInfo || {};
    const perms = user.effectivePermissions || [];
    // 与后端同一口径：building.manage 才可增删；config.manage（或超管）也放行，
    // 否则「以前能改系统配置的人」打开这页会突然只能看不能改。
    const canManage =
      perms.includes('*') || perms.includes('building.manage') || perms.includes('config.manage');
    this.setData({ canManage });
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    this.refreshPermission();
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    try {
      const res = await auth.get('/api/admin/config/buildings');
      this.setData({
        teaching: (res && res.teaching) || [],
        dorm: (res && res.dorm) || [],
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '读取失败', icon: 'none' });
    }
  },

  onTeachingInput(e) {
    this.setData({ teachingInput: e.detail.value });
  },

  onDormInput(e) {
    this.setData({ dormInput: e.detail.value });
  },

  // 添加楼名：去空白、查重、限长（与后端 normalizeBuildings 同口径，前端先拦一次给出即时反馈）
  addTeaching() {
    this.addToList('teaching', 'teachingInput');
  },

  addDorm() {
    this.addToList('dorm', 'dormInput');
  },

  addToList(field, inputKey) {
    if (!this.requireManage()) return;
    const raw = String(this.data[inputKey] || '').trim();
    if (!raw) {
      wx.showToast({ title: '请输入楼名', icon: 'none' });
      return;
    }
    if (raw.length > 20) {
      wx.showToast({ title: '楼名最多 20 个字', icon: 'none' });
      return;
    }
    const list = this.data[field] || [];
    if (list.includes(raw)) {
      wx.showToast({ title: '这个楼名已经在列表里了', icon: 'none' });
      return;
    }
    if (list.length >= 60) {
      wx.showToast({ title: '最多 60 个楼名', icon: 'none' });
      return;
    }
    this.setData({ [field]: list.concat([raw]), [inputKey]: '' });
    this.save(field, list.concat([raw]));
  },

  // 删除楼名（二次确认：删掉后已用它填过的教室/宿舍不会自动清理，要讲清楚）
  removeBuilding(e) {
    if (!this.requireManage()) return;
    const { field, name } = e.currentTarget.dataset;
    const that = this;
    wx.showModal({
      title: `删除「${name}」？`,
      content: '已经用这个楼名填过的教室 / 宿舍不会被改动，只是以后不能再选了。',
      success: (r) => {
        if (!r.confirm) return;
        const next = (that.data[field] || []).filter((x) => x !== name);
        that.setData({ [field]: next });
        that.save(field, next);
      },
    });
  },

  // 保存：每次都提交**完整**两份清单（后端是整体覆盖），
  // 只传其中一份会让另一份被清空 —— 所以必须两个字段一起发。
  async save(field, list) {
    const payload = {
      teaching: field === 'teaching' ? list : this.data.teaching,
      dorm: field === 'dorm' ? list : this.data.dorm,
    };
    try {
      await auth.put('/api/admin/config', { buildings: payload });
      wx.showToast({ title: '已保存', icon: 'success' });
      await this.load();
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
      await this.load(); // 失败回滚到服务端真实状态，避免界面与库里不一致
    }
  },

  requireManage() {
    if (this.data.canManage) return true;
    wx.showToast({ title: '没有修改权限（需要 config.manage）', icon: 'none' });
    return false;
  },
});
