// 学生会 · 复审台（分包 packageUnion）
//
// 用户 2026-11-02：「在学生会检查中的复审中，支持分数分类，并对每块显示检查人、
//   检查信息(简化)、检查图片，并增加批量审核功能。」
//
// 四条硬约束（改之前先读，都是会静默出错的地方）：
//   ① **分档与分类计数全部来自服务端**（`/api/union/review/queue` 的 bands / bandKey）：
//      前端自己映射一份「0-2 轻微 / 2-5 中等」的区间，一旦服务端改边界就会「筛选和徽标对不上」。
//   ② **每条的 canReview / reviewBlockReason 也由服务端下发**：自审禁令（不能复核自己提交的记录）
//      在客户端无法可靠判定（需要知道 identity 是不是主席团），前端只按这个开关勾选。
//   ③ 批量审核**逐条**（服务端逐条过权限），失败条目会回显原因；不要在前端预过滤掉失败条目 ——
//      那样用户永远不知道「为什么我选了 10 条只成功了 8 条」。
//   ④ 退回**必须填原因**（≥2 字，与单条复核同一口径 routes/union.js::/records/:id/review）。
const auth = require('../../utils/request');
const fmt = require('../../utils/format');

// 单次批量上限：与服务端 services/union-review.js 的 limit=50 同一口径。
// 前端也拦一道，避免「选了 80 条、服务端只处理前 50 条」这种静默截断。
const BATCH_LIMIT = 50;

