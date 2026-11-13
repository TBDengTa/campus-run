// 检查录入台（分包 packageUnion）：五个模块共用一张表单
//
// 设计要点：
//   ① 字段定义**全部来自服务端**（GET /api/union/modules 下发 check_modules.fields），
//      前端只负责按 type 渲染控件、按 required 标必填 —— 运营改字段不用发版；
//   ② 对象列表来自 GET /api/union/entry/targets（已带「未录 / 已录 / 已取消」状态），
//      早操 / 早八的「本班无早操」班级服务端已经不返回，前端不再判断；
//   ③ 重复提交由服务端拦（409 + existingId），前端拿到后询问是否改为编辑该条；
//   ④ 学生名单类字段（缺勤 / 未归）统一走 person-picker 搜索勾选，不手输姓名学号；
//   ⑤ **派生字段（f.derived）不让填**：「能从已知数推导出来的人数」（早操/早八/晚自习的缺勤、
//      查宿的未归）一律由服务端推算回写，前端只在表单里展示成只读的「计算结果」行，
//      且**提交 payload 里一定不含它**（服务端 normalizeDetails 也会忽略，但前端不该发）。
//      口径见 docs/round2-tasks.md §2 R2。
const auth = require('../../utils/request');
const fmt = require('../../utils/format');

// ===== 留证照片（type='photo'）=====
// 拍照**选填、张数不限**（用户 2026-11-12「解除所有上传照片的限制」）。
// 服务端也不再裁剪张数（routes/union.js / check-modules.js 都不再 slice），
// 所以「前端传多少、库里就存多少」，不存在静默丢图。

// ===== 受检对象类型（用户 2026-10-26 第 4 点：卫生检查要能按 宿舍 / 班级 / 室外 筛选）=====
// key 与服务端 check-modules.js 的 targetTypes 一一对应：
//   classroom 教室 · dorm_room 宿舍 · area 室外卫生区 · class 班级（无教室数据的模块）
const TARGET_TYPE_KEY = {
  classroom: 'classroom',
  class: 'class',
  dorm_room: 'dorm',
  area: 'outdoor',
};
const TARGET_TYPE_TEXT = {
  classroom: '教室',
  class: '班级',
  dorm: '宿舍',
  outdoor: '室外',
};

// 单次选择张数：wx.chooseMedia 平台上限就是 9 张/次；用户可以连续点「拍照 / 相册」累加，
// 页面不再设总张数上限（以前单次最多 9 张，第 10 张会被直接拦住）。
const PHOTO_PICK_COUNT = 9;
// 平台上传通道对超大文件可能直接 fail（服务端已不限制，但客户端不受我们控制）：
// **原图优先**，只有 uploadFile 失败后才压缩重试一次（不是上传前的预压缩，不影响正常画质）。
const PHOTO_RETRY_EDGE = 2560;
// 照片字段的 type。后端已把 check-module 的 type enum 定为 'photo'，
// 这里同时容忍 'photos' / 'image' 两种写法（契约演进期的保守兼容，**不改字段名**）。
const PHOTO_TYPES = ['photo', 'photos', 'image'];

function isPhotoField(f) {
  if (!f) return false;
  if (PHOTO_TYPES.indexOf(String(f.type || '')) >= 0) return true;
  // 兜底：字段定义只给了 key='photos' 而 type 缺省（后端契约落地过程中的中间态）
  return !f.type && f.key === 'photos';
}

// select 字段的值在表单里是**数组**（多选口径，见 onSelectTap）；这里统一成字符串数组再判值
function selectedValues(v) {
  if (Array.isArray(v)) return v.map((x) => String(x));
  return v === '' || v === null || v === undefined ? [] : [String(v)];
}

// =====「网课」分支（仅晚自习）=====
// 用户口径：grade='网课' 的班级**班内无学生**（学生在宿舍观看），
// 「实到人数 / 缺勤名单 / 缺勤原因」都不需要填报 → 前端**隐藏**；
// 「留证照片」保留（网课同样要留证）。
// ⚠️ 服务端也会清空这几个字段，所以提交体必须**同口径清空**，否则两边不一致
//    （前端还带着上一轮填的实到人数提交，就变成「界面没填、记录里有数」）。
const ONLINE_DORM = '网课';
const ONLINE_DORM_MODULE = 'study_evening';

function isOnlineDorm(moduleKey, form) {
  if (String(moduleKey || '') !== ONLINE_DORM_MODULE) return false;
  return selectedValues((form || {}).grade).indexOf(ONLINE_DORM) >= 0;
}

// 「网课」下要隐藏 / 清空的字段 key：**按字段在 fields 里的顺序**取 grade 之后的非照片字段，
// 不按 key 名单硬编码 —— 运营在管理端调整字段顺序时不会算错。
function hiddenKeysInOnlineDorm(fields) {
  const out = {};
  let seenGrade = false;
  for (const f of fields || []) {
    if (!f || !f.key) continue;
    if (f.key === 'grade') {
      seenGrade = true;
      continue;
    }
    if (seenGrade && !isPhotoField(f)) out[f.key] = true;
  }
  return out;
}

// select 字段默认是**多选**（内置的问题项 / 违规类型、管理端自定义模块都依赖这个行为，不能改）。
// 唯一的例外是「评价」类字段（key='grade'，优/良/差/网课）：语义上必须**单选**，
// 多选会录出「优 + 差」这种自相矛盾、且服务端 normalizeDetails 会原样存下来的评价。
const SINGLE_SELECT_KEYS = { grade: true };

// ===== 人名搜索的取数范围 =====
// 现行口径（用户 2026-11-12 报「录入早八时名单怎么是全校呢」后的修订）：
//   晚自习 / 早操 / **早八** = **本班名单**；查宿 = 宿内名单。
// 早八以前走「全校名单」，但录入台是**按班级逐条录**的（抽屉标题就是「26级信息安全技术应用 · 48 人」），
// 给一份全校名录等于让检查人在两千多人里找自己班那 48 个，勾错人还会直接落库、不可回滚。
// 服务端 scope=school 分支保留（跨班搜索仍是独立能力，别处要用），录入台不再默认走它。
// 名单来源提示（范围条之外的补充说明）
const PICKER_API = '/api/union/entry/students';
const PICKER_HINTS = {
  class: '',
  dorm: '按本宿舍在住名单列出（混宿房间会带上其它班的同学）',
  school: '校内名单：可按姓名 / 学号 / 班级搜索',
};

// 早八新增的只读 lateCount = 迟到名单人数（名单里有几个人就是几个人，不需要另填数字）。
const LATE_LIST_KEY = 'lateList';
const LATE_COUNT_KEY = 'lateCount';

// 第五轮考勤口径：实到人数不再手填，选完缺勤 / 未归名单后自动推算。
// 这里只做**表单上的即时预览**（不参与提交），公式必须与服务端
// services/check-modules.js::fillDerived 的新口径逐条一致：
//   实到 = 应到（应住） − 名单人数；缺勤/未归 = 名单人数。
const ATTENDANCE_META = {
  morning_exercise: { shouldKey: 'shouldCount', countKey: 'absentCount', listKey: 'absentList', countLabel: '缺勤' },
  study_evening: { shouldKey: 'shouldCount', countKey: 'absentCount', listKey: 'absentList', countLabel: '缺勤' },
  night_dorm: { shouldKey: 'shouldStay', countKey: 'notReturnedCount', listKey: 'absentList', countLabel: '未归' },
};

// 卫生「评价 → 得分」的展示副本（与服务端 GRADE_SCORE 同口径）
// ⚠️ 10 分制（用户 2026-11-12）：比值 1 : 0.8 : 0.6 与百分制一致，只是刻度换成 10 / 8 / 6。
//    服务端下发字段里的 max 与 hint，这里只在「服务端没给」时兜底 —— 兜底值必须同刻度，
//    否则首帧预览显示 80 分、提交后落库 8 分（用户会以为录入丢了数据）。
const GRADE_SCORE = { 优: 10, 良: 8, 差: 6 };
// 得分字段满分的前端兜底（正常由服务端 fields[].max 下发；这里只防「服务端没给 max」）
const FULL_SCORE_FALLBACK = 10;

