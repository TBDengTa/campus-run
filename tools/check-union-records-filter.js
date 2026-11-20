// 检查记录列表页的**筛选条按身份裁剪**（node tools/check-union-records-filter.js）
//
// 用户报障：「检查申诉记录不应该是这样啊，上面不应该与学生会中的仅我的和待复核一样啊」
// 场景：班主任 / 班委从「班超」页的「全部 ›」进来（非学生会成员、只看本班），
//   却看到学生会专属的两个高频筛选：
//     · 仅我的   = 我提交的记录 → 班主任/班委从不提交 → 恒为空
//     · 待复核   = 等我复核     → 班主任/班委没有复核权 → 恒为空
//   两个按钮点下去永远是空列表，属于「假筛选」。
// 期望：非成员改看「申诉中」（本班哪些记录在申诉流程里，接口既有参数 pendingAppeal=1）。
const path = require('path');
const fs = require('fs');

const MINI = path.join(__dirname, '..', 'miniprogram');
const SERVER = path.join(__dirname, '..', 'server');
let page = null;
let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` -> ${detail}`}`);
  if (!cond) failed += 1;
};

global.Page = (cfg) => {
  page = cfg;
};
global.getApp = () => ({ requireLogin: () => true, ensureLogin: async () => {} });
let lastPreview = null;
global.wx = {
  showToast() {},
  setNavigationBarTitle() {},
  stopPullDownRefresh() {},
  navigateTo() {},
  previewImage(o) {
    lastPreview = o;
  },
  getStorageSync: () => '',
  setStorageSync() {},
  removeStorageSync() {},
};

let MINE = {};
// 非空列表桩：验证「卡片缺勤人 + 照片」的预计算（用户 2026-11-19）。
// 三种 roster 形态都要覆盖：
//   ① 正常（有姓名 + 折叠）② 名单空但计数 >0（老记录）③ 无权限（姓名被服务端按权限置空）
const LIST_STUB = {
  total: 3,
  hasMore: false,
  facets: {
    classes: [{ className: '26级大数据技术', count: 2, schoolName: '北校区', departmentName: '计财系' }],
    schools: [{ school: '北校区', count: 2 }],
    departments: [{ department: '计财系', count: 2 }],
    buildings: [{ building: '洋河-男宿', count: 1 }],
  },
  list: [
    {
      id: 'r1',
      moduleKey: 'study_evening',
      moduleName: '晚自习',
      date: '2026-11-18',
      targetName: '26级大数据技术',
      className: '26级大数据技术',
      inspectorName: '张三',
      deduct: 0.7,
      status: 'submitted',
      photos: ['https://a/1.jpg', 'https://a/2.jpg', 'https://a/3.jpg'],
      photoCount: 5,
      photosBlurred: false,
      photoNote: '',
      roster: { field: 'absentList', label: '缺勤', names: ['李四', '王五', '赵六'], count: 8, more: 5, hidden: false },
    },
    {
      id: 'r2',
      moduleKey: 'night_dorm',
      moduleName: '查宿',
      date: '2026-11-18',
      targetName: '洋河-男宿 406',
      className: '26级大数据技术',
      inspectorName: '张三',
      deduct: 0.2,
      status: 'approved',
      photos: [],
      photoCount: 2,
      photosBlurred: true,
      photoNote: '宿舍照片仅检查人 / 主席团 / 所属部门部长 / 教师可见',
      roster: { field: 'absentList', label: '未归', names: [], count: 3, more: 0, hidden: false },
    },
    {
      id: 'r3',
      moduleKey: 'night_dorm',
      moduleName: '查宿',
      date: '2026-11-17',
      targetName: '洋河-男宿 407',
      className: '26级大数据技术',
      inspectorName: '张三',
      deduct: 0,
      status: 'approved',
      photos: [],
      photoCount: 0,
      photosBlurred: false,
      photoNote: '',
      roster: { field: 'absentList', label: '未归', names: [], count: 5, more: 0, hidden: true },
    },
  ],
};
let listStub = { total: 0, hasMore: false, list: [] };
const queries = [];
const auth = require(path.join(MINI, 'utils', 'request'));
auth.get = async (url, params) => {
  if (url === '/api/union/mine') return MINE;
  if (url === '/api/union/records') {
    queries.push(params || {});
    // 有 facets 才回非空列表：先跑通既有身份用例（它们用空列表），再换非空桩验证卡片
    return listStub;
  }
  throw new Error('未预期请求: ' + url);
};

require(path.join(MINI, 'packageUnion', 'records', 'records.js'));

function makeInstance(options = {}) {
  const inst = Object.assign({}, page);
  inst.data = JSON.parse(JSON.stringify(page.data));
  inst.setData = function setData(patch, cb) {
    Object.assign(this.data, patch);
    if (cb) cb();
  };
  inst.onLoad(options);
  return inst;
}

const wxml = fs.readFileSync(path.join(MINI, 'packageUnion/records/records.wxml'), 'utf8');
const jsSrc = fs.readFileSync(path.join(MINI, 'packageUnion/records/records.js'), 'utf8');

(async () => {
  // ① 学生会成员 + 可复核：两个学生会专属筛选都在
  MINE = { isMember: true, canReview: true, modules: [{ key: 'hygiene', shortName: '卫生' }, { key: 'study_evening', shortName: '晚自习' }] };
  let inst = makeInstance({});
  await inst.load(true);
  ok('成员：isMember=true', inst.data.isMember === true);
  ok('成员：canReview=true', inst.data.canReview === true);
  ok('成员：classView=false', inst.data.classView === false);
  ok('成员：模块筛选有内容', inst.data.modules.length > 1, JSON.stringify(inst.data.modules));

  // ② 班主任 / 班委：两个专属筛选清掉、改给「申诉中」
  //    注意 /api/union/mine 对**所有人**都下发模块清单（非成员 canEnter=false）→ 模块筛选要保留
  MINE = { isMember: false, canReview: false, modules: [{ key: 'hygiene', shortName: '卫生' }, { key: 'study_evening', shortName: '晚自习' }] };
  inst = makeInstance({ className: encodeURIComponent('56级冒烟1班'), mine: '1' });
  await inst.load(true);
  ok('非成员：isMember=false', inst.data.isMember === false);
  ok('非成员：canReview=false', inst.data.canReview === false);
  ok('非成员：classView=true', inst.data.classView === true, String(inst.data.classView));
  ok('非成员：「仅我的」被清掉（否则恒为空列表）', inst.data.mine === false, String(inst.data.mine));
  ok('非成员：模块筛选保留（这个筛选对他们有用）', inst.data.modules.length > 1, JSON.stringify(inst.data.modules));

  // ③ 模板渲染条件
  ok('「仅我的」只在 isMember 时渲染', /wx:if="\{\{isMember\}\}"[^>]*bind:tap="toggleMine"[^>]*>仅我的/.test(wxml));
  ok('「待复核」只在 canReview 时渲染', /wx:if="\{\{canReview\}\}"[^>]*bind:tap="togglePending"[^>]*>待复核/.test(wxml));
  ok('「申诉中」在班本视角 / 无复核权 / 已启用时渲染', /wx:if="\{\{classView \|\| !canReview \|\| pendingAppeal\}\}"[^>]*bind:tap="toggleAppeal"[^>]*>申诉中/.test(wxml));
  ok('模块选择器不按 isMember 隐藏', /wx:if="\{\{modules\.length > 1\}\}"/.test(wxml));
  ok('有 toggleAppeal 处理函数', /toggleAppeal\(\) \{/.test(jsSrc));

  // ④ 「申诉中」沿用接口既有参数，不发明新契约
  queries.length = 0;
  inst.toggleAppeal();
  await new Promise((r) => setTimeout(r, 10));
  ok('请求带 pendingAppeal=1', queries.some((q) => q.pendingAppeal === 1), JSON.stringify(queries));
  ok('className 透传（范围由服务端按身份收敛）', queries.some((q) => q.className === '56级冒烟1班'), JSON.stringify(queries));

  // ⑤ 重置能一次清干净（否则用户会卡在一个看不见的筛选里）
  inst.resetFilters();
  await new Promise((r) => setTimeout(r, 10));
  ok('reset 后 pendingAppeal=false', inst.data.pendingAppeal === false);
  ok('reset 后 mine=false', inst.data.mine === false);

  // ====================================================================
  // ⑥ 本次新增：检查记录筛选（用户 2026-11-19「有学生会总管的权限查看检查记录没有办法
  //    筛选与查看所有记录，增加筛选如班级、系部、院校、楼栋等全面的筛选搜索功能」）
  // ====================================================================
  console.log('\n[6] 组织维度筛选（院校/系部/楼栋/班级）+ 关键词');
  MINE = { isMember: true, canReview: true, modules: [{ key: 'hygiene', shortName: '卫生' }] };
  listStub = { total: 0, hasMore: false, list: [] };
  const wxmlSrc = fs.readFileSync(path.join(MINI, 'packageUnion/records/records.wxml'), 'utf8');
  const jsSrcNow = fs.readFileSync(path.join(MINI, 'packageUnion/records/records.js'), 'utf8');
  const serverRoute = fs.readFileSync(path.join(SERVER, 'src/routes/union.js'), 'utf8');
  const bandChao = fs.readFileSync(path.join(SERVER, 'src/services/band-chao.js'), 'utf8');

  // 服务端：四个新筛选维度都必须真的进查询条件（不是「能选但没反应」）
  ok('服务端解析院校/系部 → classNames', /resolveRecordClassNames\(\{ school: req\.query\.school, department: req\.query\.department \}\)/.test(serverRoute));
  ok('服务端解析楼栋 → targetIds', /resolveRecordTargetIds\(req\.query\.building\)/.test(serverRoute));
  ok('服务端下发筛选候选 facets', /facets\s*=\s*page === 1 \? await bandChao\.recordFacets\(/.test(serverRoute));
  ok('facets 只按身份范围统计（不叠加已选项，选项不会自我消失）', /recordFacets\(scope, \{\s*from: req\.query\.from, to: req\.query\.to\s*\}\)/.test(serverRoute));
  // ===== 学生会总管必须能看**全校**记录（用户 2026-11-19「有学生会总管的权限查看检查记录
  //   没有办法筛选与查看所有记录」的根因）=====
  // 旧实现 isSteward 只判 perms.includes('union.steward')，而超管组的有效权限是 ['*']，
  // 于是「有全部权限」的账号反而落到「非成员 → 只限本班」，全校记录只能看到自己班的几条。
  // 断言取向：看 isSteward 有没有走通配判定（hasWildcard 是本文件里 `'*'` 的单点实现）。
  // 不匹配具体排版 —— 中间加一行注释就假红的脆断言，本仓库已经吃过大亏。
  const stewardBody = (serverRoute.match(/async function isSteward\(req\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('总管判定识别 `*` 通配（超管全权限也算总管）',
    /hasWildcard\(perms\)/.test(stewardBody) &&
      /function hasWildcard\(perms\) \{[\s\S]{0,120}includes\('\*'\)/.test(serverRoute) &&
      /union\.steward/.test(stewardBody),
    stewardBody.slice(0, 220));
  ok('总管在列表里拿到全校范围（scope={}）', /else if \(await isRecordSteward\(req, identity\)\) \{\s*\n\s*scope = \{\};/.test(serverRoute));
  ok('总管可进复审台（不再先被 assertMember 拦掉）',
    /const steward = await isRecordSteward\(req, identity\);[\s\S]{0,120}if \(!steward\) assertMember\(identity\)/.test(serverRoute));
  ok('总管可看班里检查全景（/class/:className 放行）',
    /const isClassSteward = await isRecordSteward\(req, identity\);[\s\S]{0,120}!isClassSteward\) throw/.test(serverRoute),
    (serverRoute.match(/const isClassSteward[^\n]*/) || ['未放行'])[0]);
  // 关键：筛选与身份范围**求交集**，而不是被覆盖（旧写法 Object.assign(filter, scope) 会把筛选吃掉）
  ok('院校/系部/班级条件与 scope 求交集（不是覆盖）', /intersectClassCond\(/.test(bandChao) && /const classConds = \[query\.className, query\.classNames, scope && scope\.className\]/.test(bandChao));
  ok('交集为空时返回 $in: []（fail-closed → 0 条，不越权）', /\$in: \[\.\.\.new Set\(out\)\]/.test(bandChao));
  ok('楼栋筛选按 targetId（不靠 targetName 前缀，存量有脏数据）', /if \(Array\.isArray\(query\.targetIds\)\) filter\.targetId = \{ \$in: query\.targetIds\.map\(String\) \}/.test(bandChao));
  // 关键词正则转义：直接看源码那一行（在测试里再转义一次极易写错，所以用「包含」判断，
  // 只要那支转义字符类与替换串同时出现就算通过）。
  const kwSeg = bandChao.slice(bandChao.indexOf('if (query.keyword)'), bandChao.indexOf('// scope 的其余维度'));
  ok(
    '关键词转义正则元字符',
    /new RegExp\(q\.replace\(/.test(kwSeg) && kwSeg.includes('.*+?^${}()|[\\]\\\\]') && kwSeg.includes("'\\\\$&'"),
    kwSeg.slice(0, 200)
  );
  ok('关键词只搜班级/受检对象/检查人（不搜学生姓名）', /filter\.\$and = \[\{ \$or: \[\{ className: re \}, \{ targetName: re \}, \{ inspectorName: re \}\] \}\]/.test(bandChao));

  // ===== 卡片缺勤人的姓名可见性（用户 2026-11-19；与「照片裁剪」同级的隐私边界）=====
  // GET /records 对普通学生也开放本班，所以不能把整班缺勤名单无差别铺到列表页。
  ok('名单姓名按视角放行（唯一闸门 canSeeRosterNames）',
    /function canSeeRosterNames\(req, viewer, record\)/.test(serverRoute) && /if \(canSeeRosterNames\(req, viewer, record\)\) return roster;/.test(serverRoute));
  ok('学生会成员可见姓名', /if \(identity && identity\.isMember\) return true;/.test(serverRoute));
  ok('检查人本人可见自己录的名单', /record\.inspectorOpenid === me\) return true/.test(serverRoute));
  ok('本班班主任 / 班委可见', /homeroomClasses \|\| \[\]\)\.includes\(cls\)/.test(serverRoute) && /isClassOfficer === true && req\.user\.className === cls/.test(serverRoute));
  ok('总管可见（否则出现「能看全校记录、卡片却显示名单仅管理端可见」的自相矛盾）',
    /if \(viewer && viewer\.isSteward\) return true;/.test(serverRoute));
  ok('无权限时保留人数、只清姓名（不能让卡片变成空白）',
    /return \{ \.\.\.roster, names: \[\], more: 0, hidden: true \}/.test(serverRoute));
  ok('缺勤名单不进 details 全量下发（列表仍 withDetails:false）',
    /presentRecord\(r, \{ withDetails: false, viewer, photoLimit: 3 \}\)/.test(serverRoute));

  // 前端：四个 picker + 关键词 + 更多筛选入口
  ok('WXML 有院校/系部/楼栋/班级四个 picker', (wxmlSrc.match(/data-key="(school|department|building|className)"/g) || []).length === 4);
  ok('WXML 有关键词搜索框', /bindinput="onKeyword"/.test(wxmlSrc) && /onClearKeyword/.test(wxmlSrc));
  ok('WXML 有「更多筛选」入口（带生效角标）', /toggleMore/.test(wxmlSrc) && /moreCount/.test(wxmlSrc));
  ok('前端把四个新维度都传进接口', ['school', 'department', 'building', 'keyword'].every((k) => new RegExp(`\\b${k}: this\\.data\\.${k}`).test(jsSrcNow)));
  ok('前端搜索防抖 300ms', /this\._searchTimer = setTimeout\(\(\) => this\.load\(true\), 300\)/.test(jsSrcNow));
  ok('前端用 seq 丢弃过期响应（不用 loading 挡请求）', /const seq = \(this\._seq \|\| 0\) \+ 1/.test(jsSrcNow) && /if \(seq !== this\._seq\) return;/.test(jsSrcNow) && !/if \(this\.data\.loading\) return;[\s\S]{0,40}load/.test(jsSrcNow));
  ok('组织筛选项由服务端 facets 生成（不在前端写死）', /applyFacets\(data\.facets\)/.test(jsSrcNow));

  // 「如果是班主任还要注意」：只有一个班的人不给组织维度筛选（单选项下拉是噪音）
  ok('组织维度筛选只对多班可见者渲染', /showOrgFilters: isMember \|\| !this\.data\.className/.test(jsSrcNow) && /wx:if="\{\{showMore && showOrgFilters\}\}"/.test(wxmlSrc));

  // 真实请求：点选院校 → 参数进 query
  queries.length = 0;
  inst = makeInstance({});
  listStub = LIST_STUB;
  await inst.load(true);
  ok('首屏 facets 落地为 picker 候选', inst.data.schoolLabels.length === 2 && inst.data.schoolLabels[1].includes('北校区'), JSON.stringify(inst.data.schoolLabels));
  inst.onOrgPick({ currentTarget: { dataset: { key: 'school', options: 'schools' } }, detail: { value: 1 } });
  await new Promise((r) => setTimeout(r, 20));
  ok('选院校 → 请求带 school', queries.some((q) => q.school === '北校区'), JSON.stringify(queries.slice(-1)));
  inst.onOrgPick({ currentTarget: { dataset: { key: 'building', options: 'buildings' } }, detail: { value: 1 } });
  await new Promise((r) => setTimeout(r, 20));
  ok('选楼栋 → 请求带 building', queries.some((q) => q.building === '洋河-男宿'), JSON.stringify(queries.slice(-1)));
  inst.onKeyword({ detail: { value: '大数据' } });
  await new Promise((r) => setTimeout(r, 350));
  ok('关键词 → 请求带 keyword', queries.some((q) => q.keyword === '大数据'), JSON.stringify(queries.slice(-1)));
  ok('筛选摘要含已选维度', /北校区/.test(inst.data.filterTip) && /大数据/.test(inst.data.filterTip), inst.data.filterTip);

  // ====================================================================
  // ⑦ 本次新增：卡片缺勤人 + 照片（同轮需求：「检查记录与复审台中要优化卡片
  //    增加缺勤人的显示、照片显示」）
  // ====================================================================
  console.log('\n[7] 卡片缺勤人 + 照片');
  inst = makeInstance({});
  listStub = LIST_STUB;
  await inst.load(true);
  const row1 = inst.data.list[0];
  ok('缺勤人数文案', row1.rosterText === '缺勤 8 人', row1.rosterText);
  ok('缺勤人姓名取前 3 个（服务端已截断）', row1.rosterNamesText === '李四、王五、赵六', row1.rosterNamesText);
  ok('折叠 +N = count − 已展示姓名数', row1.rosterMoreText === '+5', row1.rosterMoreText);
  ok('照片只渲染服务端给的前 3 张', row1.photos.length === 3 && row1.hasPhotos === true, String(row1.photos.length));
  ok('照片 +N = photoCount − photos.length', row1.photoMoreText === '+2', row1.photoMoreText);

  const row2 = inst.data.list[1];
  ok('名单空但计数>0 → 「名单未记录」（不能显示 0 人）', row2.rosterText === '未归 3 人' && row2.rosterFlagText === '名单未记录', `${row2.rosterText}/${row2.rosterFlagText}`);
  ok('宿舍照片被裁剪 → 显示原因而不是空白', row2.photosBlurred === true && /宿舍照片/.test(row2.photoMaskText), row2.photoMaskText);

  const row3 = inst.data.list[2];
  ok('无权限视角 → 「名单仅管理端可见」（人数仍给）', row3.rosterText === '未归 5 人' && row3.rosterFlagText === '名单仅管理端可见', `${row3.rosterText}/${row3.rosterFlagText}`);

  // 点图预览：catch:tap 阻止冒泡进详情
  ok('WXML 照片用 catch:tap（否则点图同时进详情）', /catch:tap="previewPhoto"/.test(wxmlSrc));
  ok('WXML 有缺勤人区块', /rs-roster/.test(wxmlSrc) && /item\.rosterNamesText/.test(wxmlSrc));
  const wxssSrc = fs.readFileSync(path.join(MINI, 'packageUnion/records/records.wxss'), 'utf8');
  ok('WXSS 有照片与名单样式定义', /\.rs-photo\s*\{/.test(wxssSrc) && /\.rs-roster\s*\{/.test(wxssSrc));
  lastPreview = null;
  inst.previewPhoto({ currentTarget: { dataset: { id: 'r1', index: 1 } } });
  ok('点图走 wx.previewImage 且 current 指向被点那张', !!lastPreview && lastPreview.urls.length === 3 && lastPreview.current === 'https://a/2.jpg', JSON.stringify(lastPreview));
  lastPreview = null;
  inst.previewPhoto({ currentTarget: { dataset: { id: 'r2', index: 0 } } });
  ok('无照片时点图不崩（photos 空数组）', lastPreview === null);

  console.log(`\n${failed ? `FAILED ${failed}` : '全部通过'}`);
  process.exit(failed ? 1 : 0);
})();