Page({
  data: {
    loading: true,
    list: [],
    total: 0,
    page: 1,
    limit: 20,
    hasMore: false,
    loadingMore: false,
    // 分档（服务端下发；含每档条数）
    bands: [],
    band: '',
    // 模块筛选（只列有权限且有待复核的模块）
    modules: [],
    moduleKey: '',
    // 选中态：只在模板里显示「已选」与按钮可用；真正的集合在 this._sel（不放进 data，避免大对象 setData）
    selectedCount: 0,
    canReview: false,
  },

  onLoad() {
    if (!getApp().requireLogin()) return;
    this._sel = new Set();
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    this.load(true);
  },

  onPullDownRefresh() {
    this.load(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) this.load(false);
  },

  async load(reset) {
    const page = reset ? 1 : this.data.page + 1;
    // 与记录列表同一个并发护栏：onShow 与 onReachBottom 可能同时拉第一页
    if (!reset && (this.data.loading || this.data.loadingMore)) return;
    this.setData(reset ? { loading: true } : { loadingMore: true });
    try {
      await getApp().ensureLogin();
      const data = await auth.get('/api/union/review/queue', {
        page,
        limit: this.data.limit,
        band: this.data.band,
        moduleKey: this.data.moduleKey,
      });
      const rows = (data.list || []).map((r) => ({
        ...r,
        // 已在别的分页页里勾选过的条目，重新载入后要保持勾选态
        checked: !!(this._sel && this._sel.has(r.id)),
        // 扣分文案：10 分制下必须固定两位小数（0.05 / 1.50 / 10.00 同列对齐）。
        // 以前用 formatNumber（千分位整数风格），会出现「-0.05」与「-2」混排，
        // 复审的人扫一眼分不清「扣了两分」还是「扣了 0.2 分」。
        deductText: r.deduct ? `-${fmt.scoreText(r.deduct)}` : fmt.scoreText(0),
        photos: r.photos || [],
        // 照片被服务端裁剪（宿舍照片对无权者不下发原图）：给出可读说明，不留白
        photoMaskText: r.photosBlurred ? r.photoNote || '宿舍照片仅检查人 / 主席团 / 所属部门部长 / 教师可见' : '',
      }));
      // 重置时清空选择（避免「换了分档还勾着上一批的条目」这种幽灵选中）
      if (reset) this._sel = new Set();
      this.setData(
        {
          loading: false,
          loadingMore: false,
          list: reset ? rows : this.data.list.concat(rows),
          page,
          total: data.total || 0,
          hasMore: !!data.hasMore,
          bands: data.bands || [],
          band: data.band || '',
          modules: data.modules || [],
          moduleKey: data.moduleKey || '',
          canReview: true,
        },
        () => this.syncSelected()
      );
    } catch (e) {
      this.setData({ loading: false, loadingMore: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  // 选中态同步（只把「数量」与每行的 checked 写进 data；集合本身留在 this._sel）
  syncSelected() {
    const sel = this._sel || new Set();
    const list = this.data.list.map((r) => ({ ...r, checked: sel.has(r.id) }));
    this.setData({ list, selectedCount: sel.size });
  },

  onBandTap(e) {
    const key = e.currentTarget.dataset.key || '';
    // 再点一次同一个档 = 取消该档（回到全部），与其它页面 chip 的交互一致
    this.setData({ band: this.data.band === key ? '' : key, moduleKey: this.data.moduleKey }, () => this.load(true));
  },

  onModuleChange(e) {
    const index = Number(e.detail.value) || 0;
    const mod = index === 0 ? { key: '' } : this.data.modules[index - 1] || { key: '' };
    this.setData({ moduleKey: mod.key || '' }, () => this.load(true));
  },

  // 单条勾选：不可复核的条目直接拒绝（并说明原因），不做"勾上了但不能提交"的死胡同
  onToggle(e) {
    const id = e.currentTarget.dataset.id;
    const row = this.data.list.find((r) => r.id === id);
    if (!row) return;
    if (!row.canReview) {
      wx.showToast({ title: row.reviewBlockReason || '这条你不能复核', icon: 'none' });
      return;
    }
    if (this._sel.has(id)) this._sel.delete(id);
    else {
      if (this._sel.size >= BATCH_LIMIT) {
        wx.showToast({ title: `一次最多选 ${BATCH_LIMIT} 条`, icon: 'none' });
        return;
      }
      this._sel.add(id);
    }
    this.syncSelected();
  },

  // 全选本页「可复核」的条目（本页可能有自审记录，选不中的要让用户看得见数量差）
  onSelectPage() {
    let added = 0;
    for (const r of this.data.list) {
      if (!r.canReview || this._sel.has(r.id)) continue;
      if (this._sel.size >= BATCH_LIMIT) break;
      this._sel.add(r.id);
      added += 1;
    }
    this.syncSelected();
    if (!added) wx.showToast({ title: '本页没有可勾选的记录', icon: 'none' });
  },

  onClearSel() {
    this._sel = new Set();
    this.syncSelected();
  },

  idsOfSel() {
    return [...(this._sel || new Set())];
  },

  // 批量通过：直接执行（不需要原因）
  async onBatchApprove() {
    await this.postBatch(true, '');
  },

  // 批量退回：必须填原因（≥2 字，与服务端同一口径）
  onBatchReject() {
    const that = this;
    wx.showModal({
      title: `退回选中的 ${this.data.selectedCount} 条`,
      editable: true,
      placeholderText: '请填写退回原因（会写入每条记录的留痕）',
      success: (r) => {
        if (!r.confirm) return;
        const reason = (r.content || '').trim();
        if (reason.length < 2) {
          wx.showToast({ title: '请填写退回原因（至少 2 个字）', icon: 'none' });
          return;
        }
        that.postBatch(false, reason);
      },
    });
  },

  async postBatch(approve, reason) {
    const ids = this.idsOfSel();
    if (!ids.length) {
      wx.showToast({ title: '请先勾选要审核的记录', icon: 'none' });
      return;
    }
    wx.showLoading({ title: approve ? '批量通过中…' : '批量退回中…', mask: true });
    try {
      await getApp().ensureLogin();
      const data = await auth.post('/api/union/review/batch', { ids, approve, reason });
      wx.hideLoading();
      // 失败的条目逐条回显原因（用户要求「能看出为什么没通过」）
      const failedRows = (data.results || []).filter((x) => !x.ok);
      this._sel = new Set();
      if (failedRows.length) {
        wx.showModal({
          title: data.message || '部分未处理',
          content: failedRows
            .slice(0, 8)
            .map((x, i) => `${i + 1}. ${x.message || '操作失败'}`)
            .join('\n'),
          showCancel: false,
        });
      } else {
        wx.showToast({ title: data.message || '已处理', icon: 'success' });
      }
      await this.load(true);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '批量审核失败', icon: 'none' });
    }
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/packageUnion/record/record?id=${id}` });
  },

  previewPhoto(e) {
    const ds = e.currentTarget.dataset;
    const row = this.data.list.find((r) => r.id === ds.id);
    if (!row || !row.photos || !row.photos.length) return;
    wx.previewImage({ urls: row.photos, current: row.photos[ds.index || 0] });
  },
});