// 表单值 → 数字（空串 / 未填一律按 0，与服务端 fillDerived 的 Number(x)||0 同口径）
function numOf(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// 读接口返回里的数值（提交成功后取服务端推算结果，多种字段名都兼容）
function readNum(src, keys) {
  for (const k of keys) {
    const v = src ? src[k] : undefined;
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// 提交成功后展示服务端推算结果（可选增强；拿不到就只说「提交成功」）
function derivedToast(payloadDetails, res) {
  const src = (res && (res.details || (res.record && res.record.details))) || payloadDetails || {};
  const parts = [];
  const absent = readNum(src, ['absentCount']);
  const notReturned = readNum(src, ['notReturnedCount']);
  if (absent !== null) parts.push(`缺勤 ${absent} 人`);
  if (notReturned !== null) parts.push(`未归 ${notReturned} 人`);
  return parts.join(' · ');
}

// 「本模块今日已全部录入」的提示文案：带上已录 / 已复核的分布，录入人一眼知道今天这摊活的状态。
// 唯一定义处（页面顶部常驻提示 + 提交完最后一个的那次 toast **共用同一份文案**，避免两处口径写歪）。
function allEnteredToastText(stats, prefix = '本模块今日') {
  const s = stats || {};
  const parts = [`已录 ${s.entered || 0}`];
  if (Number(s.reviewed)) parts.push(`已复核 ${s.reviewed}`);
  if (Number(s.total)) parts.push(`共 ${s.total}`);
  return `${prefix}已全部录入 · ${parts.join(' / ')}`;
}

// 让列表行与抽屉副标题都能显示「· 32 人」这层副信息：班级对象用 studentCount，
// 宿舍房间用 residents（服务端 entryTargets 两种都下发，见 services/band-chao.js）。
function infoOf(target) {
  const t = target || {};
  const n = Number(t.studentCount || t.residents || 0);
  return n > 0 ? ` · ${n} 人` : '';
}

// 模块切换条上的角标：读 module 自己的数据（服务端 /api/union/mine 的 module 对象）
// ⚠️ **不用 this.data.targets** —— targets 只属于当前 moduleKey，拿它去标别的模块会串数据。
function badgeOf(m) {
  const mm = m || {};
  const entered = Number(mm.enteredCount);
  const total = Number(mm.targetCount || mm.totalCount);
  if (!Number.isFinite(entered) || !Number.isFinite(total) || total <= 0) return '';
  return ` ${entered}/${total}`;
}

// 点对象 → 列表页与抽屉**不同时展开成长页**：抽屉打开时把「列表 → 详情」这条纵向导航去掉。
// 必备条件（不是可选优化）：抽屉用 fixed 定位，页面在它底下**还能滚**，
// 列表被滚走的话 wx.pageScrollTo(top:0) 就再也把当前对象带回视野 —— 连续作业直接断掉。
const BODY_LOCK_CLASS = 'en-body-locked';

// 今天往前 n 天的日历键（补录窗口用）
function dayOptions(days) {
  const out = [];
  const today = fmt.todayKey ? fmt.todayKey() : '';
  const base = today ? new Date(`${today}T00:00:00`) : new Date();
  for (let i = 0; i < days; i += 1) {
    const d = new Date(base.getTime());
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({ key, label: i === 0 ? `今天 ${key}` : i === 1 ? `昨天 ${key}` : key });
  }
  return out;
}

Page({
  data: {
    loading: true,
    moduleKey: '',
    module: null,
    modules: [],
    canEnter: false,
    // 选项
    dateIndex: 0,
    dates: [],
    periodIndex: 0,
    periods: [],
    periodLabels: [],
    backfillDays: 3,
    // 对象
    targets: [],
    filtered: [],
    targetIndex: -1,
    current: null,
    keyword: '',
    // 申诉改判模式（从「申诉成立 → 更正记录内容」进来）：提交时带 settleAppeal 一并结案
    appealReview: false,
    // 「提交修改」带过来的定位信息（recordId / targetId / date / period）：
    // 进页面后自动选中该日、并在 targets 就绪后打开那条记录的抽屉（见 applyFocus）。
    focus: null,
    focusDone: false,
    // 年级筛选：currentYear 由服务端下发（今天所在年），今年班级排在列表最前；
    // gradeFilter = '' 全部 / '2026' 某年级 / 'other' 没有年级或未来年级（如测试班）
    currentYear: '',
    hasCurrentYear: false,
    // 院校 / 系部 / 年级 三级筛选（服务端已按分会范围收敛 targets，选项只从可见对象生成）
    schoolFilter: '',
    departmentFilter: '',
    gradeFilter: '',
    schoolOptions: [{ key: '', label: '全部' }],
    departmentOptions: [{ key: '', label: '全部' }],
    gradeOptions: [{ key: '', label: '全部' }],
    schoolIndex: 0,
    departmentIndex: 0,
    gradeIndex: 0,
    // 受检对象类型 / 楼栋筛选（用户 2026-10-26 第 4、5 点）：
    //   typeFilter    '' 全部 / classroom 教室 / class 班级 / dorm 宿舍 / outdoor 室外
    //   buildingFilter '' 全部 / 具体楼栋（晚自习按教学楼，查宿按宿舍楼）
    //   选项都由 buildTypeOptions / buildBuildingOptions 从真实对象生成，不写死
    typeFilter: '',
    buildingFilter: '',
    typeOptions: [],
    buildingOptions: [],
    typeIndex: 0,
    buildingIndex: 0,
    // 分院身份：明确告知筛选范围被收在本院校（校区）内（服务端也会 fail-closed 收敛 targets）
    scopeHint: '',
    // 列表侧的状态汇总（B 端头部一眼看出今天还差多少）与「本模块今日已全部录入」提示
    //   allEntered：本模块今日已无未录对象
    //   allEnteredTip：页面顶部的常驻提示文案
    //   allEnteredToast：提交完最后一个后弹一次；用完之后置回空串，
    //     避免下次 `await this.loadTargets()` 回来又弹一遍（只有「刚录完最后一个」才该弹）
    stats: { total: 0, entered: 0, missing: 0, reviewed: 0 },
    listTip: '',
    allEntered: false,
    allEnteredTip: '',
    allEnteredToast: '',
    locatingId: '', // 刚录完自动定位的目标（高亮 + 下次打开抽屉的滚动锚点）
    bodyLocked: false, // 抽屉打开时为 true → 页面不可滚（见 BODY_LOCK_CLASS 说明）
    // 表单
    form: {},
    fields: [], // 当前受检对象下**确实要渲染**的字段（网课分支会剔除后续字段），由 buildFields 产出
    derivedRows: [], // 派生字段的只读「计算结果」行（不参与提交）
    // 留证照片（type='photo'）：每张 { path(本地临时图，预览用), url(上传成功后), status, progress, error }
    //   status：pending 待传 / uploading 上传中 / done 已上传 / failed 失败可重试
    photos: [],
    photosFailedCount: 0,
    uploading: false,
    // 「网课」分支：grade='网课' 时隐藏后续字段并清空（仅晚自习）
    onlineDorm: false,
    onlineDormTip: '',
    // 状态
    submitting: false,
    showForm: false,
    existingId: '',
    // 名单类字段：选人组件的查询参数（固定用当前受检对象所在班级 + 模块归属鉴权所需 moduleKey）
    //   ⚠️ moduleKey 必须有：服务端 /entry/students 的 requireModule() 缺它直接 400「缺少 moduleKey」，
    //   早期漏传导致缺勤 / 未归名单搜索一直是坏的（接口报错，界面只弹 toast）。
    pickerQuery: {},
    pickerHint: '',
    // 名单范围标题（person-picker 顶部展示，用户 2026-11-04「缺勤名单中没有显示本班级或
    // 本宿舍的名称」）：晚自习=教室·班级、查宿=楼栋房间、早八=全校；由 pickTarget 按对象计算
    scopeLabel: '',
    // 查宿名单行内显示学生班级（混宿房间会带出别班学生，不标班级没法核对）
    pickerShowClass: false,
    personsLimit: 200,
    // ===== 批量录入「无缺勤」（用户 2026-11-04）=====
    canBatch: false, // 模块有名单类字段且非「只记异常人」（早八）时才提供批量
    batchMode: false,
    batchIds: {}, // targetId -> true（只含「还没有生效记录」的对象）
    batchCount: 0,
    // 批量统一值（用户 2026-11-04「批量录入可以选择批量的评价」）：模块里所有带选项的
    // select 字段（晚自习=评价）都在批量配置卡里统一选，提交时整批用同一值
    batchSelects: [],
    batchSubmitting: false,
    batchLimit: 100, // 单次批量上限：逐条走单条接口，防一次点出几百个请求
  },

  onLoad(options) {
    if (!getApp().requireLogin()) return;
    const moduleKey = options.moduleKey || '';
    // 「提交修改」跳进来的定位信息（见 record.js::edit）：记录详情把 id / 受检对象 / 日期 / 时段带过来，
    // 进页面后自动选好筛选项并打开该对象的抽屉，用户不必再去列表里找 —— 否则「提交修改」点了等于没反应。
    const focus = {
      recordId: options.recordId || '',
      targetId: options.targetId || '',
      date: options.date || '',
      period: options.period || '',
    };
    // 申诉改判模式：从申诉「申诉成立 → 更正记录内容」进来，提交时带 settleAppeal 一并结案
    const appealReview = options.appealReview === '1';
    this.setData({ moduleKey, dates: dayOptions(30), focus, appealReview });
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    // 抽屉开着时**不要重载**（用户 2026-10-24 报「拍照上传到 100% 时弹窗被关掉了」）。
    //
    // 链路：wx.chooseMedia 拍照 → 微信切到相机界面 → 小程序 onHide →
    //       选完照片返回 → onShow → load() → loadTargets() 把
    //       showForm / photos / form / current 一次性重置 →
    //       正在上传的抽屉连同刚选的照片全部消失，看起来像「传完自动关闭」。
    // 列表数据晚几秒刷新没有代价（提交后会主动 loadTargets），但表单内容丢了必须重拍，
    // 所以这里优先保表单：抽屉开着就跳过这次重载。
    if (this.data.showForm) return;
    this.load();
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const mine = await auth.get('/api/union/mine');
      if (!mine || !mine.isMember) {
        this.setData({ loading: false });
        wx.showToast({ title: '你还不是学生会成员', icon: 'none' });
        return;
      }
      const list = (mine.modules || []).filter((m) => m.canEnter && m.key);
      if (!list.length) {
        this.setData({ loading: false, module: null, canEnter: false, modules: [] });
        wx.showToast({ title: '你所在的部门暂不负责检查录入', icon: 'none' });
        return;
      }
      const moduleKey = this.data.moduleKey && list.some((m) => m.key === this.data.moduleKey) ? this.data.moduleKey : list[0].key;
      // ⚠️ 表单字段模板必须走 /api/union/modules：
      // /api/union/mine 只下发模块元信息（名称 / 周期 / 可录权限），**不含 fields**。
      // 之前这里直接拿 mine.modules 里的模块当 module，fields 恒为 undefined →
      // 抽屉只剩标题和底部按钮，表单区一片空白（用户报「录入时看不见表单」）。
      const tpl = await auth.get('/api/union/modules', { moduleKey });
      const full = (tpl.list || []).find((m) => m.key === moduleKey && m.canEnter !== false);
      if (!full) {
        this.setData({ loading: false, module: null, canEnter: false, modules: [] });
        wx.showToast({ title: '该检查模块未配置或已停用', icon: 'none' });
        return;
      }
      const module = { ...(list.find((m) => m.key === moduleKey) || {}), ...full };
      const periods = module.periods || [];
      // ===== 批量录入「无缺勤」的可用性（用户 2026-11-04）=====
      // 仅对「有名单类字段」的考勤模块开放（晚自习 / 早操 / 查宿）；早八这类
      // optionalWhenMissing 的模块「无记录 = 无迟到」，批量造全勤记录没有意义，刻意排除。
      const fieldsAll = module.fields || [];
      // 批量统一值：模块里所有带选项的 select 字段（晚自习=评价）都进批量配置卡，默认第一项
      const batchSelects = fieldsAll
        .filter((f) => f && !f.derived && f.type === 'select' && (f.options || []).length)
        .map((f) => ({ key: f.key, label: f.label || f.key, options: f.options, value: f.options[0] }));
      this.setData({
        module,
        modules: list,
        moduleKey,
        canEnter: true,
        periods,
        periodLabels: periods.map((p) => this.periodLabel(p)),
        periodIndex: 0,
        // 分院身份：筛选范围只到本院校（校区）下的系部；服务端 entryTargets 也会按此收敛
        scopeHint: mine.level === 'branch' ? '当前身份只能筛选本院校（校区）下的系部与班级' : '',
        // 名单类字段的人数上限由 /modules 下发（与 /mine 不同，它带表单模板与服务端校验同源常量）
        personsLimit: tpl.studentFieldLimit || 200,
        canBatch: fieldsAll.some((f) => f && f.type === 'students') && !module.optionalWhenMissing,
        batchSelects,
      });
      await this.loadTargets();
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  periodLabel(key) {
    const map = { morning: '早上', morning_class: '早八', daytime: '白天', evening_study: '晚自习', night: '夜间' };
    return map[key] || key || '全天';
  },

  async loadTargets() {
    const { moduleKey, dates, dateIndex, periodIndex, periods } = this.data;
    const date = (dates[dateIndex] || {}).key || '';
    const period = periods[periodIndex] || '';
    this.setData({ loading: true });
    const data = await auth.get('/api/union/entry/targets', { moduleKey, date, period });
    const currentYear = String(data.currentYear || new Date().getFullYear()).slice(0, 4);
    // 「只记异常人」的模块（早八）：未录的行内状态显示「无迟到」而不是「未录」
    const optionalModule = (this.data.module && this.data.module.optionalWhenMissing) === true;
    const noRecordText = (this.data.module && this.data.module.noRecordText) || '无迟到';
    const targets = (data.targets || []).map((t) => {
      const grade = String(t.grade || '').trim();
      const year = Number(grade);
      const current = Number(currentYear);
      // 「其他」= 没有年级 / 未来年级（测试班 56级 → 2056）。未来年级不能排到今年前面。
      const gradeKey = grade && (!current || (year >= 1900 && year <= current)) ? grade : 'other';
      // ===== 受检对象类型 / 楼栋（用户 2026-10-26 第 4、5 点）=====
      //   ④ 卫生检查要能按「宿舍 / 班级 / 室外」筛选 —— 服务端 targetTypes 已有三类，
      //      前端把它们映射成中文类型键；
      //   ⑤ 晚自习「应该优先显示教室，并增加筛选教学楼」—— 服务端 targetType 已改成 classroom
      //      且下发 classroom / building，这里把标题从班级名换成教室。
      const typeKey = TARGET_TYPE_KEY[t.targetType] || t.targetType || 'class';
      const classroom = String(t.classroom || '').trim();
      const building = String(t.building || '').trim();
      // 标题：教室类模块（晚自习）优先显示教室；没有教室数据时退回班级名（不能空着）
      const showClassroom = typeKey === 'classroom' && classroom;
      return {
        ...t,
        grade,
        gradeKey,
        // 院校 / 系部用「名称」做筛选键：存量数据有 id 无名称、26 级有名称无 id，
        // 用名称才能把同一系部的新老班级归到一组；名称缺失才退回 id / other。
        schoolKey: String(t.schoolName || t.schoolId || 'other'),
        departmentKey: String(t.departmentName || t.departmentId || 'other'),
        // 只有 id 没有名称时不要把 ObjectId 直接显示给用户
        schoolLabel: String(t.schoolName || (t.schoolId ? '未命名院校' : '其他')),
        departmentLabel: String(t.departmentName || (t.departmentId ? '未命名系部' : '其他')),
        isCurrentYear: gradeKey === currentYear,
        // 类型与楼栋：筛选用（'' = 该对象没有楼栋信息，例如卫生区）
        typeKey,
        typeLabel: TARGET_TYPE_TEXT[typeKey] || '',
        buildingKey: building,
        buildingLabel: building,
        // 教室类模块显示教室名（如「1号教学楼·201」），否则显示班级名
        displayName: showClassroom ? classroom : t.targetName,
        statusClass: !t.status ? 'missing' : t.status === 'cancelled' ? 'cancelled' : t.status === 'rejected' ? 'rejected' : 'done',
        // 行内状态文案：早八未录显示「无迟到」（中性灰），不显示服务端默认的「未录」
        // —— 否则列表上一片「未录」，像是纪检部漏录（实际没人迟到是常态）。
        statusText: !t.status && optionalModule ? noRecordText : t.statusText,
        // 批量录入只允许「还没有生效记录」的对象：未录 / 已取消 / 被退回（都可重录）。
        // 与 stats 的 rawMissing 同一口径；已提交 / 已复核的对象批量会撞 409，直接不让选。
        batchable: !t.status || t.status === 'cancelled' || t.status === 'rejected',
        // 行内副信息：「23级大数据技术 · 32 人」——列表侧不再需要进表单就知道对象规模。
        // 教室类模块：副信息里补上班级（教室是主标题，班级退到副信息）
        info: showClassroom
          ? `${t.className || ''}${infoOf(t)}`
          : `${t.className || t.departmentName || ''}${infoOf(t)}`,
        // 已录对象的扣分 / 得分摘要（数据来自服务端 entryTargets 的 score / deduct）：
        // 结算口径是「扣分」优先（scoring.mode 为 deduct 的模块只有 deduct 有值），
        // 得分与扣分都为 null（未录）时不显示，避免每行都挂一个「—」。
        // 10 分制：固定两位小数，否则「扣 0.05 分」和「扣 5 分」在列表里都是「扣 5」这种误读风险。
        summary: t.status && (t.deduct || t.score) ? `扣 ${fmt.scoreText(t.deduct)} 分` : '',
      };
    });
    // 院校 / 系部 / 年级筛选在 applyFilter 里统一校验：切日期 / 模块后选项不存在会自动回到「全部」
    this.setData({
      loading: false,
      targets,
      currentYear,
      backfillDays: data.backfillDays || 3,
      targetIndex: -1,
      current: null,
      showForm: false,
      bodyLocked: false,
      locatingId: '',
      existingId: '',
      form: {},
      fields: [],
      derivedRows: [],
      photos: [],
      onlineDorm: false,
      onlineDormTip: '',
      pickerQuery: {},
      pickerHint: '',
      // 换日期 / 时段 / 模块后旧名单范围与批量勾选都失效，一并清掉
      scopeLabel: '',
      pickerShowClass: false,
      batchIds: {},
      batchCount: 0,
    });
    this.applyFilter();
    // 日期选项限制在补录窗口内（超出窗口服务端也会拒，这里提前收敛）
    const allowed = dayOptions((data.backfillDays || 3) + 1);
    this.setData({ dates: allowed });
    // 「提交修改」定位：把日期对齐到该记录那天（若在补录窗口内），再打开它的抽屉
    this.applyFocus(allowed);
  },

  // ===== 「提交修改」的定位（record.js::edit 带过来的 focus）=====
  // 为什么需要：旧实现只传 moduleKey，进录入台后停在对象列表，用户得自己再找那个受检对象 ——
  // 等于「提交修改」点了没反应（跨组遗留，见 docs/union-ui-b-round.md）。
  // 定位分两步，任一步失败都**静默降级**成「不定位」，绝不让页面报错：
  //   ① 把 dateIndex 对到该记录的日期（只在补录窗口内能找到时才切，否则不改用户当前选择）；
  //   ② targets 就绪后按 targetId 找对象、开它的抽屉（pickTarget 内部会预填「修改原记录」的 existingId）。
  applyFocus(allowedDates) {
    const f = this.data.focus;
    if (!f || this.data.focusDone) return;
    if (!f.recordId && !f.targetId) {
      this.setData({ focusDone: true });
      return;
    }
    const dates = Array.isArray(allowedDates) ? allowedDates : this.data.dates;
    // ① 日期：命中就切过去（切完 loadTargets 会重跑，focus 仍在，下一轮再走第 ② 步）
    const idx = f.date ? dates.findIndex((d) => d.key === f.date) : -1;
    if (idx >= 0 && idx !== this.data.dateIndex) {
      this.setData({ dateIndex: idx }, () => this.loadTargets());
      return;
    }
    // ② 对象：按 targetId 找（服务端每条 target 带 targetId 与已有记录的 recordId）
    const list = this.data.filtered.length ? this.data.filtered : this.data.targets;
    let hit = f.targetId ? list.find((t) => String(t.targetId) === String(f.targetId)) : null;
    // 兜底：按「该对象已有记录的 recordId」匹配（targetId 缺失时也能定位）
    if (!hit && f.recordId) hit = list.find((t) => t.recordId && String(t.recordId) === String(f.recordId));
    if (!hit) {
      // 找不到（如换了日期窗口 / 记录已被取消重录）：只在有 recordId 时提示一次，然后放弃定位
      this.setData({ focusDone: true });
      if (f.recordId) wx.showToast({ title: '未找到该对象的当日记录，请在列表中重新选择', icon: 'none' });
      return;
    }
    this.setData({ focusDone: true });
    // 打开抽屉（复用列表点击的既有入口，预填逻辑不再写第二份）
    this.pickTarget({ currentTarget: { dataset: { id: hit.targetId } } });
  },

  // 列表排序：今年班级置顶；今年内未录优先；其余年份新→旧；无年级 / 未来年级最后。
  // 这样即使 2020 级班级还没录，也不会顶掉 2026 级（用户要求「优先显示今年班级」）。
  compareTargets(a, b) {
    if (a.isCurrentYear !== b.isCurrentYear) return a.isCurrentYear ? -1 : 1;
    const statusRank = (t) => (t.status === 'submitted' || t.status === 'approved' ? 1 : 0);
    const sa = statusRank(a);
    const sb = statusRank(b);
    if (sa !== sb) return sa - sb;
    const ga = String(a.gradeKey || '');
    const gb = String(b.gradeKey || '');
    if (ga !== gb) {
      if (!ga || ga === 'other') return 1;
      if (!gb || gb === 'other') return -1;
      return gb.localeCompare(ga);
    }
    return String(a.targetName || '').localeCompare(String(b.targetName || ''));
  },

  // 下拉筛选项：列表里出现过的 key 去重，前面固定「全部」
  buildOptions(list, keyField, labelField, otherLabel) {
    const map = new Map();
    for (const t of list || []) {
      const key = String(t[keyField] || 'other');
      if (!map.has(key)) map.set(key, { key, label: key === 'other' ? otherLabel : String(t[labelField] || key), count: 0 });
      map.get(key).count += 1;
    }
    const options = [{ key: '', label: '全部', count: (list || []).length }];
    return options.concat([...map.values()].sort((a, b) => a.label.localeCompare(b.label)));
  },

  /**
   * 受检对象类型选项（用户 2026-10-26 第 4 点）。
   * 只列**当前模块真实存在**的类型：卫生有三种、早操只有班级，
   * 这样不会出现「选了宿舍但列表空」的空选项。固定顺序 教室→班级→宿舍→室外。
   */
  buildTypeOptions(list) {
    const ORDER = ['classroom', 'class', 'dorm', 'outdoor'];
    const seen = new Map();
    for (const t of list || []) {
      const k = t.typeKey || '';
      if (!k) continue;
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    // 只有一种类型时不生成选项（上层会把 typeFilter 清空，UI 也不显示这一栏）
    if (seen.size <= 1) return [];
    const options = [...seen.entries()]
      .map(([key, count]) => ({ key, label: TARGET_TYPE_TEXT[key] || key, count }))
      .sort((a, b) => {
        const ia = ORDER.indexOf(a.key);
        const ib = ORDER.indexOf(b.key);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
    return [{ key: '', label: '全部', count: (list || []).length }].concat(options);
  },

  /**
   * 楼栋选项（用户 2026-10-26 第 5 点「增加筛选教学楼」）。
   * 取当前类型集合里出现过的 building；卫生区这类没有楼栋的对象不产出选项。
   */
  /**
   * 楼栋选项（用户 2026-10-26 第 5 点「增加筛选教学楼」、第 2 点「早操不需要楼栋筛选」）。
   *
   * ⚠️ 只给**以场所为受检对象**的模块开放（教室 / 宿舍）：
   *   · 晚自习（classroom）：检查的是「哪个教室」，按教学楼筛才有意义；
   *   · 查宿 / 卫生宿舍（dorm_room）：按宿舍楼筛；
   *   · **早操 / 早八（class）**：检查的是「哪个班的出勤」，班级本身不在楼里 ——
   *     服务端也跟着班级台账带出了 classroom（那是给卫生·教室录入核对用的），
   *     拿它做筛选只会让早操平白多出一个没用的「楼栋」下拉。
   * 所以按 typeKey 放行，而不是「有 building 就显示」。
   */
  buildBuildingOptions(list) {
    const BUILDING_TYPES = ['classroom', 'dorm'];
    const seen = new Map();
    for (const t of list || []) {
      if (BUILDING_TYPES.indexOf(t.typeKey) < 0) continue;
      const b = t.buildingKey || '';
      if (!b) continue;
      seen.set(b, (seen.get(b) || 0) + 1);
    }
    if (!seen.size) return [];
    const options = [...seen.entries()]
      .map(([key, count]) => ({ key, label: key, count }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return [{ key: '', label: '全部楼栋', count: (list || []).length }].concat(options);
  },

  // 年级选项：今年标「26级·今年」置顶，其他年份新→旧，「其他」放最后
  buildGradeOptions(targets, currentYear) {
    const all = targets || [];
    const years = [...new Set(all.map((t) => t.gradeKey).filter((k) => k && k !== 'other'))].sort((a, b) => b.localeCompare(a));
    const countOf = (key) => all.filter((t) => t.gradeKey === key).length;
    const options = [{ key: '', label: '全部', count: all.length }];
    if (currentYear && years.includes(currentYear)) {
      options.push({ key: currentYear, label: `今年${currentYear.slice(2)}级`, count: countOf(currentYear) });
    }
    for (const y of years) {
      if (y === currentYear) continue;
      options.push({ key: y, label: `${y.slice(2)}级`, count: countOf(y) });
    }
    const otherN = countOf('other');
    if (otherN) options.push({ key: 'other', label: '其他', count: otherN });
    return options;
  },

  applyFilter(keyword) {
    const kw = String(keyword === undefined ? this.data.keyword : keyword || '').trim();
    const all = this.data.targets || [];

    // 院校 → 系部 → 年级逐级收敛；上一级变了，下一级选项不存在时自动回「全部」。
    let schoolFilter = this.data.schoolFilter || '';
    let departmentFilter = this.data.departmentFilter || '';
    let gradeFilter = this.data.gradeFilter || '';

    const schoolOptions = this.buildOptions(all, 'schoolKey', 'schoolLabel', '未关联院校');
    if (!schoolOptions.some((o) => o.key === schoolFilter)) {
      schoolFilter = '';
      departmentFilter = '';
      gradeFilter = '';
    }

    const bySchool = schoolFilter ? all.filter((t) => t.schoolKey === schoolFilter) : all;
    const departmentOptions = this.buildOptions(bySchool, 'departmentKey', 'departmentLabel', '未关联系部');
    if (!departmentOptions.some((o) => o.key === departmentFilter)) {
      departmentFilter = '';
      gradeFilter = '';
    }

    const byDept = departmentFilter ? bySchool.filter((t) => t.departmentKey === departmentFilter) : bySchool;
    const gradeOptions = this.buildGradeOptions(byDept, this.data.currentYear);
    if (!gradeOptions.some((o) => o.key === gradeFilter)) gradeFilter = '';

    // ===== 受检对象类型 / 楼栋筛选（用户 2026-10-26 第 4、5 点）=====
    //   ④ 卫生检查：按 宿舍 / 班级（教室）/ 室外 筛选
    //   ⑤ 晚自习：按 教学楼 筛选（服务端已下发 target.building）
    // 选项只从「当前模块真实存在的对象」生成 —— 卫生才有三类、早操只有班级，
    // 所以选择器不写死，避免出现点了没结果的空选项。
    let typeFilter = this.data.typeFilter || '';
    let buildingFilter = this.data.buildingFilter || '';
    const typeOptions = this.buildTypeOptions(all);
    if (typeOptions.length <= 1) typeFilter = ''; // 只有一种类型时不做类型筛选
    else if (!typeOptions.some((o) => o.key === typeFilter)) typeFilter = '';
    const byType = typeFilter ? all.filter((t) => t.typeKey === typeFilter) : all;
    const buildingOptions = this.buildBuildingOptions(byType);
    if (!buildingOptions.some((o) => o.key === buildingFilter)) buildingFilter = '';

    // 院校 / 系部 / 年级 / 类型 / 楼栋筛选后的范围（不含搜索）：顶部进度与「全部录完」按这个范围统计，
    // 这样切到「计财系 / 2026」时，未录 / 已录 / 受检对象不会仍显示全校 54 个。
    let scoped = all;
    if (schoolFilter) scoped = scoped.filter((t) => t.schoolKey === schoolFilter);
    if (departmentFilter) scoped = scoped.filter((t) => t.departmentKey === departmentFilter);
    if (gradeFilter === 'other') scoped = scoped.filter((t) => t.gradeKey === 'other');
    else if (gradeFilter) scoped = scoped.filter((t) => t.gradeKey === gradeFilter);
    if (typeFilter) scoped = scoped.filter((t) => t.typeKey === typeFilter);
    if (buildingFilter) scoped = scoped.filter((t) => t.buildingKey === buildingFilter);

    const list = kw ? scoped.filter((t) => String(t.targetName || '').indexOf(kw) >= 0) : scoped;
    const filtered = list.slice().sort((a, b) => this.compareTargets(a, b)).slice(0, 300);
    const hasCurrentYear = all.some((t) => t.isCurrentYear);
    const indexOf = (options, key) => {
      const i = options.findIndex((o) => o.key === key);
      return i < 0 ? 0 : i;
    };

    const scopeActive = !!(schoolFilter || departmentFilter || gradeFilter || typeFilter || buildingFilter);
    // 「只记异常人」的模块（早八）：未录**不算待办**（没人迟到是常态），
    // 所以进度里的「未录数」与「还差 N 个」都按 0 算，但**列表照旧列出**这些班级，
    // 方便纪检部在有迟到时进去补录（用户明确要求保留入口）。
    const optionalModule = (this.data.module && this.data.module.optionalWhenMissing) === true;
    const noRecordText = (this.data.module && this.data.module.noRecordText) || '无迟到';
    const rawMissing = scoped.filter((t) => !t.status || t.status === 'cancelled' || t.status === 'rejected').length;
    const missing = optionalModule ? 0 : rawMissing;
    const stats = {
      total: scoped.length,
      missing,
      rawMissing,
      optional: optionalModule,
      noRecordText,
      entered: scoped.filter((t) => t.status === 'submitted').length,
      reviewed: scoped.filter((t) => t.status === 'approved').length,
    };
    const allEntered = scoped.length > 0 && missing === 0;
    const allEnteredTip = allEntered
      ? optionalModule && stats.entered === 0
        ? `本模块今日${noRecordText}（未录即视为没有异常，不需要逐班确认）`
        : allEnteredToastText(stats, scopeActive ? '当前筛选' : '本模块今日')
      : !scoped.length
        ? scopeActive
          ? '当前筛选下没有受检对象'
          : '今日没有需要检查的对象（本模块今日无检查安排）'
        : `${scopeActive ? '当前筛选范围内' : ''}还差 ${missing} 个未录`;
    this.setData({
      schoolFilter,
      departmentFilter,
      gradeFilter,
      // 类型 / 楼栋筛选（用户 2026-10-26 第 4、5 点）
      typeFilter,
      buildingFilter,
      typeOptions,
      buildingOptions,
      typeIndex: indexOf(typeOptions, typeFilter),
      buildingIndex: indexOf(buildingOptions, buildingFilter),
      schoolOptions,
      departmentOptions,
      gradeOptions,
      schoolIndex: indexOf(schoolOptions, schoolFilter),
      departmentIndex: indexOf(departmentOptions, departmentFilter),
      gradeIndex: indexOf(gradeOptions, gradeFilter),
      filtered,
      hasCurrentYear,
      stats,
      allEntered,
      allEnteredTip,
      listTip: this.data.allEnteredToast || '',
    });
  },

  // 搜索框（wxml 绑定的是 onKeyword）：只做前端过滤，不发请求（列表已全量在手）
  onKeyword(e) {
    const keyword = (e.detail && e.detail.value) || '';
    this.setData({ keyword }, () => this.applyFilter());
  },

  // 清空搜索：回到全量列表（搜索框右侧的「清除」）
  clearKeyword() {
    this.setData({ keyword: '' }, () => this.applyFilter());
  },

  // 三级筛选：院校 → 系部 → 年级（分院能选到的院校/系部由服务端 scope 收敛）
  onSchoolChange(e) {
    const opt = this.data.schoolOptions[Number(e.detail.value) || 0] || { key: '' };
    this.setData({ schoolFilter: opt.key, departmentFilter: '', gradeFilter: '' }, () => this.applyFilter());
  },

  onDepartmentChange(e) {
    const opt = this.data.departmentOptions[Number(e.detail.value) || 0] || { key: '' };
    this.setData({ departmentFilter: opt.key, gradeFilter: '' }, () => this.applyFilter());
  },

  onGradeChange(e) {
    const opt = this.data.gradeOptions[Number(e.detail.value) || 0] || { key: '' };
    this.setData({ gradeFilter: opt.key }, () => this.applyFilter());
  },

  // 受检对象类型筛选（用户 2026-10-26 第 4 点：宿舍 / 班级 / 室外）
  // 切类型时楼栋要跟着重算：选了「宿舍」后，教学楼选项就不该还留着。
  onTypeChange(e) {
    const opt = this.data.typeOptions[Number(e.detail.value) || 0] || { key: '' };
    this.setData({ typeFilter: opt.key, buildingFilter: '' }, () => this.applyFilter());
  },

  // 楼栋筛选（用户 2026-10-26 第 5 点：晚自习按教学楼筛）
  onBuildingChange(e) {
    const opt = this.data.buildingOptions[Number(e.detail.value) || 0] || { key: '' };
    this.setData({ buildingFilter: opt.key }, () => this.applyFilter());
  },

  onDateChange(e) {
    this.setData({ dateIndex: Number(e.detail.value) || 0 }, () => this.loadTargets());
  },

  onPeriodChange(e) {
    this.setData({ periodIndex: Number(e.detail.value) || 0 }, () => this.loadTargets());
  },

  onModuleChange(e) {
    const currentKey = (this.data.module && this.data.module.key) || '';
    const key = e.currentTarget.dataset.key;
    if (!key || key === currentKey) return;
    wx.redirectTo({ url: `/packageUnion/entry/entry?moduleKey=${key}` });
  },

  // 选对象 → 打开表单（默认值按字段 default 预填）；批量模式下点行 = 勾选对象
  pickTarget(e) {
    const targetId = e.currentTarget.dataset.id;
    const target = this.data.targets.find((t) => t.targetId === targetId) || null;
    if (!target) return;
    if (this.data.batchMode) {
      this.toggleBatchTarget(target);
      return;
    }
    if (target.recordId && target.status === 'cancelled') {
      wx.showModal({
        title: '该对象已取消检查',
        content: `取消原因：${target.cancelReason || '—'}。如需重录，请点「修改原记录」重新提交。`,
        showCancel: false,
      });
    }
    // 名单类字段按「当前受检对象」取名单。服务端支持三种范围（见 pickerScope）：
    //   · class  → 班内（className）—— 晚自习 / 早操 / **早八**
    //   · dorm   → 宿内（roomId，查宿用；混宿房间会带出别班学生，这是对的 —— 查宿按房间核对人）
    //   · school → 校内（scope=school，跨班搜索；录入台当前不用，保留给后续「按人查全校」场景）
    // moduleKey 必须带上：服务端 /entry/students 的 requireModule() 需要它。
    const scope = this.pickerScope();
    const pickerQuery = { moduleKey: this.data.moduleKey || (this.data.module && this.data.module.key) || '' };
    if (scope === 'dorm') {
      // 宿舍房间对象：targetId 就是 dorm_rooms._id（宿舍卫生 / 查宿都是）
      if (target.targetType === 'dorm_room' && target.targetId) pickerQuery.roomId = target.targetId;
      if (target.className) pickerQuery.className = target.className;
    } else if (scope === 'school') {
      pickerQuery.scope = 'school';
    } else if (target.className) {
      pickerQuery.className = target.className;
    }
    // 名单范围标题（用户 2026-11-04「缺勤名单中没有显示本班级或本宿舍的名称」）：
    // 让检查人一眼确认在给谁录名单 —— 晚自习=教室·班级（教室优先是本模块的产品口径），
    // 早操 / 早八=本班（**不再是全校**，用户 2026-11-12 报「名单怎么是全校呢」），
    // 查宿=楼栋房间（混宿名单要核对房间）。整句在 JS 拼，模板不写三元拼接。
    // 教室只在「以教室为检查场所」的模块（targetTypes 认 classroom）里带上：
    // 早八/早操的教室字段是班级台账里的固定教室，写在迟到名单上会让人以为名单按教室取。
    const showClassroom = (this.data.module && (this.data.module.targetTypes || []).includes('classroom')) === true;
    const scopeLabel =
      scope === 'dorm'
        ? target.targetName || target.className || ''
        : scope === 'school'
          ? '全校名单 · 输入姓名 / 学号搜索'
          : [showClassroom ? target.classroom : '', target.className].filter(Boolean).join(' · ');
    const pickerShowClass = scope === 'dorm';
    const form = this.buildInitialForm(target);
    const moduleKey = this.data.moduleKey || (this.data.module && this.data.module.key) || '';
    // ⚠️ fields 必须在这里**同步**设好：模板是 `wx:for="{{fields}}"` 渲染表单字段的，
    //    而 fields 原先只在 afterFormChange() 的回调里赋值 —— 抽屉打开的瞬间是一帧"空表单"
    //    （截图里只有标题和按钮、没有一个输入项就是这个原因）。这里一次算对，
    //    不再依赖回调时序 / module 是否已加载。
    const initialFields = this.buildFields(moduleKey, (this.data.module && this.data.module.fields) || [], form);
    this.setData(
      {
        current: target,
        // B 端化：不再把表单铺在页面里（那样要滚很久才看到、录完还要滚回列表找下一个），
        // 改为**开半屏抽屉**填表 —— 列表始终在手边，提交后抽屉关闭并自动定位下一个未录对象。
        showForm: true,
        bodyLocked: true,
        existingId: target.recordId || '',
        photos: [],
        form,
        fields: initialFields,
        pickerQuery,
        pickerHint: PICKER_HINTS[this.pickerScope()] || '',
        scopeLabel,
        pickerShowClass,
      },
      () => {
        this.afterFormChange(form);
        // 该对象当天已有记录（recordId）→ **把已有明细填回表单**。
        // 为什么必须做：buildInitialForm 只给「字段默认值」，编辑时不预填的话表单是空的，
        // 用户直接提交就会把原值（评价 / 缺勤名单 / 备注…）整条覆盖成空 —— 属于数据损坏。
        // 旧实现只设 existingId、不预填，等于「修改」变成了「清空重填」。
        if (this.data.existingId) this.prefillFromRecord(this.data.existingId);
      }
    );
  },

  // 读回该记录的 details / photos 并填进表单（编辑场景；失败只提示，不阻断打开抽屉）
  async prefillFromRecord(recordId) {
    try {
      const data = await auth.get(`/api/union/records/${recordId}`);
      const rec = (data && data.record) || {};
      this.applyRecordToForm(rec);
    } catch (e) {
      wx.showToast({ title: '原记录读取失败，请勿直接提交', icon: 'none' });
    }
  },

  // 把服务端记录映射回表单结构（与 buildDetails 的提交格式**互为逆运算**）：
  //   select  → 数组（提交时会 join 成字符串，这里按字段定义还原）
  //   students→ 名单数组（原样，person-picker 认 {name, studentId, reason}）
  //   items   → { key, label, score, max } 数组
  //   int/number / bool / textarea / text → 原始值
  //   photos  → this.data.photos（URL 数组，照片不放在 form 里）
  applyRecordToForm(rec) {
    const fields = (this.data.module && this.data.module.fields) || [];
    const details = rec.details || {};
    const form = { ...(this.data.form || {}) };
    for (const f of fields) {
      if (!f || f.derived) continue;
      if (isPhotoField(f)) continue; // 照片单独走 photos
      const v = details[f.key];
      if (v === undefined || v === null) continue;
      if (f.type === 'items') {
        form[f.key] = Array.isArray(v) ? v.map((it) => ({ key: it.key, label: it.label, score: it.score, max: it.max })) : [];
      } else if (f.type === 'students') {
        form[f.key] = Array.isArray(v) ? v : [];
      } else if (f.type === 'select') {
        // 单选用字符串（模板按 === 判定选中）；多选还原成数组
        if (SINGLE_SELECT_KEYS[f.key]) form[f.key] = Array.isArray(v) ? v[0] || '' : v;
        else form[f.key] = Array.isArray(v) ? v : v ? [v] : [];
      } else if (f.type === 'int' || f.type === 'number') {
        form[f.key] = Number(v);
      } else if (f.type === 'bool') {
        form[f.key] = !!v;
      } else {
        form[f.key] = String(v);
      }
    }
    // 已有照片：转成抽屉里的预览态（status:'done' + url，与上传完成后的结构一致）
    const photos = (rec.photos || []).map((url) => ({ url, path: url, status: 'done', progress: 100 }));
    // 记录里有多少张就显示多少张（不再按 9 张截断）
    this.setData({ form, photos }, () => this.afterFormChange(form));
  },

  // 查看该对象当日已有记录（抽屉里「该对象当日已有记录」提示条上的「查看」）
  viewRecord() {
    const id = this.data.existingId;
    if (!id) return;
    wx.navigateTo({ url: `/packageUnion/record/record?id=${id}` });
  },

  // 「本字段的名单该从哪来」：查宿 → 宿内；其余（含早八）→ **本班**。
  // 早八以前返回 'school'（全校名单），用户 2026-11-12 报这就是 BUG：
  // 录入是按班逐条录的，名单却给全校 → 既看不出在给谁录、也容易勾到别班的人。
  pickerScope() {
    const key = String(this.data.moduleKey || (this.data.module && this.data.module.key) || '');
    if (key === 'night_dorm') return 'dorm';
    return 'class';
  },

  // ===== 批量录入「无缺勤」（用户 2026-11-04「增加批量录入批量录入记录类型无缺勤这种的」）=====
  // 只支持「大家都到齐」这种最省事的场景：名单字段全部留空、评价用统一值、不带照片。
  // 提交**逐条复用现有 POST /api/union/records**（单条接口）—— 批量绝不另写一套校验 / 写入，
  // 与 services/union-review.js::reviewOne 的教训同源：批量自写判定就能绕过单条的护栏。

  toggleBatchMode() {
    this.setData({ batchMode: !this.data.batchMode, batchIds: {}, batchCount: 0 });
  },

  // 只有「还没有生效记录」的对象能批量录：未录 / 已取消 / 被退回（与 decorate.batchable 同口径）
  batchEligible(t) {
    return !!t && (!t.status || t.status === 'cancelled' || t.status === 'rejected');
  },

  toggleBatchTarget(target) {
    if (!this.batchEligible(target)) {
      wx.showToast({ title: '该对象已有生效记录，不能批量录入', icon: 'none' });
      return;
    }
    const ids = { ...this.data.batchIds };
    if (ids[target.targetId]) {
      delete ids[target.targetId];
    } else {
      if (this.data.batchCount >= this.data.batchLimit) {
        wx.showToast({ title: `一次最多批量录入 ${this.data.batchLimit} 条`, icon: 'none' });
        return;
      }
      ids[target.targetId] = true;
    }
    this.setData({ batchIds: ids, batchCount: Object.keys(ids).length });
  },

  // 全选「当前筛选结果」里的可录对象（带筛选的批量：只录某系部 / 某教学楼）
  selectBatchFiltered() {
    const ids = {};
    let n = 0;
    let capped = false;
    for (const t of this.data.filtered || []) {
      if (!this.batchEligible(t)) continue;
      if (n >= this.data.batchLimit) {
        capped = true;
        break;
      }
      ids[t.targetId] = true;
      n += 1;
    }
    this.setData({ batchIds: ids, batchCount: n });
    if (capped) wx.showToast({ title: `已达单次上限 ${this.data.batchLimit} 条`, icon: 'none' });
  },

  clearBatch() {
    this.setData({ batchIds: {}, batchCount: 0 });
  },

  onBatchSelect(e) {
    const key = e.currentTarget.dataset.key;
    const idx = Number(e.detail.value) || 0;
    const batchSelects = (this.data.batchSelects || []).map((s) =>
      s.key === key ? { ...s, value: s.options[idx] || s.value } : s
    );
    this.setData({ batchSelects });
  },

  // 批量 details：名单字段全部留空（= 无缺勤 / 无未归），select 字段用批量统一值，
  // 其余可填字段给中性空值 —— 与抽屉表单「什么都不填直接提交」的产物同形。
  buildBatchDetails() {
    const module = this.data.module || {};
    const selectMap = new Map((this.data.batchSelects || []).map((s) => [s.key, s]));
    const details = {};
    for (const f of module.fields || []) {
      if (!f || f.derived || isPhotoField(f)) continue;
      if (f.type === 'students') details[f.key] = [];
      else if (f.type === 'select') {
        const cfg = selectMap.get(f.key);
        details[f.key] = cfg && cfg.value ? [cfg.value] : [];
      } else if (f.type === 'int' || f.type === 'number') details[f.key] = null;
      else if (f.type === 'items') continue; // 计分项模块不在批量范围（canBatch 已挡），兜底不造值
      else details[f.key] = '';
    }
    return details;
  },

  async submitBatch() {
    if (this.data.batchSubmitting) return;
    const ids = Object.keys(this.data.batchIds).filter((k) => this.data.batchIds[k]);
    const list = ids
      .map((id) => (this.data.targets || []).find((t) => t.targetId === id))
      .filter((t) => t && this.batchEligible(t));
    if (!list.length) return;
    const module = this.data.module || {};
    const dateKey = (this.data.dates[this.data.dateIndex] || {}).key;
    const period = this.data.periods[this.data.periodIndex] || '';
    const selectLine = (this.data.batchSelects || [])
      .filter((s) => s.value)
      .map((s) => `${s.label}「${s.value}」`)
      .join('、');
    const confirmed = await new Promise((resolve) =>
      wx.showModal({
        title: '批量录入无缺勤',
        content: `将为 ${list.length} 个受检对象录入「无缺勤」记录${selectLine ? `，统一 ${selectLine}` : ''}，日期 ${dateKey}。确认提交？`,
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false),
      })
    );
    if (!confirmed) return;

    this.setData({ batchSubmitting: true });
    const details = this.buildBatchDetails();
    let okCount = 0;
    let dupCount = 0;
    const failLines = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      wx.showLoading({ title: `录入中 ${i + 1}/${list.length}`, mask: true });
      try {
        await auth.post('/api/union/records', {
          moduleKey: module.key,
          targetType: t.targetType,
          targetId: t.targetId,
          date: dateKey,
          period,
          details,
          photos: [],
        });
        okCount += 1;
      } catch (err) {
        if (err && err.code === 409001) dupCount += 1;
        else failLines.push(`${t.displayName || t.targetName}：${(err && err.message) || '提交失败'}`);
      }
    }
    wx.hideLoading();
    this.setData({ batchSubmitting: false, batchIds: {}, batchCount: 0 });
    await this.loadTargets();
    const lines = [`成功 ${okCount} 条`];
    if (dupCount) lines.push(`跳过（当天已录）${dupCount} 条`);
    if (failLines.length) lines.push(`失败 ${failLines.length} 条`);
    wx.showModal({
      title: '批量录入完成',
      content: lines.join('，') + (failLines.length ? `\n${failLines.slice(0, 3).join('\n')}` : ''),
      showCancel: false,
    });
  },

  buildInitialForm(target) {
    const form = {};
    for (const f of (this.data.module && this.data.module.fields) || []) {
      // 派生字段不建初值：它不是用户填的，表单里只展示只读结果（模板里走 derivedRows），
      // 建了初值反而会被下面的「required 校验」与 payload 组装当成可填字段。
      if (f.derived) continue;
      if (isPhotoField(f)) {
        // 照片不在 form 里存（form[f.key] 存的是 URL 数组），本地预览态与上传态统一放 this.data.photos
        form[f.key] = [];
      } else if (f.type === 'items') {
        const base = Array.isArray(f.default) ? f.default : [];
        form[f.key] = base.map((it) => ({ key: it.key, label: it.label, score: it.score, max: it.max }));
      } else if (f.type === 'students') {
        // 名单类字段：始终是数组（由 person-picker 维护），不要用字符串初值
        form[f.key] = [];
      } else if (f.default !== null && f.default !== undefined) {
        form[f.key] = f.default;
      } else if (SINGLE_SELECT_KEYS[f.key]) {
        // 「评价」类是**单选**：初值给空串（数组初值会让模板里的选中判定失效）
        form[f.key] = '';
      } else {
        form[f.key] = f.type === 'bool' ? false : '';
      }
    }
    // 应到 / 应住是 derived，不会在 buildInitialForm 里建初值（上面 continue 掉了）。
    // 但「自动计算」卡片要立刻显示正确人数，所以这里补一份**只用于预览**的已知数：
    // 提交 payload 会跳过 derived 字段，服务端仍以自己的注入值为准（不会被客户端改分母）。
    const fields = (this.data.module && this.data.module.fields) || [];
    const hasDerived = (key) => fields.some((f) => f && f.key === key && f.derived);
    if (target && hasDerived('shouldCount')) {
      const studentCount = Number(target.studentCount);
      if (studentCount > 0) form.shouldCount = studentCount;
    }
    if (target && hasDerived('shouldStay')) {
      // 查宿对象是 dorm_room：entryTargets 下发 residents（在住人数）；兼容班级台账的 dormCount
      const stayCount = Number(target.residents || target.dormCount);
      if (stayCount > 0) form.shouldStay = stayCount;
    }
    return form;
  },

  // ===== 「网课」分支（仅晚自习）=====
  // 真正的隐藏是**渲染层**做的（buildFields 剔除后续字段，wxml 按过滤后的 fields 渲染）；
  // 状态与提示文案统一由 afterFormChange 同步（**唯一入口**，避免两处各写一份提示文案）。
  //
  // 为什么表单值要**从参数传进来**：wx.setData 之后的 this.data.form 在回调里才更新，
  // 在回调外读 this.data.form 会拿到改之前的值（grade 明明选了「网课」却还按旧值渲染）。

  // 渲染 / 校验 / 提交用的字段列表（**三处共用同一份**，避免「界面隐藏了、提交却还带着」）：
  // 网课分支下 grade 之后的非照片字段一律剔除。
  buildFields(moduleKey, fields, form) {
    const list = fields || [];
    const current = form || this.data.form || {};
    if (!isOnlineDorm(moduleKey, current)) return list;
    const hidden = hiddenKeysInOnlineDorm(list);
    return list.filter((f) => f && !hidden[f.key]);
  },

  // 表单改值 → 重算 fields（网课隐藏）→ 重算派生行
  afterFormChange(form, extra) {
    const moduleKey = this.data.moduleKey || (this.data.module && this.data.module.key) || '';
    const current = form || this.data.form || {};
    const on = isOnlineDorm(moduleKey, current);
    const onlineTip = on ? '网课班级的学生在宿舍观看，班内无学生：无需填写缺勤名单与原因，实到按 0 记' : '';
    const patch = {
      ...(extra || {}),
      onlineDorm: on,
      onlineDormTip: onlineTip,
      fields: this.buildFields(moduleKey, (this.data.module && this.data.module.fields) || [], current),
    };
    this.setData(patch, () => this.applyDerived());
  },

  // 派生字段的只读「自动计算」：随表单变化实时重算（只做展示，不参与提交）
  // 第五轮口径：应到/应住来自对象人数，实到 = 应到 − 名单人数，缺勤/未归 = 名单人数。
  // 与服务端 services/check-modules.js::fillDerived 的新口径保持一致。
  applyDerived() {
    if (this._derivedTimer) {
      clearTimeout(this._derivedTimer);
      this._derivedTimer = null;
    }
    this._derivedTimer = setTimeout(() => {
      this._derivedTimer = null;
      const module = this.data.module || {};
      const fields = module.fields || [];
      const form = this.data.form || {};
      const online = isOnlineDorm(module.key, form);
      // 「网课」下被隐藏的字段不参与展示（否则会显示一个用已清空字段算出来的 0）
      const hidden = online ? hiddenKeysInOnlineDorm(fields) : {};
      const meta = ATTENDANCE_META[module.key] || null;
      const listLen = (k) => (Array.isArray(form[k]) ? form[k].length : 0);
      const shouldN = meta ? numOf(form[meta.shouldKey]) : 0;
      const absentN = meta ? listLen(meta.listKey) : 0;
      const actualN = meta && shouldN > 0 ? Math.max(0, shouldN - absentN) : null;
      const grade = selectedValues(form.grade)[0] || '';
      const rows = [];
      for (const f of fields) {
        if (!f || !f.derived || hidden[f.key]) continue;
        const key = f.key;
        let value = 0;
        let unit = '人';
        let detail = '由服务端推算';
        if (meta && key === meta.shouldKey) {
          value = shouldN > 0 ? shouldN : '—';
          detail = shouldN > 0 ? (key === 'shouldStay' ? '本房间在住人数' : '班级台账人数') : '台账缺少人数';
        } else if (meta && key === 'actualCount') {
          value = actualN === null ? '—' : actualN;
          detail = actualN === null ? '缺少应到人数' : `${shouldN} − ${meta.countLabel} ${absentN}`;
        } else if (meta && key === meta.countKey) {
          value = absentN;
          detail = `${meta.countLabel}名单 ${absentN} 人`;
        } else if (key === LATE_COUNT_KEY && module.key === 'morning_class') {
          const lateN = listLen(LATE_LIST_KEY);
          value = lateN;
          detail = `迟到名单 ${lateN} 人`;
        } else if (key === 'score' && module.key === 'hygiene') {
          unit = '分';
          value = grade && GRADE_SCORE[grade] !== undefined ? GRADE_SCORE[grade] : '—';
          detail = grade ? `评价 ${grade}` : '选择评价后自动折算';
        }
        rows.push({ key, label: f.label || key, value, unit, detail });
      }
      this.setData({ derivedRows: rows });
    }, 120);
  },

  /**
   * 抽屉关闭（遮罩 / 右上角 X / 「取消」三个入口都走这里）。
   *
   * 用户 2026-10-24 报障：「学生会录入记录拍照时，上传到 100% 弹窗被关掉了」。
   * 根因不是上传本身，而是**关闭入口一个守卫都没有**：closeForm 会把 photos、form、current
   * 整个清空，于是误触遮罩（拍照返回时系统层收起后容易穿透一次点击）、或手滑点到「取消」，
   * 刚传完的照片和填了一半的表单就全没了，而且没有任何提示 —— 看起来像「上传完自动关闭」。
   *
   * 三层拦截：
   *   ① 正在上传（uploading / 还有 pending）→ 直接拒绝关闭，先等传完，避免白传；
   *   ② 正在提交 → 拒绝关闭（提交后会自动关，中途关会看不出结果）；
   *   ③ 有未提交内容 → 二次确认；空表单直接关（不该为「什么都没填」还弹一次框）。
   * 提交成功 / 取消检查那两处是**程序化关闭**，走 doCloseForm()，不受这些拦截影响。
   */
  closeForm() {
    if (this.data.uploading || (this.data.photos || []).some((p) => p && (p.status === 'uploading' || p.status === 'pending'))) {
      wx.showToast({ title: '照片上传中，传完再关闭', icon: 'none' });
      return;
    }
    if (this.data.submitting) {
      wx.showToast({ title: '正在提交，请稍候', icon: 'none' });
      return;
    }
    if (!this.hasDraft()) {
      this.doCloseForm();
      return;
    }
    const that = this;
    wx.showModal({
      title: '放弃这次录入？',
      content: '表单还没提交，关闭后已填内容和已上传的照片都会丢失。',
      confirmText: '放弃',
      confirmColor: '#e5484d',
      cancelText: '继续填写',
      success: (r) => {
        if (r.confirm) that.doCloseForm();
      },
    });
  },

  // 是否有「还没提交的内容」：有照片，或任一字段填过值。
  // 只用于决定要不要弹二次确认，所以宁可判松一点（多问一次）也不要漏（静默丢数据）。
  hasDraft() {
    if ((this.data.photos || []).length) return true;
    if (this.data.existingId) return true; // 修改已有记录：中途关掉也算丢改动
    const form = this.data.form || {};
    return Object.keys(form).some((k) => {
      const v = form[k];
      if (v === undefined || v === null || v === '') return false;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === 'boolean') return v === true;
      return true;
    });
  },

  // 真正的关闭（程序化调用：提交成功、取消检查后）
  doCloseForm() {
    this.setData({
      showForm: false,
      bodyLocked: false,
      current: null,
      existingId: '',
      form: {},
      fields: [],
      derivedRows: [],
      photos: [],
      photosFailedCount: 0,
      onlineDorm: false,
      onlineDormTip: '',
      pickerQuery: {},
      pickerHint: '',
    });
  },

  // 提交后「接着录下一个」：把列表里**第一个未录对象**设为定位目标（高亮）。
  // 为什么需要它：录入是「连续作业」场景（一个班接一个班），原来录完一个要自己滚回去找下一个，
  // 这正是用户说的「操作很不便利」。这里返回是否还有下一个未录对象，供 submit 决定提示文案。
  locateNextMissing() {
    const list = this.data.filtered || [];
    const idx = list.findIndex((t) => !t.status || t.status === 'cancelled' || t.status === 'rejected');
    if (idx < 0) {
      this.setData({ locatingId: '' });
      return false;
    }
    const next = list[idx];
    this.setData({ locatingId: next.targetId }, () => {
      // 连续录入：提交后直接把下一个未录对象滚进视野（不是只高亮在屏幕外）
      // offsetTop 留出吸顶筛选区的高度，避免目标行被盖住（低版本不支持该参数时会自动忽略）
      wx.pageScrollTo({ selector: `#en-target-${idx}`, offsetTop: -140, duration: 220, fail: () => {} });
    });
    return true;
  },

  // ===== 表单输入 =====
  onNumInput(e) {
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value;
    // 应到 / 实到 / 请假 / 插班 这些数字一改，下面的「计算结果」跟着动（不提交，纯展示）
    const form = { ...this.data.form, [key]: value === '' ? '' : Number(value) };
    this.afterFormChange(form, { [`form.${key}`]: form[key] });
  },

  // 名单类字段（缺勤 / 未归 / 迟到）：由 person-picker 搜索勾选，不接受手输
  onPersonsChange(e) {
    const field = e.currentTarget.dataset.field;
    if (!field) return;
    const selected = e.detail.selected || [];
    const form = { ...this.data.form, [field]: selected };
    this.afterFormChange(form, { [`form.${field}`]: selected });
  },

  onTextInput(e) {
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value;
    this.setData({ [`form.${key}`]: value });
  },

  // 评价类（key='grade'）单选：点一次直接落值（可取消回到未选）
  onSingleSelectTap(e) {
    const key = e.currentTarget.dataset.key;
    const option = e.currentTarget.dataset.option;
    const value = this.data.form[key] === option ? '' : option;
    const form = { ...this.data.form, [key]: value };
    // 切到 / 切离「网课」会改变后续字段的渲染分支，所以必须走 afterFormChange 重算 fields
    this.afterFormChange(form, { [`form.${key}`]: value });
  },

  onSelectTap(e) {
    const key = e.currentTarget.dataset.key;
    const option = e.currentTarget.dataset.option;
    const current = this.data.form[key];
    const arr = Array.isArray(current) ? current.slice() : [];
    const idx = arr.indexOf(option);
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push(option);
    const form = { ...this.data.form, [key]: arr };
    this.afterFormChange(form, { [`form.${key}`]: arr });
  },

  onItemScore(e) {
    const key = e.currentTarget.dataset.key;
    const index = Number(e.currentTarget.dataset.index);
    const value = Number(e.detail.value) || 0;
    const list = (this.data.form[key] || []).slice();
    if (!list[index]) return;
    list[index] = { ...list[index], score: Math.max(0, Math.min(list[index].max || 0, value)) };
    this.setData({ [`form.${key}`]: list }, () => this.syncItemScore(key));
  },

  // 检查项合计自动写进「总评得分」（用户仍可手改）
  // ⚠️ 换算目标必须是**得分字段的满分**（服务端 fields 下发，10 分制下是 10），
  //    以前这里硬编码 ×100 —— 换刻度后漏改就会出现「检查项合计 8/10、总评得分 80」，
  //    提交时被服务端按 max=10 夹成 10 分，用户看到的和存进去的完全两回事。
  syncItemScore(key) {
    const list = this.data.form[key] || [];
    if (!list.length) return;
    const total = list.reduce((a, b) => a + (Number(b.score) || 0), 0);
    const max = list.reduce((a, b) => a + (Number(b.max) || 0), 0);
    if (max <= 0 || this.data.form.score === undefined) return;
    const scoreField = ((this.data.module && this.data.module.fields) || []).find((f) => f && f.key === 'score') || {};
    const fullScore = Number(scoreField.max) > 0 ? Number(scoreField.max) : FULL_SCORE_FALLBACK;
    this.setData({ 'form.score': Math.round((total / max) * fullScore * 100) / 100 });
  },

  // ===== 留证照片（type='photo'）=====
  //
  // 链路：wx.chooseMedia（拍照 / 相册，compressed）→ **逐张**上传 /api/upload/check-photo
  //       → 每张成功即把 url 收进 this.data.photos → 提交时统一把 URL 数组写进 form[照片字段]
  //
  // 三个刻意的设计（改动前先读）：
  //   ① **逐张上传而不是 Promise.all**：现场网络差时并发上传会互相抢带宽、整体都变慢；
  //      逐张还能让每张独立显示进度与失败原因。
  //   ② **单张失败不丢整组**：失败的只标记 status='failed' 并保留本地临时图，用户点一次就只重传这一张。
  //      用 Promise.all 的话一个失败整组回滚，用户得重新拍 9 张。
  //   ③ **本地图与远程 URL 分开存**：pending/uploading/failed 的项只有本地 path，提交时这些一律不算数
  //      （否则会把本地临时路径当 URL 发到服务端，记录里就存了一串 wxfile:// 死链）。
  onChoosePhoto(e) {
    const field = (e && e.currentTarget && e.currentTarget.dataset.field) || this.photoFieldKey();
    if (this.data.uploading) return;
    const that = this;
    wx.chooseMedia({
      // 平台单次上限 9 张；不限制总张数，用户可以反复添加（服务端也已不限张数）
      count: PHOTO_PICK_COUNT,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      // 原图直传：解除所有上传限制后不再压画质（用户 2026-11-12）
      sizeType: ['original'],
      success(res) {
        const files = (res && res.tempFiles) || [];
        if (!files.length) return;
        const added = files.map((f) => ({
          path: f.tempFilePath,
          size: f.size || 0,
          url: '',
          status: 'pending',
          progress: 0,
          error: '',
        }));
        that.setPhotos(that.data.photos.concat(added));
        that.uploadPending(field);
      },
      fail(err) {
        // ⚠️ 以前这里静默吞掉所有失败（注释写「用户取消不是错误」），
        //   结果「图库选不了图」时页面毫无反应，用户以为功能坏了（用户 2026-10-26）。
        //   现在区分「用户主动取消」与「真的失败了」。
        const msg = String((err && err.errMsg) || '');
        if (/cancel/i.test(msg)) return; // 取消：不提示
        wx.showToast({ title: '选择图片失败，请重试', icon: 'none' });
      },
    });
  },

  // 逐张上传所有还没上传成功的照片（含 pending 与 failed —— 失败重试复用同一条路径）
  async uploadPending(field) {
    if (this.data.uploading) return;
    const fieldKey = field || this.photoFieldKey();
    this.setData({ uploading: true });
    try {
      // 用 while 而不是 forEach：photos 在过程中会被 setData 替换，索引必须每次重新取
      for (let i = 0; i < this.data.photos.length; i += 1) {
        const item = this.data.photos[i];
        if (!item || item.status === 'done' || item.status === 'uploading') continue;
        await this.uploadOne(i, fieldKey);
      }
    } finally {
      this.setData({ uploading: false });
    }
    this.syncPhotoForm(fieldKey);
  },

  // 单张上传：进度写回该张，失败只标记这一张
  async uploadOne(index, fieldKey) {
    const item = this.data.photos[index];
    if (!item || !item.path) return;
    this.patchPhoto(index, { status: 'uploading', progress: 0, error: '' });
    try {
      // 原图直传（用户 2026-11-12「解除所有上传照片的限制」）：
      // 服务端与 nginx 都已取消体积上限，不再为了「压到上限内」损失画质。
      // 逐张上传、进度与失败原因仍按单张显示。
      const data = await auth.uploadCheckPhoto(item.path, {
        onProgress: (percent) => this.patchPhoto(index, { progress: Number(percent) || 0 }),
      });
      this.patchPhoto(index, { status: 'done', progress: 100, url: (data && data.url) || '' });
    } catch (err) {
      // 把**真实原因**显示出来（用户 2026-10-26「检查录入上传照片依旧失败」，
      // 但界面上只有一句「上传失败」，无法判断是 403 / 超时 / 域名白名单）。
      const code = err && err.code;
      // 身份 / 登录问题压缩也没用，不重试；其它失败先尝试「压缩后重传一次」——
      // 服务端已不限制体积，但小程序 uploadFile 通道对超大原图仍可能直接 fail。
      if (code !== 401 && code !== 403002) {
        const retried = await this.retryWithCompressed(item, index);
        if (retried) return;
      }
      let msg = (err && err.message) || '上传失败';
      if (code === 403002) msg = '上传被拒：你还不是学生会成员（请确认已在成员名单中）';
      else if (code === 401) msg = '登录已过期，请重新登录后再传';
      // 服务端 / 网络层有可读 message 就原样展示（含超时、网关 413 等真实原因）
      this.patchPhoto(index, { status: 'failed', error: msg });
    }
  },

  // 失败兜底：把原图压缩到平台更容易接收的体积后重传**一次**。
  // 只在 uploadOne 的 catch 里调用（原图优先），成功返回 true。
  async retryWithCompressed(item, index) {
    if (!wx.compressImage || !item || !item.path) return false;
    // 小于 2MB 的图压缩也不会改变「上传通道拒绝」的结论，省一次等待
    if (item.size && item.size < 2 * 1024 * 1024) return false;
    let small = '';
    for (const quality of [80, 60]) {
      small = await this.tryCompress(item.path, quality);
      if (small && small !== item.path) break;
    }
    if (!small || small === item.path) return false;
    try {
      const data = await auth.uploadCheckPhoto(small, {
        onProgress: (percent) => this.patchPhoto(index, { progress: Number(percent) || 0 }),
      });
      this.patchPhoto(index, { status: 'done', progress: 100, url: (data && data.url) || '' });
      return true;
    } catch (e) {
      return false;
    }
  },

  // 单次压缩（只给失败兜底用）：quality 越高越清晰、体积越大
  tryCompress(src, quality) {
    return new Promise((resolve) => {
      wx.compressImage({
        src,
        quality,
        compressedWidth: PHOTO_RETRY_EDGE,
        success: (r) => resolve((r && r.tempFilePath) || ''),
        fail: () => resolve(''),
      });
    });
  },

  // 只改某一张（避免整组 setData 导致所有缩略图重渲染 / 进度条闪烁）
  patchPhoto(index, patch) {
    const list = (this.data.photos || []).slice();
    if (!list[index]) return;
    list[index] = { ...list[index], ...patch };
    this.setPhotos(list);
  },

  // 照片列表的统一写入口：photos 与「失败张数」一起更新
  // （failedCount 在 WXML 里没法对数组做过滤统计，所以在这里维护成一个标量）
  setPhotos(list) {
    const photos = list || [];
    this.setData({
      photos,
      photosFailedCount: photos.filter((p) => p && p.status === 'failed').length,
    });
  },

  // 单张失败 → 重试这一张（其余已成功的原样保留）
  retryPhoto(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = (this.data.photos || [])[index];
    if (!item) return;
    this.uploadOne(index, this.photoFieldKey()).then(() => this.syncPhotoForm(this.photoFieldKey()));
  },

  // 删除某一张（张数不限后仍然需要：传错 / 重拍要能撤掉）
  removePhoto(e) {
    const index = Number(e.currentTarget.dataset.index);
    const list = (this.data.photos || []).slice();
    if (index < 0 || index >= list.length) return;
    list.splice(index, 1);
    const key = this.photoFieldKey();
    this.setPhotos(list);
    this.syncPhotoForm(key);
  },

  previewPhoto(e) {
    const index = Number(e.currentTarget.dataset.index);
    const list = this.data.photos || [];
    if (!list.length) return;
    // 预览用本地图优先（未上传也能看），远程 URL 作兜底
    const urls = list.map((p) => p.path || p.url).filter(Boolean);
    const current = (list[index] && (list[index].path || list[index].url)) || urls[0];
    if (!urls.length) return;
    wx.previewImage({ urls, current });
  },

  // 把「已上传成功」的 URL 数组写进 form[照片字段]（提交体就从这里取）
  syncPhotoForm(fieldKey) {
    const key = fieldKey || this.photoFieldKey();
    if (!key) return;
    const urls = (this.data.photos || []).filter((p) => p.status === 'done' && p.url).map((p) => p.url);
    this.setData({ [`form.${key}`]: urls });
  },

  // 当前模块里照片字段的 key（约定是 'photos'；按 type='photo' 找，找不到再按 key 兜底）
  photoFieldKey() {
    const fields = (this.data.module && this.data.module.fields) || [];
    const byType = fields.find((f) => isPhotoField(f) && String(f.type || '') !== '');
    if (byType) return byType.key;
    const byKey = fields.find((f) => f && f.key === 'photos');
    return byKey ? byKey.key : '';
  },

  // 提交前的照片自检：
  //   ① 还有未传完的 → 拦住（否则会漏图）
  //   ② 有失败的 → 让用户选「继续提交（丢掉失败的这几张）」还是回去重试
  async resolvePhotosBeforeSubmit() {
    const list = this.data.photos || [];
    if (!list.length) return true;
    if (list.some((p) => p.status === 'uploading' || p.status === 'pending')) {
      wx.showToast({ title: '照片还在上传，请稍候', icon: 'none' });
      return false;
    }
    const failed = list.filter((p) => p.status === 'failed');
    if (!failed.length) return true;
    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: '有照片没传上去',
        content: `${failed.length} 张照片上传失败，是否丢弃这 ${failed.length} 张并继续提交？`,
        confirmText: '继续提交',
        cancelText: '回去重试',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      })
    );
    if (!ok) return false;
    // 用户选择丢弃：把这些失败项从列表里摘掉，form 里只剩已成功的
    const kept = list.filter((p) => p.status !== 'failed');
    this.setPhotos(kept);
    this.syncPhotoForm(this.photoFieldKey());
    return true;
  },

  // ===== 提交 =====
  async submit() {
    if (this.data.submitting) return;
    const { module, form, dates, dateIndex, periods, periodIndex, current, existingId } = this.data;
    if (!current) {
      wx.showToast({ title: '请先选择受检对象', icon: 'none' });
      return;
    }
    // 照片先定稿（还在传 / 传失败都要先处理），再走字段校验
    if (!(await this.resolvePhotosBeforeSubmit())) return;

    // 网课分支：后续字段隐藏了，提交体也必须同口径**清空**，
    // 否则界面没填、提交却带着上一轮的值（服务端也会清空，两边不一致会出现「记录里有数、界面没填」）。
    const online = isOnlineDorm(module.key, form);
    const hidden = online ? hiddenKeysInOnlineDorm(module.fields || []) : {};
    // 渲染 / 校验 / 提交三处共用同一份字段列表
    const activeFields = this.buildFields(module.key, module.fields || [], form);

    // 必填校验（与服务端同一份 fields 定义，只是按网课分支收窄）
    // 派生字段跳过：它不由用户填（模板里也没渲染成输入框），服务端会自己推算
    for (const f of activeFields) {
      if (f.derived || !f.required) continue;
      if (f.type === 'students') continue;
      if (isPhotoField(f)) continue; // 照片选填（用户已确认）
      const v = form[f.key];
      if (v === '' || v === null || v === undefined) {
        wx.showToast({ title: `请填写「${f.label || f.key}」`, icon: 'none' });
        return;
      }
    }

    const details = {};
    for (const f of module.fields || []) {
      // 派生字段不进 payload：服务端以自己推算的值为准（这里再挡一道，避免以后又被人加回来）
      if (f.derived) continue;
      const v = form[f.key];
      if (isPhotoField(f)) {
        // 照片是**顶层**字段（check_records.photos），不进 details：
        // 服务端 routes/union.js 读的是 body.photos，放进 details 会被 normalizeDetails 丢弃
        continue;
      }
      if (hidden[f.key]) {
        // 网课分支下被隐藏的字段：显式发空值把服务端可能残留的旧值覆盖掉
        if (f.type === 'students') details[f.key] = [];
        else if (f.type === 'int' || f.type === 'number') details[f.key] = null;
        else details[f.key] = '';
        continue;
      }
      if (f.type === 'int' || f.type === 'number') {
        if (v !== '' && v !== null && v !== undefined) details[f.key] = Number(v);
      } else if (f.type === 'items') {
        details[f.key] = (v || []).map((it) => ({ key: it.key, label: it.label, score: Number(it.score) || 0, max: it.max }));
      } else if (f.type === 'select') {
        // 评价类是单选：统一按数组口径发送（服务端 select 收数组）
        details[f.key] = Array.isArray(v) ? v : v ? [v] : [];
      } else if (f.type === 'students') {
        // 名单由选人组件维护（数组）；提交前统一裁剪为服务端要的形状
        details[f.key] = (Array.isArray(v) ? v : []).map((s) => ({
          userId: s.userId || '',
          name: s.name || '',
          studentId: s.studentId || '',
          roomNo: s.roomNo || '',
          reason: s.reason || '',
        }));
      } else if (f.type === 'bool') {
        details[f.key] = !!v;
      } else if (v !== '' && v !== null && v !== undefined) {
        details[f.key] = String(v);
      }
    }

    const payload = {
      moduleKey: module.key,
      targetType: current.targetType,
      targetId: current.targetId,
      date: (dates[dateIndex] || {}).key,
      period: periods[periodIndex] || '',
      details,
      // 留证照片在**顶层**（check_records.photos）：只发送已上传成功、拿到 URL 的那些；
      // 张数不限（用户 2026-11-12），服务端也不再裁剪。
      photos: (this.data.photos || [])
        .filter((p) => p.status === 'done' && p.url)
        .map((p) => p.url),
    };
    // 申诉改判：带 settleAppeal 提交时，服务端在**同一条 revision** 里
    // 既写「改了什么」也写「申诉成立」，并把记录落成「已复核」。
    // （申诉成立必须更正内容，不能只改状态 —— 见 routes/union.js::appeal/review 的注释）
    if (this.data.appealReview && existingId) {
      payload.settleAppeal = true;
      if (this.data.appealResult) payload.appealResult = this.data.appealResult;
    }

    this.setData({ submitting: true });
    try {
      let res = null;
      if (existingId) {
        res = await auth.put(`/api/union/records/${existingId}`, payload);
      } else {
        res = await auth.post('/api/union/records', payload);
      }
      // 成功提示带上服务端推算结果（如「提交成功 · 缺勤 2 人」）；接口没返回就只说成功
      const extra = derivedToast(details, res);
      wx.showToast({
        title: (existingId ? '已更新' : '提交成功') + (extra ? ` · ${extra}` : ''),
        icon: extra ? 'none' : 'success',
      });
      this.doCloseForm();
      await this.loadTargets();
      // 提交成功后**自动定位下一个未录对象**（连续录入场景）：有则高亮提示，无则告知本模块已录完
      const hasNext = this.locateNextMissing();
      if (!hasNext) {
        // 有院校 / 系部 / 年级筛选或搜索时，列表只是模块的一个子集，不能说「本模块已全部录入」
        const scoped = !!(this.data.keyword || this.data.schoolFilter || this.data.departmentFilter || this.data.gradeFilter);
        wx.showToast({ title: scoped ? '当前筛选已全部录入' : '本模块今日已全部录入', icon: 'none' });
      }
    } catch (e) {
      if (e.code === 409001 && e.existingId) {
        const res = await new Promise((resolve) =>
          wx.showModal({
            title: '当天已有记录',
            content: '该对象当天已录入过，是否改为修改那条记录？',
            confirmText: '去修改',
            success: (r) => resolve(r.confirm),
            fail: () => resolve(false),
          })
        );
        if (res) this.setData({ existingId: e.existingId });
      } else {
        wx.showToast({ title: e.message || '提交失败', icon: 'none' });
      }
    } finally {
      this.setData({ submitting: false });
    }
  },

  // 取消本次检查（早操 / 早八临时取消等）
  async cancelRecord() {
    const id = this.data.existingId;
    if (!id) return;
    const that = this;
    wx.showModal({
      title: '取消这次检查',
      editable: true,
      placeholderText: '请填写取消原因（如：下雨取消）',
      success: async (r) => {
        if (!r.confirm) return;
        const reason = (r.content || '').trim();
        if (reason.length < 2) {
          wx.showToast({ title: '请填写取消原因', icon: 'none' });
          return;
        }
        try {
          await auth.post(`/api/union/records/${id}/cancel`, { reason });
          wx.showToast({ title: '已取消', icon: 'success' });
          // 取消成功后是程序化关闭：走 doCloseForm，不能被「未提交内容」二次确认拦住
          that.doCloseForm();
          await that.loadTargets();
        } catch (e) {
          wx.showToast({ title: e.message || '操作失败', icon: 'none' });
        }
      },
    });
  },

  viewRecord() {
    const id = this.data.existingId;
    if (!id) return;
    wx.navigateTo({ url: `/packageUnion/record/record?id=${id}` });
  },
});
