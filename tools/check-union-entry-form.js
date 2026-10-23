// 录入台表单回归测试：node tools/check-union-entry-form.js
//
// 背景（真实故障）：/api/union/mine 只下发模块元信息（名称 / 周期 / 可录权限），**不含 fields**；
// 录入页曾直接拿 mine.modules 当 module，导致 module.fields 恒为 undefined，
// 抽屉只剩标题 + 取消/提交按钮，表单区一片空白（用户截图反馈「录入时看不见表单」）。
//
// 本测试用打桩 auth 驱动真实的 entry.js::load + pickTarget：
//   · /api/union/mine 的模块故意不带 fields（与服务端现状一致）
//   · /api/union/modules 才带 fields（表单模板出口）
// 若页面又退回只读 /mine，fields 会为空，测试失败。
const path = require('path');

const MINI = path.join(__dirname, '..', 'miniprogram');
const calls = [];
const scrollCalls = [];
let page = null;
let failed = 0;

function ok(name, cond, detail) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` -> ${detail}`}`);
  if (!cond) failed += 1;
}

// ===== 小程序运行时打桩（只覆盖 entry.js::load 用到的 API）=====
global.Page = (cfg) => {
  page = cfg;
};
global.getApp = () => ({
  requireLogin: () => true,
  ensureLogin: async () => {},
});
global.wx = {
  showToast() {},
  showModal() {},
  pageScrollTo(opts) {
    scrollCalls.push(opts);
  },
  getStorageSync() {
    return '';
  },
  setStorageSync() {},
  removeStorageSync() {},
};

const auth = require(path.join(MINI, 'utils', 'request'));
auth.get = async (url, params) => {
  calls.push({ url, params });
  if (url === '/api/union/mine') {
    // 与服务端 routes/union.js::GET /mine 同形状：只有元信息，没有 fields
    return {
      isMember: true,
      modules: [
        {
          key: 'morning_exercise',
          name: '早操出勤',
          shortName: '早操',
          canEnter: true,
          periods: ['morning'],
          targetTypes: ['class'],
          sort: 4,
        },
      ],
    };
  }
  if (url === '/api/union/modules') {
    // 与服务端 GET /modules 同形状：fields 只在这里下发
    return {
      list: [
        {
          key: 'morning_exercise',
          name: '早操出勤',
          shortName: '早操',
          canEnter: true,
          periods: ['morning'],
          targetTypes: ['class'],
          fields: [
            { key: 'absentList', label: '缺勤名单', type: 'students' },
            { key: 'shouldCount', label: '应到人数', type: 'int', derived: true, divisor: true },
            { key: 'actualCount', label: '实到人数', type: 'int', derived: true },
            { key: 'absentCount', label: '缺勤人数', type: 'int', derived: true },
          ],
        },
      ],
      studentFieldLimit: 200,
    };
  }
  if (url === '/api/union/entry/targets') {
    return {
      backfillDays: 3,
      targets: [
        {
          targetId: 't1',
          targetName: '20大数据技术',
          className: '20大数据技术',
          targetType: 'class',
          studentCount: 1,
        },
      ],
    };
  }
  throw new Error(`未预期的请求：${url}`);
};

require(path.join(MINI, 'packageUnion', 'entry', 'entry.js'));

function makeInstance() {
  const inst = Object.assign({}, page);
  inst.data = JSON.parse(JSON.stringify(page.data));
  inst.setData = function setData(patch, cb) {
    for (const [k, v] of Object.entries(patch)) {
      if (k.includes('.')) {
        const [a, b] = k.split('.');
        this.data[a] = { ...(this.data[a] || {}), [b]: v };
      } else {
        this.data[k] = v;
      }
    }
    if (cb) cb();
  };
  return inst;
}

(async () => {
  const inst = makeInstance();
  inst.data.moduleKey = 'morning_exercise';
  await inst.load();

  ok('load 请求表单模板 /api/union/modules', calls.some((c) => c.url === '/api/union/modules'));
  ok('load 后 module.fields 有 4 项', (inst.data.module.fields || []).length === 4, JSON.stringify(inst.data.module));
  ok('名单人数上限取自 /modules', inst.data.personsLimit === 200, String(inst.data.personsLimit));

  inst.pickTarget({ currentTarget: { dataset: { id: 't1' } } });
  // applyDerived 有 120ms 防抖
  await new Promise((r) => setTimeout(r, 180));

  ok('打开抽屉后 fields 非空（表单不会空白）', inst.data.fields.length === 4, JSON.stringify(inst.data.fields.map((f) => f.key)));
  ok(
    '实到人数不再渲染成输入框',
    inst.data.fields.filter((f) => !f.derived).every((f) => f.key !== 'actualCount'),
    JSON.stringify(inst.data.fields.filter((f) => !f.derived).map((f) => f.key))
  );
  ok('打开抽屉后 showForm=true', inst.data.showForm === true);
  ok('派生字段进入「自动计算」而不是输入框', inst.data.derivedRows.length === 3, JSON.stringify(inst.data.derivedRows));
  ok('应到人数来自对象人数，不再显示 0', inst.data.form.shouldCount === 1 && inst.data.derivedRows.find((r) => r.key === 'shouldCount').value === 1, JSON.stringify(inst.data.derivedRows));
  ok('实到默认 = 应到（未选缺勤）', inst.data.derivedRows.find((r) => r.key === 'actualCount').value === 1, JSON.stringify(inst.data.derivedRows));
  ok('抽屉副标题保留对象人数', inst.data.current && inst.data.current.info === '20大数据技术 · 1 人', JSON.stringify(inst.data.current && inst.data.current.info));

  // 选 1 名缺勤 → 实到 1−1=0、缺勤 1（前端预览与服务端 fillDerived 同口径）
  inst.onPersonsChange({
    currentTarget: { dataset: { field: 'absentList' } },
    detail: { selected: [{ userId: 'u1', name: '张庆宇', studentId: '2024090500' }] },
  });
  await new Promise((r) => setTimeout(r, 180));
  const rows = inst.data.derivedRows;
  ok('选缺勤后实到自动减 1', rows.find((r) => r.key === 'actualCount').value === 0, JSON.stringify(rows));
  ok('选缺勤后缺勤人数自动变 1', rows.find((r) => r.key === 'absentCount').value === 1, JSON.stringify(rows));

  // 查宿：应住/实到/未归 同一套口径（应住来自房间在住人数，不是班级台账）
  inst.data.module = {
    key: 'night_dorm',
    fields: [
      { key: 'shouldStay', label: '应住人数', type: 'int', derived: true, divisor: true },
      { key: 'actualCount', label: '实到人数', type: 'int', derived: true },
      { key: 'notReturnedCount', label: '未归人数', type: 'int', derived: true },
    ],
  };
  inst.data.form = { shouldStay: 4, absentList: [{ userId: 'u1' }, { userId: 'u2' }] };
  inst.applyDerived();
  await new Promise((r) => setTimeout(r, 180));
  const dorm = inst.data.derivedRows;
  ok(
    '查宿：实到 = 应住 − 未归名单，未归 = 名单人数',
    dorm.find((r) => r.key === 'shouldStay').value === 4 &&
      dorm.find((r) => r.key === 'actualCount').value === 2 &&
      dorm.find((r) => r.key === 'notReturnedCount').value === 2,
    JSON.stringify(dorm)
  );

  // 院校 / 系部 / 年级三级筛选 + 今年置顶
  inst.data.currentYear = '2026';
  inst.data.schoolFilter = '';
  inst.data.departmentFilter = '';
  inst.data.gradeFilter = '';
  inst.data.keyword = '';
  inst.data.targets = [
    { targetId: 'a', targetName: '20大数据技术', schoolKey: '北校区', departmentKey: '计财系', grade: '2020', gradeKey: '2020', isCurrentYear: false, status: '' },
    { targetId: 'b', targetName: '26级软件技术', schoolKey: '北校区', departmentKey: '计财系', grade: '2026', gradeKey: '2026', isCurrentYear: true, status: 'submitted' },
    { targetId: 'c', targetName: '25级电子商务', schoolKey: '北校区', departmentKey: '机电建工系', grade: '2025', gradeKey: '2025', isCurrentYear: false, status: '' },
    { targetId: 'd', targetName: '24级物流管理', schoolKey: '洋河校区', departmentKey: '计财系', grade: '2024', gradeKey: '2024', isCurrentYear: false, status: '' },
    { targetId: 'e', targetName: '宿舍 101', schoolKey: 'other', departmentKey: 'other', grade: '', gradeKey: 'other', isCurrentYear: false, status: '' },
  ];
  inst.applyFilter();
  ok('今年班级排在列表最前（不受已录状态影响）', inst.data.filtered[0].targetId === 'b', JSON.stringify(inst.data.filtered.map((t) => t.targetId)));
  ok(
    '院校选项：全部 + 北校区 + 洋河校区 + 未关联',
    inst.data.schoolOptions.map((o) => o.key).sort().join(',') === ',other,北校区,洋河校区',
    JSON.stringify(inst.data.schoolOptions)
  );
  inst.data.schoolFilter = '北校区';
  inst.applyFilter();
  ok('选院校后只显示该院校（3 个）', inst.data.filtered.length === 3, JSON.stringify(inst.data.filtered.map((t) => t.targetId)));
  ok('顶部进度跟随筛选范围（3 个）', inst.data.stats.total === 3, JSON.stringify(inst.data.stats));
  ok(
    '系部选项随院校收敛（只剩计财系 / 机电建工系）',
    inst.data.departmentOptions.map((o) => o.key).sort().join(',') === ',机电建工系,计财系',
    JSON.stringify(inst.data.departmentOptions)
  );
  inst.data.departmentFilter = '计财系';
  inst.applyFilter();
  ok('选系部后只显示该系部（2 个）', inst.data.filtered.length === 2, JSON.stringify(inst.data.filtered.map((t) => t.targetId)));
  inst.data.gradeFilter = '2026';
  inst.applyFilter();
  ok('再选年级后只显示 2026 级（1 个）', inst.data.filtered.length === 1 && inst.data.filtered[0].targetId === 'b', JSON.stringify(inst.data.filtered.map((t) => t.targetId)));
  inst.data.schoolFilter = '';
  inst.data.departmentFilter = '';
  inst.data.gradeFilter = '';
  inst.applyFilter();
  ok(
    '年级选项含「今年 / 其他年份 / 其他」',
    inst.data.gradeOptions.map((o) => o.key).join(',') === ',2026,2025,2024,2020,other',
    JSON.stringify(inst.data.gradeOptions)
  );
  inst.data.keyword = '25级';
  inst.applyFilter();
  ok('搜索与筛选可叠加', inst.data.filtered.length === 1 && inst.data.filtered[0].targetId === 'c', JSON.stringify(inst.data.filtered.map((t) => t.targetId)));
  inst.locateNextMissing();
  ok('提交后自动滚动到下一个未录对象', scrollCalls.some((c) => c.selector === '#en-target-0'), JSON.stringify(scrollCalls));

  // ===== 记录详情 →「修改」→ 录入台 的入口链路 =====
  // 用户报障「点击修改没有效果」。两个真实成因都在这条链上，必须由检查脚本守住：
  //   ① 「修改」曾做成 36rpx 高的下划线文字链 —— 手指点不准，等于点了没反应；
  //   ② wx.navigateTo 在页面栈满时会**静默失败**（没有任何界面反馈）。
  const fs = require('fs');
  const recordJs = fs.readFileSync(path.join(MINI, 'packageUnion', 'record', 'record.js'), 'utf8');
  const recordWxml = fs.readFileSync(path.join(MINI, 'packageUnion', 'record', 'record.wxml'), 'utf8');
  const recordWxss = fs.readFileSync(path.join(MINI, 'packageUnion', 'record', 'record.wxss'), 'utf8');
  const editCss = (recordWxss.match(/\.rd-bar-edit \{[\s\S]*?\}/) || [''])[0];
  ok('「修改」是 88rpx 高的实体按钮（不是点不准的文字链）', /height:\s*88rpx/.test(editCss) && !/text-decoration/.test(editCss), editCss.replace(/\s+/g, ' '));
  ok('「修改」有中性底色（不与品牌橙抢主操作）', /background:\s*var\(--tt-bg-page\)/.test(editCss), editCss.replace(/\s+/g, ' '));
  ok('「修改」有 hover-class 点按反馈', /rd-bar-edit[\s\S]{0,160}hover-class="rd-bar-edit-hover"/.test(recordWxml));
  ok('「修改」绑定 edit()', /class="rd-bar-edit"[\s\S]{0,160}bind:tap="edit"/.test(recordWxml));
  ok('edit() 跳转带 recordId / targetId / date', /recordId=/.test(recordJs) && /targetId=/.test(recordJs) && /date=/.test(recordJs));
  ok('navigateTo 失败退到 redirectTo（不静默）', /wx\.navigateTo\(\{ url, fail: \(\) => wx\.redirectTo/.test(recordJs));
  ok('页面栈快满时直接 redirectTo', /stack\.length >= 9/.test(recordJs) && /wx\.redirectTo\(\{ url, fail: failToast \}\)/.test(recordJs));

  console.log(`\n${failed ? `FAILED ${failed}` : '全部通过'}`);
  process.exitCode = failed ? 1 : 0;
})();
