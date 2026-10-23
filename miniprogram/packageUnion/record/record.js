// 检查记录详情（分包 packageUnion）：分区卡片（基本信息 / 扣分与指标 / 明细 / 照片 / 申诉与复核留痕）
// + 底部固定操作栏（复核通过 / 提交修改 / 申诉 不随内容滚走）
//
// 三种操作权限都由服务端下发（canEdit / canReview / canAppeal），前端只按开关渲染按钮，
// 点了之后仍由服务端二次校验 —— 前端隐藏不是权限。
const auth = require('../../utils/request');

// 时段展示（与 packageUnion/entry 的 periodLabel 同口径；那边未导出，这里保留只读副本）
const PERIOD_TEXT = {
  morning: '早上',
  morning_class: '早八',
  daytime: '白天',
  evening_study: '晚自习',
  night: '夜间',
};

// 宿舍照片裁剪后的兜底文案（服务端 photoNote 为空时用；口径见 services/union.js::PHOTO_MASK_TEXT）
const PHOTO_MASK_FALLBACK = '宿舍照片仅检查人 / 主席团 / 所属部门部长 / 教师可见';

Page({
  data: {
    loading: true,
    id: '',
    record: null,
    module: null,
    fields: [],
    canEdit: false,
    canReview: false,
    canAppeal: false,
    basicRows: [],
    detailRows: [],
    metricRows: [],
    history: [],
    // 日期 / 时段 / 照片占位 / 底部操作栏
    dateText: '',
    periodText: '',
    photoMaskTitle: '',
    photoMaskText: '',
    hasActions: false,
  },

  onLoad(options) {
    if (!getApp().requireLogin()) return;
    this.setData({ id: options.id || '' });
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    this.load();
  },

  async load() {
    if (!this.data.id) {
      this.setData({ loading: false });
      return;
    }
    try {
      await getApp().ensureLogin();
      const data = await auth.get(`/api/union/records/${this.data.id}`);
      const record = data.record || {};
      const module = data.module || null;
      const fields = (module && module.fields) || [];
      // ⚠️ record / module 必须显式传进 buildRows：
      //    旧写法在 setData 之前读 this.data.record / this.data.module（首次进页面时都还是 null），
      //    导致「关键指标」第一次加载**恒为空**，第二次 onShow 重新加载才出现 —— 这里一次算对。
      const built = this.buildRows(fields, record.details || {}, record, module);
      const dateText = record.date ? `${Number(record.date.slice(5, 7))}月${Number(record.date.slice(8, 10))}日` : '';
      const periodText = record.period ? PERIOD_TEXT[record.period] || record.period : '全天';
      const canReview = !!data.canReview;
      const canEdit = !!data.canEdit;
      const canAppeal = !!data.canAppeal;
      const appealPending = !!(record.appeal && record.appeal.status === 'pending');
      // 底部固定操作栏：主操作一个（复核通过 / 申诉成立 / 提交修改 / 发起申诉）、
      // 次操作一个（退回 / 驳回申诉 / 发起申诉）。同一时刻只展示两个按钮，但**不丢任何既有操作**：
      //   待复核 → 退回（次）+ 复核通过（主）
      //   申诉待处理 → 驳回申诉（次）+ 申诉成立（主）
      //   其余 → 有修改权时「提交修改」，否则有申诉权时「发起申诉」
      //
      // ⚠️ 语义纠正（用户反馈「为什么这个页面是提交修改呢」）：
      //   原判断只看 canEdit，**不看 status** → 一条**已复核 / 已退回 / 已取消**的记录，
      //   只要你是提交人或复核者，底部就仍然显示「提交修改」，像是还能改。
      //   实际服务端对「已复核 + 非复核者」会 403（routes/union.js:923），
      //   且已复核的记录再改会污染已确认的评比结果 —— 所以只有**仍可编辑的状态**才给这个按钮。
      //   已终态（approved / rejected / cancelled）时改为展示申诉入口（若还有申诉权），
      //   否则不显示任何主按钮（只留一行状态说明），避免给出一个点了会失败的操作。
      const editable = record.status === 'submitted' || record.status === 'cancelled';
      // 「能复核」与「能修改」**可以同时成立**（如主席团复核自己代录的记录）：
      //   主/次按钮留给复核动作，另外给一个轻量的「修改」入口 ——
      //   否则这类记录一放开复核权限，就再也找不到改内容的入口了。
      let barMain = '';
      let barGhost = '';
      let barEdit = false;
      if (canReview && record.status === 'submitted') {
        barMain = 'approve';
        barGhost = 'reject';
        barEdit = canEdit && editable;
      } else if (canReview && appealPending) {
        barMain = 'approveAppeal';
        barGhost = 'rejectAppeal';
      } else if (canEdit && editable) {
        barMain = 'edit';
        if (canAppeal) barGhost = 'appeal';
      } else if (canAppeal) {
        barMain = 'appeal';
      }
      const basic = [];
      if (record.targetName) basic.push({ key: 'target', label: '受检对象', value: record.targetName, wide: true });
      // 班级与受检对象同名时不重复占一行（班级类检查最常见）
      if (record.className && record.className !== record.targetName) {
        basic.push({ key: 'class', label: '班级', value: record.className, wide: true });
      }
      basic.push({ key: 'date', label: '检查日期', value: dateText || record.date || '—' });
      basic.push({ key: 'period', label: '时段', value: periodText });
      basic.push({ key: 'inspector', label: '检查人', value: record.inspectorName || '—' });
      if (record.departmentName) basic.push({ key: 'dept', label: '检查部门', value: record.departmentName });
      const photoCount = record.photoCount || 0;
      this.setData({
        loading: false,
        record: {
          ...record,
          statusClass: record.status === 'approved' ? 'done' : record.status === 'submitted' ? 'todo' : 'warn',
        },
        module,
        fields,
        basicRows: basic,
        detailRows: built.rows,
        metricRows: built.metrics,
        canEdit,
        canReview,
        canAppeal,
        barMain,
        barGhost,
        barEdit,
        // 自己是提交人、又没有自审权（部长）时，页面要说明「为什么没有复核按钮」，
        // 否则用户只看到一个「提交修改」，会以为是页面出错了（用户报障原话）。
        selfReviewBlocked: !!data.selfReviewBlocked,
        dateText,
        periodText,
        // 复核时间（服务端 reviewedAt 一直有值，但旧模板没展示 → 留痕只有人、没有时间）
        reviewedAtText: formatAt(record.reviewedAt),
        // 申诉的「谁提的 / 谁判的 / 什么时候」——只写理由等于半条痕迹
        appealAtText: formatAt(record.appeal && record.appeal.at),
        appealReviewedAtText: formatAt(record.appeal && record.appeal.reviewedAt),
        // 照片被服务端裁剪（photos=[] + photosBlurred）时给可读提示，而不是一片空白
        photoMaskTitle: record.photosBlurred
          ? photoCount
            ? `照片已隐藏（${photoCount} 张）`
            : '照片已隐藏'
          : '',
        photoMaskText: record.photosBlurred ? record.photoNote || PHOTO_MASK_FALLBACK : '',
        hasActions: !!(barMain || barGhost || barEdit),
        // 留痕列表：服务端在 withDetails 出口下发 history（含复核 / 取消 / 提交修改）。
        // 逐项把 changes 渲染成人话（「状态：已提交 → 已复核」），比只写「改了 N 项」有用得多。
        history: (record.history || []).slice().reverse().map((h) => ({
          revision: h.revision,
          byName: h.byName || '—',
          atText: formatAt(h.at),
          changeText: h.changes && Object.keys(h.changes).length ? `改了 ${Object.keys(h.changes).length} 项` : '无字段变化',
          lines: changeLines(h.changes),
        })),
      });
      wx.setNavigationBarTitle({ title: (module && module.name) || record.moduleName || '检查记录' });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  // 明细按模块字段定义渲染（人数 / 名单 / 检查项 / 文本）；出勤率等派生指标取自服务端 metrics 快照
  buildRows(fields, details, record, module) {
    const rows = [];
    for (const f of fields || []) {
      // 照片在下方「留证照片」区单独展示，不在明细里重复成一行「现场照片」
      if (f.type === 'photo' || f.type === 'photos' || f.type === 'image') continue;
      const v = details[f.key];
      if (v === undefined || v === null || v === '') continue;
      if (f.type === 'students') {
        if (!Array.isArray(v) || !v.length) continue;
        rows.push({
          key: f.key,
          label: f.label || f.key,
          text: `${v.length} 人`,
          list: v.map((s) => `${s.name || '—'}${s.studentId ? ` (${s.studentId})` : ''}${s.reason ? ` · ${s.reason}` : ''}`),
        });
        continue;
      }
      if (f.type === 'items') {
        if (!Array.isArray(v) || !v.length) continue;
        const total = v.reduce((a, b) => a + (Number(b.score) || 0), 0);
        const max = v.reduce((a, b) => a + (Number(b.max) || 0), 0);
        rows.push({
          key: f.key,
          label: f.label || f.key,
          text: `${total} / ${max}`,
          list: v.map((it) => `${it.label}：${it.score}/${it.max}`),
        });
        continue;
      }
      if (f.type === 'select') {
        const arr = Array.isArray(v) ? v : [v];
        if (!arr.length) continue;
        rows.push({ key: f.key, label: f.label || f.key, text: arr.join('、') });
        continue;
      }
      rows.push({ key: f.key, label: f.label || f.key, text: String(v) });
    }
    // 派生指标来自服务端快照（record.metrics = { ratios, values }），这里只做单位换算
    const ratios = (record && record.metrics && record.metrics.ratios) || {};
    const values = (record && record.metrics && record.metrics.values) || {};
    const metrics = [];
    for (const m of (module && module.metrics) || []) {
      // 得分已在顶部「扣分与指标」大数字里展示，避免关键指标再重复一张 0 分卡
      if (m.key === 'score') continue;
      if (m.unit === '%') {
        if (ratios[m.key] === undefined) continue;
        metrics.push({ key: m.key, label: m.name, text: `${Math.round(ratios[m.key] * 1000) / 10}%` });
      } else {
        if (values[m.key] === undefined) continue;
        metrics.push({ key: m.key, label: m.name, text: `${Math.round(values[m.key] * 10) / 10}${m.unit || ''}` });
      }
    }
    return { rows, metrics };
  },

  async review(e) {
    const approve = e.currentTarget.dataset.approve === '1';
    const that = this;
    if (approve) {
      await this.postReview(true, '');
      return;
    }
    wx.showModal({
      title: '退回记录',
      editable: true,
      placeholderText: '请填写退回原因（如：人数与实到不符）',
      success: async (r) => {
        if (!r.confirm) return;
        const reason = (r.content || '').trim();
        if (reason.length < 2) {
          wx.showToast({ title: '请填写退回原因', icon: 'none' });
          return;
        }
        await that.postReview(false, reason);
      },
    });
  },

  async postReview(approve, reason) {
    try {
      await auth.post(`/api/union/records/${this.data.id}/review`, { approve, reason });
      wx.showToast({ title: approve ? '已复核' : '已退回', icon: 'success' });
      await this.load();
    } catch (e) {
      wx.showToast({ title: e.message || '操作失败', icon: 'none' });
    }
  },

  appeal() {
    const that = this;
    wx.showModal({
      title: '发起申诉',
      editable: true,
      placeholderText: '请说明申诉理由（不少于 5 个字）',
      success: async (r) => {
        if (!r.confirm) return;
        const reason = (r.content || '').trim();
        if (reason.length < 5) {
          wx.showToast({ title: '理由不少于 5 个字', icon: 'none' });
          return;
        }
        try {
          await auth.post(`/api/union/records/${that.data.id}/appeal`, { reason });
          wx.showToast({ title: '已提交申诉', icon: 'success' });
          await that.load();
        } catch (e) {
          wx.showToast({ title: e.message || '提交失败', icon: 'none' });
        }
      },
    });
  },

  // 申诉处理（用户 2026-10-19 口径）
  //   驳回：只填理由，记录完全不动。
  //   成立：**必须真的改判**，两种收尾——
  //     ① 更正记录内容：去录入台改数据（评价/名单等），按更正后的数据重算扣分，并当场结案；
  //     ② 作废：确属误录，整条退出统计。
  //   ⚠️ 刻意**没有**「撤销扣分/记满分」：申诉成立不等于该班表现满分，
  //      只是原判定不对；直接记满分是错的口径（用户明确否掉）。
  reviewAppeal(e) {
    const approve = e.currentTarget.dataset.approve === '1';
    if (!approve) {
      this.askAppealResult({ approve: false, voidIt: false });
      return;
    }
    const that = this;
    wx.showActionSheet({
      itemList: ['更正记录内容（改完自动结案）', '作废该记录（误录，退出统计）'],
      success: (r) => {
        if (r.tapIndex === 0) {
          that.goCorrectForAppeal();
          return;
        }
        that.askAppealResult({ approve: true, voidIt: true });
      },
      fail: () => {},
    });
  },

  // 更正记录内容：跳录入台（自动定位到这条记录并预填），带 appealReview=1
  // 录入台提交时会把 settleAppeal 一起发给服务端 → 一条 revision 里同时记「改了什么 + 申诉成立」。
  goCorrectForAppeal() {
    const r = this.data.record || {};
    if (!r.id) return;
    const q = [
      `moduleKey=${encodeURIComponent(r.moduleKey || '')}`,
      `recordId=${encodeURIComponent(r.id)}`,
      'appealReview=1',
    ];
    if (r.targetId) q.push(`targetId=${encodeURIComponent(r.targetId)}`);
    if (r.date) q.push(`date=${encodeURIComponent(r.date)}`);
    if (r.period) q.push(`period=${encodeURIComponent(r.period)}`);
    const url = `/packageUnion/entry/entry?${q.join('&')}`;
    const failToast = () => wx.showToast({ title: '打开录入台失败，请从「记录」重新进入', icon: 'none' });
    const stack = (typeof getCurrentPages === 'function' && getCurrentPages()) || [];
    if (stack.length >= 9) {
      wx.redirectTo({ url, fail: failToast });
      return;
    }
    wx.navigateTo({ url, fail: () => wx.redirectTo({ url, fail: failToast }) });
  },

  // 第二步：填处理意见并提交
  askAppealResult({ approve, voidIt }) {
    const that = this;
    wx.showModal({
      title: approve ? (voidIt ? '申诉成立 · 作废记录' : '申诉成立 · 撤销扣分') : '申诉驳回',
      editable: true,
      placeholderText: approve ? '改判说明（选填，会写入留痕）' : '请填写驳回理由',
      success: async (r) => {
        if (!r.confirm) return;
        const result = (r.content || '').trim();
        if (!approve && result.length < 2) {
          wx.showToast({ title: '请填写驳回理由', icon: 'none' });
          return;
        }
        try {
          await auth.post(`/api/union/records/${that.data.id}/appeal/review`, { approve, result, void: !!voidIt });
          wx.showToast({ title: approve ? '已改判' : '已驳回', icon: 'success' });
          await that.load();
        } catch (err) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      },
    });
  },

  // 「修改 / 提交修改」→ 录入台，并**定位到这条记录**。
  // 旧实现只传 moduleKey（跨组遗留，见 docs/union-ui-b-round.md），进去后停在对象列表上，
  // 用户得自己再找到那个受检对象才能改 —— 等于「提交修改」点了没反应。
  // 现在把「记录 id + 受检对象 + 日期 + 时段」一起传过去，由录入台自动开抽屉并预填该记录。
  //
  // ⚠️ 跳转必须有失败兜底（用户报障「点击修改没有效果」）：
  //   wx.navigateTo 在**页面栈满（10 层）**时会直接失败，而且**没有任何界面反馈** ——
  //   用户看到的就是「点了没反应」。所以：① 栈快满时直接 redirectTo（替换当前页）；
  //   ② navigateTo 失败也退到 redirectTo；③ 两者都失败才提示，绝不再静默。
  edit() {
    const r = this.data.record || {};
    if (!r.id) return;
    const q = [
      `moduleKey=${encodeURIComponent(r.moduleKey || '')}`,
      `recordId=${encodeURIComponent(r.id)}`,
    ];
    if (r.targetId) q.push(`targetId=${encodeURIComponent(r.targetId)}`);
    if (r.date) q.push(`date=${encodeURIComponent(r.date)}`);
    if (r.period) q.push(`period=${encodeURIComponent(r.period)}`);
    const url = `/packageUnion/entry/entry?${q.join('&')}`;
    const failToast = () => wx.showToast({ title: '打开录入台失败，请从「记录」重新进入', icon: 'none' });
    // getCurrentPages 在个别基础库/测试环境可能不存在，存在才判栈深
    const stack = (typeof getCurrentPages === 'function' && getCurrentPages()) || [];
    if (stack.length >= 9) {
      // 栈已 9 层以上：再 navigateTo 大概率失败，直接替换当前页（详情页本身可以离开）
      wx.redirectTo({ url, fail: failToast });
      return;
    }
    wx.navigateTo({ url, fail: () => wx.redirectTo({ url, fail: failToast }) });
  },

  previewPhoto(e) {
    const urls = (this.data.record && this.data.record.photos) || [];
    const current = e.currentTarget.dataset.url;
    if (!urls.length) return;
    wx.previewImage({ urls, current });
  },
});

// 留痕时间展示：MM-DD HH:mm（服务端 history[].at 是 BSON Date 的 ISO 字符串）
function formatAt(at) {
  if (!at) return '';
  const d = new Date(at);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 字段名 → 中文标签（留痕里的 key 是模块字段 key，直接显示英文 key 没人看得懂）
const FIELD_LABELS = {
  status: '状态',
  rejectReason: '退回原因',
  cancelReason: '取消原因',
  remark: '备注',
  photos: '照片',
  period: '时段',
  grade: '评价',
  score: '得分',
  // 申诉改判会把扣分归零：留痕里要能直接读出「扣分：40 → 0」
  deduct: '扣分',
  absentCount: '缺勤人数',
  lateCount: '迟到人数',
  notReturnedCount: '未归人数',
  absentList: '缺勤名单',
  reason: '缺勤原因',
  lateList: '迟到名单',
  notReturnedList: '未归名单',
  'appeal.status': '申诉状态',
  'appeal.result': '申诉处理意见',
};

// 状态值 → 中文（changes 里的 from/to 是英文枚举）
const STATUS_LABELS = {
  submitted: '已提交',
  approved: '已复核',
  rejected: '已退回',
  cancelled: '已取消',
  pending: '待处理',
  '': '无',
};

// 单个字段的新旧值 → 一行可读文案（如「状态：已提交 → 已复核」）
function valueText(v) {
  if (v === undefined || v === null || v === '') return '空';
  if (typeof v === 'string' && STATUS_LABELS[v]) return STATUS_LABELS[v];
  if (Array.isArray(v)) return `${v.length} 项`;
  if (typeof v === 'object') return '已修改';
  return String(v);
}

// changes: { 字段: { from, to } } 或 { 字段: { to } }（复核 / 取消只记 to）
function changeLines(changes) {
  if (!changes || typeof changes !== 'object') return [];
  const out = [];
  for (const [key, val] of Object.entries(changes)) {
    const label = FIELD_LABELS[key] || key;
    const hasFrom = val && Object.prototype.hasOwnProperty.call(val, 'from');
    if (hasFrom) {
      out.push(`${label}：${valueText(val.from)} → ${valueText(val.to)}`);
    } else if (val && Object.prototype.hasOwnProperty.call(val, 'to')) {
      out.push(`${label}：${valueText(val.to)}`);
    } else {
      out.push(label);
    }
  }
  // 上限 6 行：留痕只用于追溯，列太多会把卡片撑得很长
  return out.slice(0, 6);
}
