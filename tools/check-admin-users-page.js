// 桩测试：用户管理页的紧凑排版、班级状态/身份标签、批量选择逻辑
//
// 用户 2026-10-20 要求：
//   ① 「重新设计UI紧凑排版」
//   ② 「班级被设置为实习/毕业也要一并显示在其中，筛选中也要增加该内容，包括学生会、班委等」
//   ③ 「增加批量操作功能」
// 用打桩 auth 驱动真实的 users.js：断言行数据被压成两行、标签由服务端字段生成、
// 批量选择的计数与全选口径正确（全选只作用于本页，不谎称选中整个筛选结果）。
const path = require('path');

const MINI = path.join(__dirname, '..', 'miniprogram');
let page = null;
let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? '  ok   ' : '  FAIL '}${name}${cond ? '' : ` -> ${detail}`}`);
  if (!cond) failed += 1;
};

global.Page = (cfg) => {
  page = cfg;
};
const toasts = [];
const modals = [];
global.getApp = () => ({ requireLogin: () => true, ensureLogin: async () => {}, globalData: { userInfo: { isManager: true } } });
global.wx = {
  showToast(o) { toasts.push(o); },
  showModal(o) { modals.push(o); if (o.success) o.success({ confirm: false }); },
  showActionSheet(o) { if (o.success) o.success({ tapIndex: 0 }); },
  showLoading() {},
  hideLoading() {},
  navigateTo() {},
  setNavigationBarTitle() {},
  stopPullDownRefresh() {},
  getStorageSync: () => '',
  setStorageSync() {},
  removeStorageSync() {},
};

const LIST_ROWS = [
  { _id: 'u1', account: '周春旭', role: 'student', className: '24软件技术', studentId: '20240101', classStatus: 'intern', classStatusText: '实习', isClassOfficer: true, isUnionMember: false, unionText: '', unionRoles: [], unionMore: 0, dorm: { roomText: '1号楼·201', bedNo: '3' }, goal: { planName: '强化计划' } },
  { _id: 'u2', account: '李紫嫣', role: 'student', className: '26级金融科技应用', studentId: '20260101', classStatus: 'graduated', classStatusText: '毕业', isClassOfficer: false, isUnionMember: true, unionText: '主席团 · 主席', unionRoles: [{ deptName: '主席团', roleText: '主席' }], unionMore: 1, dorm: null, goal: null },
  { _id: 'u3', account: '未绑微信成员', role: 'student', className: '23级机电1班', studentId: '20230101', classStatus: 'normal', classStatusText: '', isClassOfficer: false, isUnionMember: true, unionText: '生活部 · 部员', unionRoles: [{ deptName: '生活部', roleText: '部员' }], unionMore: 0, dorm: null, goal: null },
  { _id: 'u4', account: '王老师', role: 'teacher', className: '', homeroomClasses: ['24软件技术', '24电子商务'], departmentName: '计财系', schoolName: '北校区', isClassOfficer: false, isUnionMember: false },
  // 极端行：长姓名 + 三个标签，用来验证「折叠而不是折行」
  { _id: 'u5', account: '欧阳德昌古力娜扎尔', role: 'student', className: '24软件技术', studentId: '2024099', classStatus: 'intern', classStatusText: '实习', isClassOfficer: true, isUnionMember: true, unionText: '主席团 · 主席', unionRoles: [{ deptName: '主席团', roleText: '主席' }], unionMore: 2, dorm: null, goal: null },
];
const batchCalls = [];

// 列表接口随结果返回的**实时**人数（用户 2026-10-21「括号中的人数要根据筛选实时计算」）。
// 计数口径 = 「除自身维度外所有已选条件」命中的人按该维度分组，与列表 total 同源。
const FACETS = {
  school: { 北校区: 2677 },
  department: { 计财系: 1424, 机电建工系: 719, 冶金材料系: 534, 机电系: 2 },
  specialty: { 软件技术: 300 },
  grade: { 2025: 1138, 2024: 394, 2026: 1142 },
  classStatus: { normal: 2286, intern: 395, graduated: 0 },
  identity: { officer: 2, homeroom: 2, union: 2 },
};

const auth = require(path.join(MINI, 'utils', 'request'));
const listCalls = [];
auth.get = async (url, params) => {
  if (url === '/api/admin/users') {
    listCalls.push(params || {});
    // 与真实服务端一致：只有 withFacets=1 才回 facets（翻页不带就不回）
    const withFacets = String((params || {}).withFacets) === '1';
    return {
      list: LIST_ROWS, total: 2687, page: 1, limit: 20,
      facets: withFacets ? FACETS : undefined,
    };
  }
  if (url === '/api/admin/users/filters') {
    return {
      schools: ['北校区'], departments: ['计财系'], specialties: ['软件技术'], grades: ['2024'], tree: [],
      // ⚠️ 这里的人数刻意与 FACETS **不同**（999 / 777）：两个来源给不同数字，
      // 才能证明界面用的是「随列表返回的实时计数」而不是这份整库全量（用户报的正是后者）。
      classStatuses: [{ value: 'normal', label: '正常', count: 999 }, { value: 'intern', label: '实习', count: 999 }, { value: 'graduated', label: '毕业', count: 999 }],
      identities: [{ value: 'officer', label: '班委', count: 777 }, { value: 'homeroom', label: '班主任', count: 777 }, { value: 'union', label: '学生会成员', count: 777 }],
    };
  }
  throw new Error('未预期请求: ' + url);
};
auth.post = async (url, body) => {
  batchCalls.push({ url, body });
  return { action: body.action, label: '批量', done: body.ids.map((i) => ({ _id: i, name: i, result: 'ok' })), failed: [], missing: [], total: body.ids.length };
};
auth.del = async () => ({});

require(path.join(MINI, 'packageAdmin', 'users', 'users.js'));

function makeInstance() {
  const inst = Object.assign({}, page);
  inst.data = JSON.parse(JSON.stringify(page.data));
  inst.setData = function setData(patch, cb) {
    for (const [k, v] of Object.entries(patch)) {
      if (k.includes('.')) {
        const [a, b] = k.split('.');
        this.data[a] = { ...(this.data[a] || {}), [b]: v };
      } else this.data[k] = v;
    }
    if (cb) cb();
  };
  return inst;
}

(async () => {
  const inst = makeInstance();
  await inst.load();
  await inst.loadFilters();

  console.log('[1] 紧凑排版：元信息压成一行（不再学号/班级/宿舍/目标各占一行）');
  const r1 = inst.data.list[0];
  ok('行上有 metaText', typeof r1.metaText === 'string' && r1.metaText.length > 0, JSON.stringify(r1.metaText));
  ok('metaText 用「 · 」连接', r1.metaText.split(' · ').length === 4, r1.metaText);
  // 刻意不带「学号/宿舍」前缀：一行装不下「前缀+四项」，加前缀只能 ellipsis 截断，
  // 而截断等于把宿舍/计划名从管理员眼前弄丢（实测过），靠格式即可辨识。
  ok('metaText 含学号/班级/宿舍/计划（无前缀）', r1.metaText === '20240101 · 24软件技术 · 1号楼·201 3 床 · 强化计划', r1.metaText);
  ok('不带「学号」「宿舍」字样', !/学号|宿舍/.test(r1.metaText), r1.metaText);
  ok('教师行 metaText 是院系·院校', inst.data.list[3].metaText === '计财系 · 北校区', inst.data.list[3].metaText);
  ok('未绑宿舍的学生不出现空槽位', inst.data.list[2].metaText === '20230101 · 23级机电1班', inst.data.list[2].metaText);
  ok('「默认目标」不显示（对管理员无信息量）', !/默认目标/.test(inst.data.list[2].metaText), inst.data.list[2].metaText);
  const wxml = require('fs').readFileSync(path.join(MINI, 'packageAdmin/users/users.wxml'), 'utf8');
  ok('模板不再渲染三行 .user-row-sub', !/user-row-sub/.test(wxml), 'still has user-row-sub');
  const wxss = require('fs').readFileSync(path.join(MINI, 'packageAdmin/users/users.wxss'), 'utf8');
  const pageSrc = require('fs').readFileSync(path.join(MINI, 'packageAdmin/users/users.js'), 'utf8');
  ok('样式已删掉旧的三行规则', !/\.user-row-sub \{/.test(wxss), 'stale css');
  // 元信息必须**换行**而不是 ellipsis 截断：截断会直接丢信息（实测带前缀时两行被截掉）
  const metaCss = (wxss.match(/\.user-row-meta \{[\s\S]*?\}/) || [''])[0];
  ok('元信息允许换行（不用 ellipsis 丢信息）', !/text-overflow/.test(metaCss) && /word-break/.test(metaCss), metaCss.replace(/\s+/g, ' '));

  console.log('[2] 班级状态 / 学生会 / 班委 标签（单行不折行）');
  ok('实习班学生带「实习」标签', r1.chips.some((c) => c.text === '实习' && c.cls === 'warn'), JSON.stringify(r1.chips));
  ok('毕业班学生带「毕业」标签', inst.data.list[1].chips.some((c) => c.text === '毕业' && c.cls === 'neutral'), JSON.stringify(inst.data.list[1].chips));
  ok('正常班不打状态标签（一屏全是灰点等于没打）', !inst.data.list[2].chips.some((c) => ['正常', '实习', '毕业'].includes(c.text)), JSON.stringify(inst.data.list[2].chips));
  ok('班委有标签', r1.chips.some((c) => c.text === '班委'), JSON.stringify(r1.chips));
  // 「班主任4班」会被读成「4 班」这个班名（用户就是因此发问）→ 必须写成「班主任·N个班」
  const hr = inst.data.list[3].chips.find((c) => /班主任/.test(c.text));
  ok('班主任带班级数且不会误读成班名', hr && hr.text === '班主任·2个班', hr && hr.text);
  ok('单个班时只写「班主任」', !/1个班/.test(JSON.stringify(inst.data.list[0].chips)));
  // 用户截图的成因：「学生会·主席团 · 主席」太长被 flex-wrap 甩到第二行。
  // 主席团的部门名没有信息量（职务已说明身份）→ 压成「学生会·主席」。
  const u2union = inst.data.list[1].chips.find((c) => c.cls === 'union');
  ok('主席团标签压缩掉部门名', u2union && u2union.text === '学生会·主席', u2union && u2union.text);
  const u3union = inst.data.list[2].chips.find((c) => c.cls === 'union');
  ok('普通部门保留部门名', u3union && u3union.text === '学生会·生活部·部员', u3union && u3union.text);
  ok('多条学生会记录带 +N 计数', u2union && u2union.more === 1, JSON.stringify(inst.data.list[1].chips));
  ok('模板渲染 chips', /users-chip-\{\{chip\.cls\}\}/.test(wxml));

  // ===== 用户截图的「瑕疵」：一行里混了两套标签体系 =====
  // t-tag（管理员/教师/限制）与 .users-chip（状态/班委/学生会）字号、内距、圆角、高度都不同，
  // 并排就是那种高低错落；而且 t-tag 不参与 layoutChips 的宽度预算，折叠算不准。
  console.log('[2a] 标签必须只用一套体系（不再混用 t-tag）');
  const nameRow = (wxml.match(/<view class="users-name">[\s\S]*?<\/view>/) || [''])[0];
  ok('姓名行内不再有 t-tag', !/<t-tag/.test(nameRow), nameRow.replace(/\s+/g, ' ').slice(0, 120));
  ok('管理员/教师也走 chips（JS 生成）', /text: '管理员', cls: 'role'/.test(pageSrc) && /text: '教师', cls: 'neutral'/.test(pageSrc));
  ok('限制标签也走 chips', /SCOPE_LABELS\[s\], cls: 'danger'/.test(pageSrc));
  ok('scopeLabels 死代码已清理', !/item\.scopeLabels =/.test(pageSrc));
  // 配色不能撞：本仓库把 TDesign primary 整套换成了品牌橙，
  // 用 --td-primary-color-7 当「班委」色会与「实习」、与品牌橙三者同色（用户截图里班主任是橙色）。
  const cssBlock = (re) => (wxss.match(re) || [''])[0];
  const infoCss = cssBlock(/\.users-chip-info \{[\s\S]*?\}/);
  const warnCss = cssBlock(/\.users-chip-warn \{[\s\S]*?\}/);
  ok('班委/班主任不再用 primary（会与品牌橙撞色）', !/--td-primary-color/.test(infoCss), infoCss.replace(/\s+/g, ' '));
  ok('班委/班主任与实习用不同色板', /--td-success-color/.test(infoCss) && /--td-warning-color/.test(warnCss));
  // 等高靠「同字号 + 同 line-height + 同 padding」自然得到，
  // ⚠️ 绝不能用固定 height：.users-chip 挂在 <text> 上，真机把 flex 子项 blockify 后
  // 固定 height 会把文字整块裁掉（只剩纯色块）—— 而 Chromium 预览里正常，
  // 所以这个 bug 只在真机出现、预览抓不到（用户截图「为什么空白啊」就是它）。
  const baseCss = cssBlock(/\.users-chip \{[\s\S]*?\}/);
  // 匹配「独立成行的 height 声明」：(?<!line-) 排除 line-height（\b 在 "-h" 之间也算边界，会误判）
  ok('标签基线不设固定 height（真机会裁掉文字）', !/(^|[^-])\bheight:/.test(baseCss), baseCss.replace(/\s+/g, ' '));
  ok('等高靠 line-height + padding', /line-height:/.test(baseCss) && /padding:/.test(baseCss));
  ok('折叠标记不靠 border 撑高（会破坏等高）', !/border:/.test(cssBlock(/\.users-chip-fold \{[\s\S]*?\}/)));

  console.log('[2b] 单行排版：绝不折行（真机 flex 会折行，改用 nowrap + inline-block）');
  // ⚠️ 刻意不用 flex：display:flex + flex-wrap:nowrap 在真机上标签仍会折到第二行
  //（<text> 是 inline 元素，作 flex 子项被 blockify，各基础库对 nowrap 遵守不一致）——
  // 用户两次截图「挤到第二行」就是它。改用纯文本布局：容器 white-space:nowrap + 子项 inline-block。
  const nameCss = cssBlock(/\.users-name \{[\s\S]*?\}/);
  ok('姓名行容器用 white-space:nowrap 禁止折行', /white-space:\s*nowrap/.test(nameCss), nameCss.replace(/\s+/g, ' '));
  ok('姓名行容器不再是 flex（真机 flex 会折行）', !/display:\s*flex/.test(nameCss), nameCss.replace(/\s+/g, ' '));
  ok('标签是 inline-block（padding/背景/对齐才可靠）', /display:\s*inline-block/.test(baseCss), baseCss.replace(/\s+/g, ' '));
  ok('标签用 vertical-align 与姓名对齐', /vertical-align:/.test(baseCss));
  // ⚠️ 标签必须是 <view> 而不是 <text>：<text> 即便 inline-block，部分基础库内部仍会断行
  //（真机标签掉第二行，Chromium 预览不重现）。<view> 默认块级，inline-block 后保证原子、绝不内部折行。
  ok('标签元素用 <view>（<text> 真机会内部折行）', /<view class="users-chip/.test(wxml) && !/<text class="users-chip/.test(wxml), 'chip element should be <view>');
  // 标签元素内不留换行/缩进：空白会渲染成前导空格，让色块文字偏右
  const chipTag = (wxml.match(/<view class="users-chip[^"]*"([^>]*)>([\s\S]*?)<\/view>/) || [])[2] || '';
  ok('标签元素内不留换行缩进（否则文字前有空白）', !/^\s/.test(chipTag) && !/\s+$/.test(chipTag), JSON.stringify(chipTag.slice(0, 30)));
  ok('折叠标记类名不与 union 的 +N 撞名', /\.users-chip-fold \{/.test(wxss) && !/cls: 'more'/.test(require('fs').readFileSync(path.join(MINI, 'packageAdmin/users/users.js'), 'utf8')));
  // 极端：姓名很长 + 4 个标签 → 必须折叠而不是把一行撑成两行。
  // 走**真实代码路径**（夹具行进 load()），不导出内部函数，避免为了测试改生产代码结构。
  const r5 = inst.data.list[4];
  // 注意：chips 里含「+N」折叠标记本身，所以要拿**非折叠**标签数与总数比。
  const realShown = r5.chips.filter((c) => c.cls !== 'fold');
  ok('长姓名+多标签的行已折叠', realShown.length < r5.chipTotal, JSON.stringify({ shown: realShown.map((c) => c.text), total: r5.chipTotal }));
  ok('折叠标记里的数字等于被藏起来的标签数', Number((r5.chips.find((c) => c.cls === 'fold') || {}).text.slice(1)) === r5.chipTotal - realShown.length, JSON.stringify(r5.chips));
  // 一行里绝不能出现两个「+N」：union 自带的 +N 是「还有 N 个部门」，
  // 折叠的 +N 是「还有 N 个标签」，两个并排没人分得清 → 折叠时合并成一个数字。
  const plusChips = inst.data.list.flatMap((row) => row.chips.filter((c) => /\+\d/.test(c.text) || c.more));
  ok('折叠发生时 union 自带的 +N 被合并（不出现两个 +N）', inst.data.list.every((row) => row.chips.filter((c) => /\+\d/.test(c.text) || c.more).length <= 1), JSON.stringify(inst.data.list.map((x) => x.chips)));
  // 没折叠的行仍应保留 union 自己的 +N（表示多部门，不是被折叠）
  const u2 = inst.data.list[1].chips.find((c) => c.cls === 'union');
  ok('未折叠时 union 保留自己的 +N（多部门）', u2 && u2.more === 1 && inst.data.list[1].chips.filter((c) => c.cls === 'fold').length === 0, JSON.stringify(inst.data.list[1].chips));
  ok('折叠后带 +N 标记', r5.chips.some((c) => c.cls === 'fold' && /^\+\d$/.test(c.text)), JSON.stringify(r5.chips));
  ok('优先保留靠前的标签（班级状态）', r5.chips[0].text === '实习', JSON.stringify(r5.chips));
  ok('姓名过长时省略号兜底而非撑破', r5.nameText.length > 6, r5.nameText);

  console.log('[3] 筛选：班级状态与身份选项带**实时**计数（随列表返回，不是 /filters 的整库全量）');
  const cs = inst.data.filterOptions.classStatus;
  ok('班级状态含「全部」', cs[0].value === '' && cs[0].label === '全部', JSON.stringify(cs[0]));
  ok('班级状态带人数（与列表 total 同口径）', cs.some((o) => o.label === '实习（395）'), JSON.stringify(cs));
  ok('身份带人数', inst.data.filterOptions.identity.some((o) => o.label === '学生会成员（2）'), JSON.stringify(inst.data.filterOptions.identity));
  // 两个来源数字刻意不同（/filters 写 999/777，列表 facets 写 395/2）→ 证明用的是实时那份
  ok('计数来自列表 facets 而非 /filters 的整库全量', !cs.some((o) => /（999）/.test(o.label)), JSON.stringify(cs));
  ok('系部计数也是实时的（FACETS 的 1424，不是 tree 的全量）', inst.data.filterOptions.departments.some((o) => o.label === '计财系（1424）'), JSON.stringify(inst.data.filterOptions.departments));
  // 只在第一页要计数：翻页（page>1）不该带 withFacets，否则每次触底都重算六个维度
  listCalls.length = 0;
  inst.setData({ page: 2 });
  await inst.load();
  ok('翻页不带 withFacets（不重复算计数）', listCalls.length > 0 && listCalls.every((q) => !q.withFacets), JSON.stringify(listCalls));
  ok('翻页后仍保留上一次的人数（不被 undefined 清掉）', inst.data.facetCounts && inst.data.facetCounts.classStatus.intern === 395, JSON.stringify(inst.data.facetCounts));
  listCalls.length = 0;
  inst.setData({ page: 1 });
  await inst.reload();
  ok('筛选变化（第一页）会要计数', listCalls.some((q) => q.withFacets === '1'), JSON.stringify(listCalls));
  // 选了日/周目标 → 服务端返回 null → 不显示括号（宁可没有也不给对不上的数）
  inst.onDropdownChange({ currentTarget: { dataset: { key: 'dailyAchieved' } }, detail: { value: '1' } });
  await new Promise((r) => setTimeout(r, 10));
  const inst2 = makeInstance();
  inst2.setData({ facetCounts: null });
  inst2.setData({ filterBase: inst.data.filterBase });
  inst2.renderFilterOptions();
  ok('facets=null 时不渲染括号（不显示陈旧数字）', inst2.data.filterOptions.classStatus.every((o) => !/（\d+）/.test(o.label)), JSON.stringify(inst2.data.filterOptions.classStatus));
  // 选项现在**六个维度都带人数**，而触发器每列只有约 190rpx → 标题必须剥掉尾巴。
  // （computeFilterLabels 取的就是选项 label，不剥会显示成「冶金材料系（534）」撑破。）
  inst.setData({ 'filters.department': '计财系' });
  inst.renderFilterOptions();
  ok('选项带人数', inst.data.filterOptions.departments.some((o) => /计财系（1424）/.test(o.label)), JSON.stringify(inst.data.filterOptions.departments));
  ok('触发器标题剥掉人数尾巴', inst.data.filterLabels.department === '计财系', inst.data.filterLabels.department);

  inst.onDropdownChange({ currentTarget: { dataset: { key: 'classStatus' } }, detail: { value: 'intern' } });
  await new Promise((r) => setTimeout(r, 10));
  ok('选班级状态会进查询参数', inst.buildQuery().classStatus === 'intern', JSON.stringify(inst.buildQuery()));
  inst.onDropdownChange({ currentTarget: { dataset: { key: 'identity' } }, detail: { value: 'union' } });
  await new Promise((r) => setTimeout(r, 10));
  ok('身份也进查询参数', inst.buildQuery().identity === 'union', JSON.stringify(inst.buildQuery()));
  ok('筛选摘要写明两项', /班级状态 实习/.test(inst.data.filterSummary) && /身份 学生会成员/.test(inst.data.filterSummary), inst.data.filterSummary);
  inst.clearFilters();
  await new Promise((r) => setTimeout(r, 10));
  ok('清除筛选会一并复位两项', inst.data.filters.classStatus === '' && inst.data.filters.identity === '');

  console.log('[4] 批量模式：选择计数与全选口径');
  inst.toggleBatchMode();
  ok('进入批量模式', inst.data.batchMode === true);
  ok('初始未选', inst.data.selectedCount === 0 && inst.data.allChecked === false);
  inst.onCheckOne({ currentTarget: { dataset: { id: 'u1', name: '周春旭' } } });
  ok('勾选 1 人计数为 1', inst.data.selectedCount === 1);
  inst.onCheckOne({ currentTarget: { dataset: { id: 'u1', name: '周春旭' } } });
  ok('再点取消，计数回 0', inst.data.selectedCount === 0, JSON.stringify(inst.data.selected));
  inst.toggleCheckAll();
  // 期望值跟着夹具长度走，不写死数字 —— 否则每加一行夹具就会误报
  const N = inst.data.list.length;
  ok(`全选=本页 ${N} 人`, inst.data.selectedCount === N, JSON.stringify(inst.data.selected));
  ok('全选态 allChecked=true', inst.data.allChecked === true);
  ok(`全选只选本页（${N} 人，不是 total 2687）`, Object.keys(inst.data.selected).length === N && inst.data.total === 2687, `${Object.keys(inst.data.selected).length}/${inst.data.total}`);
  inst.toggleCheckAll();
  ok('再点全选=清空', inst.data.selectedCount === 0);
  inst.toggleBatchMode();
  ok('退出批量模式会清空选择（防「以为没选实际还选着」）', inst.data.batchMode === false && inst.data.selectedCount === 0);

  console.log('[5] 批量动作分发');
  inst.toggleBatchMode();
  inst.toggleCheckAll();
  batchCalls.length = 0;
  inst.onBatchAction({ currentTarget: { dataset: { action: 'reset-password' } } });
  await new Promise((r) => setTimeout(r, 20));
  ok('重置密码打到 /batch', batchCalls.some((c) => c.url === '/api/admin/users/batch' && c.body.action === 'reset-password'), JSON.stringify(batchCalls.map((c) => c.body.action)));
  ok('带上全部已选 id', (batchCalls[0].body.ids || []).length === N);
  // 动作成功后服务端结果已回、前端**必须清空选择**（否则下一批会误带上一次的人）。
  // 所以每个动作前都要重新选 —— 这里同时验证「完成后清空」这条行为。
  ok('完成后清空选择（防下一批误带上一次的人）', inst.data.selectedCount === 0, String(inst.data.selectedCount));
  batchCalls.length = 0;
  inst.onBatchAction({ currentTarget: { dataset: { action: 'officer' } } });
  await new Promise((r) => setTimeout(r, 20));
  ok('未选择时点动作不发请求（只提示）', batchCalls.length === 0 && toasts.some((t) => /请先选择/.test(t.title || '')), JSON.stringify({ calls: batchCalls.length, toasts: toasts.slice(-1) }));
  inst.toggleCheckAll();
  batchCalls.length = 0;
  inst.onBatchAction({ currentTarget: { dataset: { action: 'unofficer' } } });
  await new Promise((r) => setTimeout(r, 20));
  ok('取消班委 → action=officer + isClassOfficer:false', batchCalls[0] && batchCalls[0].body.action === 'officer' && batchCalls[0].body.isClassOfficer === false, JSON.stringify(batchCalls[0] && batchCalls[0].body));
  inst.toggleCheckAll();
  batchCalls.length = 0;
  modals.length = 0;
  inst.onBatchAction({ currentTarget: { dataset: { action: 'delete' } } });
  await new Promise((r) => setTimeout(r, 20));
  ok('删除先弹确认、不直接发请求', batchCalls.length === 0, JSON.stringify(batchCalls.map((c) => c.body.action)));
  ok('确认弹窗写明不可恢复与超管会被跳过', modals.some((m) => /批量删除/.test(m.title || '') && /不可恢复/.test(m.content || '') && /超级管理员/.test(m.content || '')), JSON.stringify(modals.map((m) => m.title)));

  console.log('[6] 批量模式下左滑必须禁用（防边选边误删）');
  ok('t-swipe-cell 绑了 disabled', /disabled="\{\{batchMode\}\}"/.test(wxml), 'no disabled binding');
  ok('行点击在批量模式=勾选（不跳详情）', /onRowTap\(e\) \{\s*const id = e\.currentTarget\.dataset\.id;[\s\S]{0,160}if \(this\.data\.batchMode\) \{\s*this\.onCheckOne\(e\)/.test(require('fs').readFileSync(path.join(MINI, 'packageAdmin/users/users.js'), 'utf8')));
  // 剥掉 WXML 注释再判：注释里会**引用**这个错误写法作为反面教材，
  // 直接 includes 会把说明文字当成违规（本仓库 tools/check-nav-groups.js 的 classRoutesNoComment 同样踩过）
  const wxmlNoComment = wxml.replace(/<!--[\s\S]*?-->/g, '');
  ok('事件名不是动态绑定（WXML 不支持，会静默失效）', !/bind:tap="\{\{/.test(wxmlNoComment), 'dynamic bind:tap found');

  console.log('[7] 图标名必须真实存在（写错不报错，只渲染成空白）');
  const iconCss = require('fs').readFileSync(path.join(MINI, 'miniprogram_npm/tdesign-miniprogram/icon/icon.wxss'), 'utf8');
  const used = (wxml.match(/t-icon\s+name="([a-z0-9-]+)"/g) || []).map((s) => s.replace(/.*name="([a-z0-9-]+)".*/, '$1'));
  const missing = [...new Set(used)].filter((n) => !iconCss.includes(`.t-icon-${n}:before`));
  ok(`本页 ${new Set(used).size} 个图标全部存在`, missing.length === 0, '缺: ' + missing.join(','));

  // ===== 账户编辑页：教师不该出现学号 / 年级（用户 2026-10-20）=====
  // 根因：学号/年级原本在共享的「基本信息」区，只有下面的「学籍信息」才按 role 包起来，
  // 所以切到教师账户时这四项全露出来。性别/出生日期是通用人属性，保留；学号/年级学生专属。
  console.log('[8] 账户编辑页：教师隐藏学号 + 年级，且不提交学号');
  const aeWxml = require('fs').readFileSync(path.join(MINI, 'packageAdmin/users/account-edit/account-edit.wxml'), 'utf8');
  const aeJs = require('fs').readFileSync(path.join(MINI, 'packageAdmin/users/account-edit/account-edit.js'), 'utf8');
  // 学号行必须在 role==='student' 的 block 内（用行内容定位，别用会被注释命中的裸关键词）
  // 班主任视角（classScope）学籍字段只读 → 条件写作 `role === 'student' && !classScope`，同样满足本条
  const stuBlock = (
    aeWxml.match(/<block wx:if="\{\{role === 'student'(?: && !classScope)?\}\}">[\s\S]*?<\/block>/g) || []
  ).join('');
  ok('学号行包在 role===student 内', /学号/.test(stuBlock) && /inputStudentId/.test(stuBlock), '学号未被 role 守卫');
  ok('年级行包在 role===student 内', /年级/.test(stuBlock) && /gradeText/.test(stuBlock), '年级未被 role 守卫');
  // 性别 / 出生日期是通用属性，教师也要能填 → 不能被 role 守卫误伤
  const outsideBlock = aeWxml.replace(/<block wx:if="\{\{role === 'student'\}\}">[\s\S]*?<\/block>/g, '');
  ok('性别仍对教师可见（通用属性）', /性别/.test(outsideBlock) && /pickGender/.test(outsideBlock));
  ok('出生日期仍对教师可见（通用属性）', /出生日期/.test(outsideBlock) && /pickBirthdate/.test(outsideBlock));
  // 提交守卫：教师不提交 studentId（唯一稀疏索引，落到教师身上会污染数据）
  ok('提交时 studentId 按 role 收敛', /studentId:\s*d\.role === 'student'\s*\?\s*d\.studentId\.trim\(\)\s*:\s*''/.test(aeJs), '教师仍会提交学号');

  // ===== 院校 → 系部 → 专业 级联（用户 2026-10-20「希望都是联动的，选了教师院才有教师系」）=====
  // 旧缺陷：系部/专业选项 = 该院校子节点 ∪ 全库存量平铺数组，后半截是全库的 → 选了院校仍看到别校系部。
  console.log('[8b] 账户编辑页：院校→系部→专业 严格级联收窄');
  const buildFn = (aeJs.match(/buildOptions\(\) \{[\s\S]*?\n  \},/) || [''])[0];
  ok('buildOptions 用 cascadeTree 作级联源', /this\.cascadeTree\(\)/.test(buildFn), '没用统一级联源');
  // 收窄变量本身必须只来自树（全量只能出现在 `: allXxx` 兜底分支上）
  const deptNarrow = (buildFn.match(/const deptNarrow = ([\s\S]*?);/) || [])[1] || '';
  const specNarrow = (buildFn.match(/const specNarrow = ([\s\S]*?);/) || [])[1] || '';
  ok('系部按已选院校收窄（命中才给该院校子节点）', /d\.school && schoolNode \? childNames\(schoolNode\)/.test(deptNarrow), deptNarrow);
  ok('专业按已选系部收窄', /d\.department && deptNode\s*\?\s*childNames\(deptNode\)/.test(specNarrow), specNarrow);
  // 关键回归：收窄分支里绝不能再把全库存量并进去（那就是泄漏本身）
  ok('系部收窄不并入全库存量（防泄漏）', !/usedDepartments/.test(deptNarrow), deptNarrow);
  ok('专业收窄不并入全库存量（防泄漏）', !/usedSpecialties/.test(specNarrow), specNarrow);
  // ⚠️ 兜底语义（真实数据验证后定稿）：null = 完全不知道上级（没选/未命中树）→ 才退全量；
  //   命中树但子节点为空（如真实库的「洋河校区」配了院校没配系部）必须**保持为空**，
  //   否则管理员会选出「洋河校区 + 计财系」这种跨院校脏数据。
  ok('无层级信息(null)才退全量，空数组不退', /deptNarrow \|\| allDepts/.test(buildFn) && /specNarrow \|\| allSpecs/.test(buildFn), buildFn.slice(0, 60));
  ok('收窄未命中用 null 而非 []（区分两种空）', /deptNarrow = d\.school && schoolNode \? childNames\(schoolNode\) : null/.test(buildFn), deptNarrow);
  ok('全量来源是树各层 ∪ 存量', /const allDepts = uniq/.test(buildFn) && /const allSpecs = uniq/.test(buildFn));
  ok('切换院校清空下级（防残留错配）', /onSchoolPick\([\s\S]*?department: ''[\s\S]*?specialty: ''/.test(aeJs));
  ok('级联源含 /filters 的 tree（组织架构 ∪ 存量）', /filterTree: opt\.tree/.test(aeJs));

  // ===== 不提供「手动输入」（用户 2026-10-21「这个手动输入是什么鬼 组织架构只能有有权限的更改」）=====
  // 组织架构增删改挂 content.manage（routes/admin/content.js）；账户编辑页只要有编辑权限
  // 就能凭空造一个系部名 = 绕过权限的后门。选项只能来自组织架构（含服务端合并的 observed 节点）。
  console.log('[8c] 账户编辑页：无「手动输入」后门，选项只来自组织架构');
  ok('JS 里已无 MANUAL 常量', !/const MANUAL/.test(aeJs), '仍有手填哨兵值');
  ok('JS 里已无 manual 状态', !/manual:\s*\{/.test(aeJs) && !/'manual\./.test(aeJs));
  ok('WXML 无手填输入框', !/placeholder="手填/.test(aeWxml), '仍有手填 input');
  ok('WXML 无「手动输入」选项', !/手动输入/.test(aeWxml.replace(/<!--[\s\S]*?-->/g, '')), 'picker 仍含手填项');
  ok('无可选项时提示去组织架构', /orgHints/.test(aeWxml) && /goOrganizations/.test(aeWxml));
  ok('提示指向组织架构页路由', /packageAdmin\/content\/organizations/.test(aeJs));
  // 存量脏数据（如从没配进组织架构的「机电系」）必须仍可见可保留 —— 不能因为移除手填就丢值
  ok('ensureValue 保留账号当前值（不丢存量数据）', /const ensureValue = /.test(aeJs) && /ensureValue\(deptOpts, d\.department\)/.test(aeJs));
  ok('三级都套了 ensureValue', (buildFn.match(/ensureValue\(/g) || []).length === 3, String((buildFn.match(/ensureValue\(/g) || []).length));

  // ===== 筛选选中后必须回填到触发器标题（用户 2026-10-21「筛选选择后应该显示一下」）=====
  // 根因：TDesign 菜单条渲染 `label || computedLabel`（dropdown-menu.js::getAllItems），
  // 我们一直传静态 label="年级" → 组件算出的选中值被永久盖住，选完看不出选了啥。
  console.log('[12] 筛选触发器回填选中值');
  const i12 = makeInstance();
  await i12.load();
  await i12.loadFilters();
  ok('初始显示维度名', i12.data.filterLabels.grade === '年级' && i12.data.filterLabels.school === '院校', JSON.stringify(i12.data.filterLabels));
  i12.onDropdownChange({ currentTarget: { dataset: { key: 'grade' } }, detail: { value: '2024' } });
  ok('选年级后触发器显示「2024级」（取选项 label，不是原始值 2024）', i12.data.filterLabels.grade === '2024级', i12.data.filterLabels.grade);
  i12.onDropdownChange({ currentTarget: { dataset: { key: 'classStatus' } }, detail: { value: 'intern' } });
  ok('班级状态回填且去掉「（人数）」尾巴', i12.data.filterLabels.classStatus === '实习', i12.data.filterLabels.classStatus);
  i12.onDropdownChange({ currentTarget: { dataset: { key: 'identity' } }, detail: { value: 'officer' } });
  ok('身份回填', i12.data.filterLabels.identity === '班委', i12.data.filterLabels.identity);
  ok('未选的其它项仍是维度名', i12.data.filterLabels.school === '院校', i12.data.filterLabels.school);
  // 触发器必须是动态 label：静态写法会让 computedLabel 永久失效。
  // ⚠️ 数量**不写死**（原来是 === 8）：写死后每加一个筛选维度都要记得来这里改数字，
  //    忘了就是一条与功能无关的假失败（用户 2026-10-30 加「封禁类型」时正是这样撞上红的）。
  //    真正要守的语义是「FILTER_LABELS 里每个维度都在 WXML 有一个动态 label 触发器」，
  //    所以从维度数推导，并逐个键比对 —— 漏配某个键也能被抓到（计数相等但键不对的场合）。
  const usersSrcForLabels = require('fs').readFileSync(path.join(MINI, 'packageAdmin/users/users.js'), 'utf8');
  const labelBlockSrc = (usersSrcForLabels.match(/const FILTER_LABELS = \{([\s\S]*?)\};/) || ['', ''])[1];
  const filterKeys = [...labelBlockSrc.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  const dynLabels = [...wxml.matchAll(/label="\{\{filterLabels\.(\w+)\}\}"/g)].map((m) => m[1]);
  ok('筛选维度数与触发器数一致', filterKeys.length > 0 && dynLabels.length === filterKeys.length, { filterKeys: filterKeys.length, dynLabels: dynLabels.length });
  const missingTriggers = filterKeys.filter((k) => !dynLabels.includes(k));
  ok('每个筛选维度都有动态 label 触发器', missingTriggers.length === 0, missingTriggers);
  const extraTriggers = dynLabels.filter((k) => !filterKeys.includes(k));
  ok('WXML 不存在多余的 filterLabels 引用', extraTriggers.length === 0, extraTriggers);
  ok('WXML 不再有静态中文 label', !/label="(院校|系部|专业|年级|日目标|周目标|班级状态|身份|封禁类型)"/.test(wxml.replace(/<!--[\s\S]*?-->/g, '')));
  // 清除筛选后必须复位（同一份状态两处计算必然漂移 → 必须走 updateFilterState）
  i12.clearFilters();
  ok('清除后触发器回到维度名', i12.data.filterLabels.grade === '年级' && i12.data.filterLabels.classStatus === '班级状态', JSON.stringify(i12.data.filterLabels));
  ok('清除后摘要与角标同步归零', i12.data.hasActiveFilter === false && i12.data.filterCount === 0, JSON.stringify({ h: i12.data.hasActiveFilter, c: i12.data.filterCount }));
  // 「未达标」value 是 '0'：不能用 `|| ''` 判空，否则筛选生效了却显示回维度名
  i12.onDropdownChange({ currentTarget: { dataset: { key: 'dailyAchieved' } }, detail: { value: '0' } });
  ok('value 为 \'0\'（未达标）也能回填', i12.data.filterLabels.dailyAchieved === '未达标', i12.data.filterLabels.dailyAchieved);
  // 防漂移：新增维度若漏配 FILTER_OPTION_KEYS，不会报错、只会静默显示原始 value（如「2025」）
  const mapSrc = (require('fs').readFileSync(path.join(MINI, 'packageAdmin/users/users.js'), 'utf8').match(/const FILTER_OPTION_KEYS = \{[\s\S]*?\};/) || [''])[0];
  const labelKeys = (require('fs').readFileSync(path.join(MINI, 'packageAdmin/users/users.js'), 'utf8').match(/const FILTER_LABELS = \{([\s\S]*?)\};/) || ['', ''])[1];
  const declared = [...labelKeys.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  // 取映射的**右值**（`school: 'schools'` 里的 schools），左键是维度名、本来就该等于 FILTER_LABELS 的键
  const mappedKeys = [...mapSrc.matchAll(/^\s*(\w+):\s*'(\w+)'/gm)].map((m) => m[1]);
  const mappedTargets = [...mapSrc.matchAll(/^\s*(\w+):\s*'(\w+)'/gm)].map((m) => m[2]);
  ok('FILTER_OPTION_KEYS 覆盖全部筛选维度', declared.length > 0 && declared.every((k) => mappedKeys.includes(k)), `缺 ${declared.filter((k) => !mappedKeys.includes(k)).join(',')}`);
  ok('映射目标都是真实选项数组键', mappedTargets.every((k) => k in i12.data.filterOptions), mappedTargets.filter((k) => !(k in i12.data.filterOptions)).join(','));

  // ===== 批量转移改为级联选择（用户 2026-10-21「应该是多级而不是弹窗输入」+「增加一键转移院校」）=====
  console.log('[13] 批量转移：级联选择 + 一键转院校');
  const TREE13 = [
    { name: '北校区', children: [{ name: '计财系', children: [{ name: '软件技术' }, { name: '大数据技术' }] }, { name: '机电建工系', children: [{ name: '工程造价' }] }] },
    { name: '洋河校区', children: [{ name: '计财系', children: [{ name: '电子商务' }] }] },
  ];
  const i13 = makeInstance();
  await i13.load();
  await i13.loadFilters();
  i13.setData({ filterTree: TREE13, batchMode: true, selected: { u1: '高宇', u2: '高晨硕' }, selectedCount: 2 });
  i13.setData({ 'filterOptions.grades': [{ label: '2025级', value: '2025' }] });

  // 入口：批量栏点「转移」/「一键转院校」都走 openBatchTransfer，绝不直接发请求
  batchCalls.length = 0;
  i13.onBatchAction({ currentTarget: { dataset: { action: 'transfer', mode: 'school' } } });
  ok('点转移不发请求，只开抽屉', batchCalls.length === 0 && i13.data.transferSheet.visible === true, JSON.stringify({ calls: batchCalls.length, v: i13.data.transferSheet.visible }));
  ok('一键模式 = school', i13.data.transferSheet.mode === 'school');
  ok('院校选项 = 不修改 + 组织架构里的院校', i13.data.transferOptions.schools.map((o) => o.label).join(',') === '不修改,北校区,洋河校区', JSON.stringify(i13.data.transferOptions.schools));

  // 级联收窄：选北校区 → 系部只剩北校区的
  i13.onTransferPick({ currentTarget: { dataset: { level: 'school' } }, detail: { value: '1' } });
  ok('选北校区 → transfer.school 已写入', i13.data.transfer.school === '北校区', i13.data.transfer.school);
  ok('系部只剩北校区的 2 个', i13.data.transferOptions.departments.map((o) => o.label).join(',') === '不修改,计财系,机电建工系', JSON.stringify(i13.data.transferOptions.departments));
  ok('未选系部前专业只有「不修改」', i13.data.transferOptions.specialties.length === 1, JSON.stringify(i13.data.transferOptions.specialties));
  i13.onTransferPick({ currentTarget: { dataset: { level: 'department' } }, detail: { value: '1' } });
  ok('选计财系 → 专业只剩该系部的', i13.data.transferOptions.specialties.map((o) => o.label).join(',') === '不修改,软件技术,大数据技术', JSON.stringify(i13.data.transferOptions.specialties));
  // 换校区必须清空下级（否则会出现「洋河校区 + 软件技术」）
  i13.onTransferPick({ currentTarget: { dataset: { level: 'school' } }, detail: { value: '2' } });
  ok('换院校清空系部与专业（防跨校区错配）', i13.data.transfer.department === '' && i13.data.transfer.specialty === '', JSON.stringify(i13.data.transfer));
  ok('洋河校区的系部只剩它自己的', i13.data.transferOptions.departments.map((o) => o.label).join(',') === '不修改,计财系', JSON.stringify(i13.data.transferOptions.departments));

  // 提交：只提交非「不修改」的项
  batchCalls.length = 0;
  i13.onTransferPick({ currentTarget: { dataset: { level: 'department' } }, detail: { value: '1' } });
  await i13.submitTransfer();
  const t13 = batchCalls.find((c) => c.body.action === 'transfer');
  ok('提交带 school + department', !!t13 && t13.body.school === '洋河校区' && t13.body.department === '计财系', JSON.stringify(t13 && t13.body));
  ok('未选的字段不提交（specialty/grade 缺席）', !!t13 && !('specialty' in t13.body) && !('grade' in t13.body), JSON.stringify(t13 && t13.body));
  ok('提交后抽屉关闭', i13.data.transferSheet.visible === false);

  // 全「不修改」→ 不发请求（否则是一次什么都不改的假成功）
  batchCalls.length = 0;
  i13.setData({ selected: { u1: '高宇' }, transfer: { school: '', department: '', specialty: '', grade: '', gradeLabel: '' } });
  await i13.submitTransfer();
  ok('全是「不修改」时不发请求', batchCalls.length === 0, JSON.stringify(batchCalls.map((c) => c.body)));

  // 年级显示必须用 label（2025级），不是裸 value（2025）
  i13.setData({ 'transferSheet.mode': 'full', 'transferSheet.visible': true });
  i13.onTransferPick({ currentTarget: { dataset: { level: 'grade' } }, detail: { value: '1' } });
  ok('年级回填用 label「2025级」', i13.data.transfer.gradeLabel === '2025级' && i13.data.transfer.grade === '2025', JSON.stringify({ l: i13.data.transfer.gradeLabel, v: i13.data.transfer.grade }));

  // 自由输入必须彻底移除
  const ujs = require('fs').readFileSync(path.join(MINI, 'packageAdmin/users/users.js'), 'utf8');
  ok('已无 promptBatchTransfer（自由文本弹窗）', !/promptBatchTransfer/.test(ujs), '仍在用 showModal 输入');
  ok('转移路径不再出现 editable 弹窗', !/批量转移/.test((ujs.match(/editable:\s*true[\s\S]{0,200}/g) || []).join('')));
  const u13wxml = require('fs').readFileSync(path.join(MINI, 'packageAdmin/users/users.wxml'), 'utf8');
  ok('批量栏有「一键转院校」与「转移」两个入口', /一键转院校/.test(u13wxml) && /data-mode="school"/.test(u13wxml) && /data-mode="full"/.test(u13wxml));
  // 未知 action 不得落到默认分支发请求
  batchCalls.length = 0;
  i13.onBatchAction({ currentTarget: { dataset: { action: 'unknown-op' } } });
  ok('未知 action 不发请求（防带空 body 打服务端）', batchCalls.length === 0, JSON.stringify(batchCalls.map((c) => c.body)));

  // ===== 用户详情页：教师不该出现学生会区块与学生专属字段（用户 2026-10-20 截图）=====
  // 后端三处硬性禁止教师加入学生会（routes/admin/union.js），所以「学生会」区块对教师
  // 永远只会显示「未加入」——纯噪音，还暗示"教师也能进学生会只是没加"。
  // 学号/班级/专业同理：教师没有这三项，显示出来永远是「—」。
  console.log('[9] 用户详情页：教师隐藏学生会 + 学号/班级/专业');
  const udWxml = require('fs').readFileSync(path.join(MINI, 'packageAdmin/user-detail/user-detail.wxml'), 'utf8');
  const udBlock = (udWxml.match(/<block wx:if="\{\{[^}]*isTeacherUser[^}]*&&[^}]*\}\}">\s*<view class="tt-section">\s*<text>学生会<\/text>[\s\S]*?<\/block>/) || [''])[0];
  ok('学生会区块对教师隐藏', udBlock.length > 0 && /!isTeacherUser/.test(udBlock), '学生会 block 未按 isTeacherUser 守卫');
  const udTeacher = (udWxml.match(/<view class="ud-grid">[\s\S]*?<\/view>\s*<\/view>/) || [''])[0];
  const stuRow = (udTeacher.match(/<view class="ud-grid-item"[^>]*>\s*<text class="ud-grid-l">学号<\/text>/) || [''])[0];
  ok('学号行对教师隐藏', /wx:if="\{\{!isTeacherUser\}\}"/.test(stuRow), stuRow || '学号行无守卫');
  const clsRow = (udTeacher.match(/<view class="ud-grid-item"[^>]*>\s*<text class="ud-grid-l">班级<\/text>/) || [''])[0];
  ok('班级行对教师隐藏', /wx:if="\{\{!isTeacherUser\}\}"/.test(clsRow), clsRow || '班级行无守卫');
  const specRow = (udTeacher.match(/<view class="ud-grid-item"[^>]*>\s*<text class="ud-grid-l">专业<\/text>/) || [''])[0];
  ok('专业行对教师隐藏', /wx:if="\{\{!isTeacherUser\}\}"/.test(specRow), specRow || '专业行无守卫');
  // 院校/院系/注册时间教师也可能有 → 不能被误伤
  const keepRow = (label) => (udTeacher.match(new RegExp(`<view class="ud-grid-item"[^>]*>\\s*<text class="ud-grid-l">${label}<\\/text>`)) || [''])[0];
  ok('院校行教师仍可见（创建教师可填）', !/wx:if/.test(keepRow('院校')), keepRow('院校'));
  ok('注册时间行教师仍可见', !/wx:if/.test(keepRow('注册时间')), keepRow('注册时间'));

  // ===== 徽章：教师不能发放（用户 2026-10-20「而且也没有发放徽章嘛」）=====
  // 徽章 9 种类型全部由运动数据推导（models/badge.js 的 type enum），没有「荣誉/手工」类型；
  // 教师不产生 run_records → 永远不可能达成任何徽章。旧注释「教师也允许手工发放」是死功能：
  // 发出去的徽章在教师页看不到（列表在「运动」Tab 内已隐藏），教师端「我的徽章」也被隐藏。
  console.log('[10] 徽章：教师不能发放（前端隐藏 + 服务端拦截）');
  const badgeBtn = (udWxml.match(/<view class="ud-quick-item"[^>]*wx:if="\{\{([^}]*)\}\}"[^>]*bind:tap="openBadgeSheet"/) || [])[1] || '';
  // 条件自 2026-10-23 起改读服务端能力表 caps.badges（班主任的 capabilities 由 /manage 下发），
  // 但「教师账号永不可发放」这条不能丢：必须同时出现 caps.badges 与 !isTeacherUser。
  ok(
    '发放徽章按钮对教师隐藏',
    /caps\.badges|canManageBadges/.test(badgeBtn) && /!isTeacherUser/.test(badgeBtn),
    badgeBtn || '未找到按钮条件'
  );
  const ubRoute = require('fs').readFileSync(path.join(__dirname, '..', 'server/src/routes/admin/user-badges.js'), 'utf8');
  const postBlock = (ubRoute.match(/router\.post\(\s*'\/:id\/badges'[\s\S]*?\n\);/) || [''])[0];
  // 拦截实现自 2026-10-22 起在 services/user-badges-manual.js（管理端与班级域共用同一份），
  // 所以「教师不可发放」必须在 service 里，路由只负责转发。
  const ubSvc = require('fs').readFileSync(path.join(__dirname, '..', 'server/src/services/user-badges-manual.js'), 'utf8');
  const grantFn = (ubSvc.match(/async function grantBadgeToUser[\s\S]*?\n\}/) || [''])[0];
  ok('服务端拦教师发放', /role === 'teacher'\) throw new ApiError/.test(grantFn), '后端未拦（只靠前端隐藏违反 AGENTS.md）');
  ok('拦截文案说明原因', /教师账号不参与运动/.test(grantFn));
  ok('管理端发放路由复用同一份实现', /manualBadges\.grantBadgeToUser\(/.test(postBlock));
  // GET 与 DELETE 刻意**不**拦教师：万一有历史脏数据，管理员必须能看见并回收
  const getBlock = (ubRoute.match(/router\.get\(\s*'\/:id\/badges'[\s\S]*?\n\);/) || [''])[0];
  const delBlock = (ubRoute.match(/router\.delete\(\s*'\/:id\/badges[\s\S]*?\n\);/) || [''])[0];
  ok('GET 不拦教师（回收历史需要）', !/teacher/.test(getBlock.replace(/\/\/.*$/gm, '')), 'GET 被误关');
  ok('DELETE 不拦教师（脏数据要能清掉）', !/role === 'teacher'\) throw/.test(delBlock), 'DELETE 被误关');
  ok('抽屉提示不再宣称教师可手工发放', !/只能由管理员手工发放/.test(udWxml), '旧文案仍在误导');

  // ===== 班级管理页级联（真实数据实测发现的两处缺陷，用户 2026-10-20「都是联动的」）=====
  // ① 院校=「全部」时旧实现 `schoolTree.get('')` 未命中 → 系部返回 []，下拉完全没得选
  //    （与它自己文件头注释「任一级选全部→下一级恢复全量」矛盾）；
  // ② 命中院校但该校无专业时旧代码 `return flat.specialties` 退回全量 →
  //    选「洋河校区」会看到 21 个北校区专业（跨院校泄漏，选了就是空筛选）。
  console.log('[11] 班级管理页：院校→系部→专业 级联（防"全部时为空"与"空时泄漏"）');
  const cmJs = require('fs').readFileSync(path.join(MINI, 'packageAdmin/class-manage/class-manage.js'), 'utf8');
  const cmBuild = (cmJs.match(/buildOptions\(facets = \{\}\) \{[\s\S]*?\n  \},/) || [''])[0];
  ok('未选院校时系部给平铺全量（不再返回空）', /if \(!schoolKey\) return flat\.departments/.test(cmBuild), '「全部院校」时系部仍可能为空');
  ok('未选院校时专业给平铺全量', /if \(!schoolKey\) return flat\.specialties/.test(cmBuild));
  // 命中院校后不得再退回全量 —— 那正是泄漏本身
  ok('命中院校但无专业时保持为空（不退回全量）', !/return seen\.size \? \[\.\.\.seen\.values\(\)\] : flat\.specialties/.test(cmBuild), '仍有「空则退全量」的泄漏分支');
  ok('专业收窄只来自命中院校的子节点', /const rawSpecs = \(\(\) => \{[\s\S]*?if \(treeMissing\) return flat\.specialties;[\s\S]*?if \(!schoolKey\) return flat\.specialties/.test(cmBuild));
  ok('tree 整体缺失才退化（旧服务端兜底）', /if \(treeMissing\) return flat\.departments/.test(cmBuild));

  console.log(failed ? `\n失败 ${failed} 项` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})();
