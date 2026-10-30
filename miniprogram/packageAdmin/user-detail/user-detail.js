const auth = require('../../utils/request');
const fmt = require('../../utils/format');

function fmtTime(v) {
  return v ? String(v).slice(0, 16).replace('T', ' ') : '';
}

// 日期 → 「M月D日」
function dateText(dateKey) {
  if (!dateKey) return '';
  return `${Number(dateKey.slice(5, 7))}月${Number(dateKey.slice(8, 10))}日`;
}

// 运动明细每页条数（简化分页：上一页 / n·m / 下一页）
const PAGE_SIZE = 10;

// 班名前缀推年级：'25大数据与会计' → '2025'；'23级机电1班' → '2023'（与 roster 口径一致）
function gradeOfClassName(name) {
  const m = String(name || '').match(/^(\d{2,4})/);
  if (!m) return '';
  const n = Number(m[1]);
  if (m[1].length === 4) return n >= 1900 && n <= 2099 ? String(n) : '';
  return n >= 0 && n <= 99 ? String(2000 + n) : '';
}

// ===== 徽章发放抽屉：定义 → 抽屉行 =====
// 条件类型中文（与 services/badges.js 的达成条件一一对应，仅用于抽屉副标题展示）
const BADGE_TYPE_TEXT = {
  total_steps: '累计步数',
  total_distance: '累计距离',
  total_days: '累计打卡',
  goal_days: '达标天数',
  single_steps: '单日步数',
  single_distance: '单次距离',
  streak_days: '连续打卡',
  points: '累计跑分',
  rank: '跑分总榜',
};

// 徽章定义 → 可读的达成条件（如「累计步数 · 100,000 步」「跑分总榜 · 前 100 名」）
function badgeDesc(def) {
  const label = BADGE_TYPE_TEXT[def.type] || '';
  const target = fmt.formatNumber(def.target || 0);
  if (!label) return def.description || '';
  if (def.type === 'rank') return `${label} · 前 ${target} 名`;
  if (def.type === 'total_distance' || def.type === 'single_distance') return `${label} · ${target} 米`;
  if (def.type === 'total_days' || def.type === 'goal_days' || def.type === 'streak_days') return `${label} · ${target} 天`;
  if (def.type === 'points') return `${label} · ${target} 分`;
  return `${label} · ${target} 步`;
}

// 定义列表 → 抽屉行：独立徽章一行；等级徽章（同 tierGroup）折叠成一组，组内按 tierLevel 排级别
//   prevItems 用于保留「上一轮哪些组是展开的」（发放后刷新数据不收起已展开的组）
function buildBadgeItems(definitions, prevItems) {
  const expanded = {};
  (prevItems || []).forEach((it) => {
    if (it.kind === 'group') expanded[it.tierGroup] = !!it.expanded;
  });
  const singles = [];
  const groups = new Map();
  for (const d of definitions || []) {
    const g = String(d.tierGroup || '').trim();
    if (g) {
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(d);
    } else {
      singles.push(d);
    }
  }
  const entries = [];
  singles.forEach((d) => {
    entries.push({
      sort: Number(d.sort) || 0,
      item: {
        k: `s:${d.key}`,
        kind: 'single',
        key: d.key,
        name: d.name,
        icon: d.icon || '',
        tierColor: d.tierColor || '',
        desc: badgeDesc(d),
        earned: !!d.earned,
      },
    });
  });
  groups.forEach((list, g) => {
    const levels = [...list].sort((a, b) => (Number(a.tierLevel) || 0) - (Number(b.tierLevel) || 0));
    const rows = levels.map((d) => ({
      key: d.key,
      name: d.name,
      icon: d.icon || '',
      tierColor: d.tierColor || '',
      desc: `Lv${Number(d.tierLevel) || 0} · ${badgeDesc(d)}`,
      earned: !!d.earned,
    }));
    entries.push({
      sort: Math.min(...levels.map((d) => Number(d.sort) || 0)),
      item: {
        k: `g:${g}`,
        kind: 'group',
        tierGroup: g,
        name: g,
        desc: badgeDesc(levels[0]),
        levelCount: rows.length,
        earnedCount: rows.filter((r) => r.earned).length,
        expanded: !!expanded[g],
        levels: rows,
      },
    });
  });
  entries.sort((a, b) => a.sort - b.sort);
  return entries.map((e) => e.item);
}

// 封禁/限制的判定依据（用户 2026-10-30「封禁用户要有分类 如人封、机封、AI封」）。
//
// 文案**以服务端为准**（唯一定义处 models/ban-record.js::SOURCE_TEXT，
// 由 activeRestrictions / attachBanInfo 一并下发 sourceText）；
// 这里这张表只是**旧服务端没下发时的兜底** —— 与仓库既有的
// `u.classStatusText || CLASS_STATUS_TEXT[...]` 同一套模式。
// legacy：本功能上线前的老记录没存 source，且 operator='system' 时无法还原
// 当时是规则命中还是模型判定 —— **不猜**（猜错会让「AI 误封率」统计失真）。
const BAN_SOURCE_TEXT = { manual: '人封', ai: 'AI封', rule: '机封', legacy: '早期' };
const banSourceLabel = (r) => {
  // 服务端已算好（含历史推断）→ 直接用
  if (r && r.sourceText) return r.sourceText;
  const src = (r && r.source) || '';
  if (BAN_SOURCE_TEXT[src]) return BAN_SOURCE_TEXT[src];
  const op = String((r && r.operator) || '');
  if (op && op !== 'system') return BAN_SOURCE_TEXT.manual; // 有 openid 执行 = 人操作，可确定
  // source 与 operator 都为空（异常空对象）→ 不显示，别硬套「早期」
  if (!src && !op) return '';
  return BAN_SOURCE_TEXT.legacy;
};

/**
 * 徽标要不要显示（WXML 只读这个布尔，不在模板里比中文）。
 *
 * 规则：只给**非人封**显示。「人封」就是当前操作人自己，写出来是噪音；
 * 而 AI封 / 机封 / 早期未分类 才是「不是我干的，我得知道是谁干的」——
 * 尤其 AI封（模型判定，可能误伤，用户最初的抱怨正是「容易误封锁」）。
 */
const showBanSource = (label) => !!label && label !== BAN_SOURCE_TEXT.manual;

// 合并两份能力表（/overview 面向班委可看的宿舍场景，/manage 是班主任的完整能力表）。
// 规则：**任一为 true 即 true**（取并集）。
// 为什么安全：两个来源都来自服务端、都做了同样的成员资格校验；
// 班主任两份都通，班委只有 /overview，所以并集恰好等于「这个人真实能做的事」。
// 字段名两边刻意统一（dorm / editProfile / resetPassword / badges / ban / unban / unbindWechat / deleteAccount）。
const CAP_KEYS = [
  'editProfile',
  'resetPassword',
  'badges',
  'ban',
  'unban',
  'dorm',
  'unbindWechat',
  // 班委开关（用户 2026-10-24「班主任在班级 TAB 没有配置班委的权限」）
  'classOfficer',
  'deleteAccount',
];
function mergeCaps(a, b) {
  const out = {};
  for (const k of CAP_KEYS) out[k] = !!(a && a[k]) || !!(b && b[k]);
  return out;
}


// 在抽屉行里按 badgeKey 找目标（独立徽章直接命中；等级徽章命中组内某一级）
function findBadgeItem(items, key) {
  for (const it of items || []) {
    if (it.kind === 'single' && it.key === key) return it;
    if (it.kind === 'group') {
      const hit = (it.levels || []).find((lv) => lv.key === key);
      if (hit) return hit;
    }
  }
  return null;
}

Page({
  data: {
    id: '',
    user: null,
    bans: [],
    loading: true,
    // ===== 视角（管理端 / 班级域）=====
    scope: 'admin', // admin | class
    readonlyScope: false, // 班级域打开时是否为只读降级视图（管理权限不足才会走到这里）
    className: '',
    classOnly: false, // true = 用班级域数据渲染（无管理权限的班主任 / 班委）
    classMissing: false, // 班级域回退也拿不到该生数据
    classInfo: null, // 班级域的今日 / 本周摘要
    fallbackName: '',
    isTeacherUser: false, // 目标账号是教师：不展示运动 / 跑分 / 考核内容
    isSuper: false,
    // 当前登录者权限：编辑资料/重置密码/删除账户需 permission.manage，解绑微信需 user.manage
    canManagePerms: false,
    canManageUser: false,
    // ===== 班主任对本班学生的管理权（用户 2026-10-22）=====
    // **与权限项无关**：班主任身份本身就是「只管本班学生」的管理授权，
    // 可做 编辑资料 / 重置密码 / 发放徽章 / 限制功能(sync,gps) / 删除账户。
    // 判定全部由服务端给（/api/admin/users/:id 的 canManageStudent、/api/class/student/:id/manage 的 200），
    // 前端只控显隐；真正的鉴权在 services/student-scope.js + 班级域写接口。
    canManageStudent: false,
    // ===== 班主任能做什么：**由服务端逐项下发**（/api/class/student/:id/manage 的 capabilities）=====
    // 用户 2026-10-23：「有的功能显示按钮，你像删除账户，他没有这个权限请你不要显示」。
    // 前端不再自己判断哪几个动作能开，服务端说能做什么就画什么 —— 两边判断一漂移就会出现
    // 「按钮能点、点了 403」。管理端视角没有 capabilities，按权限项算（见 canPermsOf）。
    caps: {
      editProfile: false,
      resetPassword: false,
      badges: false,
      ban: false,
      unban: false,
      dorm: false,
      unbindWechat: false,
      classOfficer: false,
      deleteAccount: false,
    },
    // 班主任只能限制这两个类型（限制登录是校级处置，服务端会拒绝 login）
    banScopes: [],
    // 徽章发放 / 回收需 badge.manage（服务端 requirePermission('badge.manage') 同步拦，前端只控显隐）
    canManageBadges: false,
    // 加入学生会二维码（用户 2026-10-22）：学生主页展示，干部扫码加人。
    // canShowInvite 由权限决定（需能看学生会域）；qr 存凭证串与有效期。
    canShowInvite: false,
    qrVisible: false,
    qrLoading: false,
    qrError: '',
    qr: { token: '', qrImage: '', expiresText: '', realName: '', studentId: '', className: '' },
    // 当前生效的限制（限制登录 / 限制微信同步 / 限制 GPS）
    restrictions: [],
    // 「限制账号功能」抽屉
    banSheet: { visible: false, user: null, busy: false },
    // ===== 考核与运动全景 =====
    rates: null,
    goal: null,
    // 跑分汇总（{ totalText, todayText, weekText, enabled, configText }）
    points: null,
    // 主 Tab：概览 overview | 运动 sport | 班级 class | 账号 account
    mainTab: 'overview',
    recordTab: 'daily', // 最近运动 runs | 日记录 daily | 周记录 weekly | 饮水 water | 徽章 badges
    // 运动明细：按 Tab 分页缓存（每页 PAGE_SIZE 条，按钮翻页，不是触底追加）
    records: { runs: [], daily: [], weekly: [], water: [], badges: [] },
    recordPages: { runs: 1, daily: 1, weekly: 1, water: 1, badges: 1 }, // 各 Tab 记忆自己的页码
    recordTotals: { runs: 0, daily: 0, weekly: 0, water: 0, badges: 0 },
    recordPage: 1,
    recordPagesTotal: 1,
    recordTotal: 0,
    recordLoading: false,
    loginInfo: null,
    unbinding: false,
    // ===== 班级身份（班主任班级 / 班委，需 user.manage）=====
    canManageClass: false,
    homeroomClasses: [], // 教师：已分配的班主任班级（多选）
    isClassOfficer: false, // 学生：是否班委
    classSheetVisible: false,
    classOptions: [], // 班级候选（/api/admin/users/filters 的 classes → [{label,value}]）
    classMeta: [], // 每班 { className, grade, departmentName, schoolName }
    classFiltered: [], // 应用筛选后真正渲染的候选
    classKeyword: '',
    classSchool: '',
    classDept: '',
    classGrade: '',
    classSchoolRange: ['全部院系'],
    classDeptRange: ['全部系部'],
    classGradeRange: ['全部年级'],
    classSchoolIndex: 0,
    classDeptIndex: 0,
    classGradeIndex: 0,
    classDraft: [],
    classSaving: false,
    officerSaving: false,
    // ===== 宿舍（按学生绑定房间：权威数据是 dorm_assignments，一间房可混住几个班）=====
    // 录入形态**与「班级管理 → 宿舍」共用同一份组件**（主包 components/dorm-sheet，页面 json 已注册）：
    // 单栏「宿舍号（楼号·门号）」主输入 + 可选「床位号」次输入 + 楼栋/已有房间快捷 + 退宿/保存，
    // 组件只抛事件、页面持状态并调接口（两处接口不同），所以这里只保留受控字段。
    dorm: null, // { roomText, roomId, bedNo, status } | null（null = 未分配 / 未绑微信 / 教师）
    dormText: '未分配',
    // ===== 学生会身份（只读展示；改成员走管理端学生会成员页 / 用户端成员管理）=====
    union: { isMember: false, roles: [], text: '' },
    unionRoles: [],
    dormSheetVisible: false,
    dormSheetSub: '', // 抽屉副标题（组件 sub 属性）
    dormSheetLoading: false,
    dormSaving: false,
    dormSheetCanUnbind: false, // 有在住记录才允许退宿（按钮置灰而不是消失）
    dormWechatBound: true, // false → 保存禁用并给出明确原因（住宿记录按 openid 建立）
    dormForm: { roomText: '', bedNo: '' },
    dormBuildings: [], // [{ name, rooms }]
    dormQuickRooms: [], // 本班已住过的房间（混宿时复用同一间最常用）
    // ===== 徽章发放抽屉（需 badge.manage）=====
    badgeSheetVisible: false,
    badgeSheetLoading: false,
    badgeItems: [], // [{ kind:'single'|'group', ... }]（等级组可展开选级别）
    badgeGranting: '', // 正在发放的 badgeKey（防连点）
    // ===== 密码变更（用户 2026-10-26）=====
    // pwdMenuVisible：动作选择层（恢复初始密码 / 设置新密码）
    // pwdSheetVisible：设置新密码的输入弹层
    pwdMenuVisible: false,
    pwdIsTeacher: false,
    pwdSheetVisible: false,
    pwdTargetName: '',
    pwdForm: { password: '', confirm: '' },
    pwdStrength: { cls: '', icon: 'info-circle', color: 'var(--tt-text-3)', text: '6-20 位，建议字母 + 数字组合' },
    pwdSaving: false,
  },

  onLoad(options) {
    const scope = options.scope === 'class' ? 'class' : 'admin';
    this.setData({
      id: options.id || '',
      scope,
      readonlyScope: scope === 'class',
      className: options.className ? decodeURIComponent(options.className) : '',
      fallbackName: options.name ? decodeURIComponent(options.name) : '',
    });
    this.load();
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const me = (getApp().globalData.userInfo || {}).effectivePermissions || [];
      const star = me.includes('*');
      const canPerms = star || me.includes('permission.manage');
      const canUser = star || me.includes('user.manage');
      const canBadges = star || me.includes('badge.manage');
      this.setData({
        canManagePerms: canPerms,
        canManageUser: canUser,
        // 班级身份（班主任班级 / 班委）在本页分配，需 user.manage
        canManageClass: canUser,
        // 徽章发放 / 回收：独立权限项 badge.manage（不与 content.manage 复用）
        canManageBadges: canBadges,
        // 加入学生会二维码：能看学生会域即可展示（谁都能看这张码，用它是干部的事）
        canShowInvite: star || me.includes('union.view') || me.includes('union.manage') || me.includes('union.steward'),
        // 管理端视角的能力表：与班级域 capabilities **同一套字段**，模板只读一处。
        // 服务端鉴权仍按权限项（requirePermission），这里只决定画不画按钮。
        caps: {
          editProfile: canPerms,
          resetPassword: canPerms,
          // 徽章以 badge.manage 为准（管理端独立权限项）
          badges: canBadges,
          ban: canUser,
          unban: canUser,
          dorm: canUser,
          // 解绑微信在管理端是 user.manage
          unbindWechat: canUser,
          // 删除账户在管理端是 permission.manage（与「编辑资料」同权限项）
          deleteAccount: canPerms,
        },
      });
      // 班级域打开时：先按管理端权限取资料（有权限 → 与管理面板完全一致）；
      // 无权限（403）才降级为班级域只读数据，绝不绕过服务端权限
      let detail = null;
      try {
        detail = await auth.get(`/api/admin/users/${this.data.id}`);
      } catch (e) {
        if (this.data.scope !== 'class') throw e;
        detail = null;
      }
      if (!detail) {
        await this.loadClassScope();
        return;
      }
      // ===== 班主任走管理端读路径时的能力补齐（用户 2026-10-24 报「示例教师1 没有本班操作权限」）=====
      //
      // 根因：教师权限组带 user.view → 详情页走的是管理端这条读路径（不是班级域回退分支），
      // 而上面那套 caps 是按 user.manage / permission.manage / badge.manage 算的 ——
      // 班主任这些权限项都没有 → caps 全 false → 快捷操作与班级 TAB 一个都不渲染。
      // 服务端其实已经通过 detail.canManageStudent=true 说了「这个班主任能管这个学生」，
      // 但前端没去拿它的能力表。
      //
      // 修法：canManageStudent=true 时补拉一次班级域 /manage（loadHomeroomTarget 会做完全
      // 同一份判定，拉不通就是拉不通），把它下发的 capabilities / banScopes 并进本页。
      // 能力仍然只有服务端说了算（AGENTS.md：前端只控显隐，鉴权在服务端），
      // 前端不再自己猜「班主任应该能做什么」。
      let homeroomCaps = {};
      let homeroomBanScopes = [];
      if (detail.canManageStudent) {
        const cls = (detail.user && detail.user.className) || this.data.className || '';
        if (cls) {
          try {
            const mg = await auth.get(`/api/class/student/${this.data.id}/manage?className=${encodeURIComponent(cls)}`);
            homeroomCaps = (mg && mg.capabilities) || {};
            homeroomBanScopes = (mg && mg.banScopes) || [];
          } catch (e) {
            // 403 = 服务端最终判定不让管（例如目标学生自己持有管理权限）→ 按只读渲染，静默
            homeroomCaps = {};
          }
        }
      }
      const [sportDetail] = await Promise.all([
        auth.get(`/api/admin/users/${this.data.id}/sport-detail`).catch(() => null),
      ]);
      const { user, bans, sport: sportArg, goal: goalArg, loginInfo, restrictions, dorm, union } = detail;      const SCOPE_TEXT = { login: '限制登录', sync: '限制微信同步', gps: '限制 GPS', manual: '限制登录' };
      // 限制类型对应图标（在 JS 里算好：WXML 的三元表达式会让静态检查把 'sync' 当成图标名）
      const SCOPE_ICON = { login: 'lock-on', sync: 'logo-wechat-stroke', gps: 'location' };
      const recentRuns = ((sportArg && sportArg.recentRuns) || []).map((r) => ({
        ...r,
        dateText: dateText(r.date),
        distanceText: fmt.formatDistance(r.distance),
        durationText: fmt.formatDuration(r.durationSeconds),
        sourceText: r.source === 'gps' ? 'GPS 实跑' : '微信运动',
      }));

      const rates = sportDetail && sportDetail.rates;
      const goal = (sportDetail && sportDetail.goal) || goalArg || null;
      // 跑分汇总（学校衡量标准）：total 全历史 / today 今日 / week 本周（周一起）
      const pts = (sportDetail && sportDetail.points) || null;
      // 宿舍：权威数据在 dorm_assignments（学生 ↔ 房间），详情接口已带回，不再额外请求。
      // 教师账号不安排宿舍；未绑微信 / 未在住都按「未分配」展示。
      const dormRow = user.role === 'teacher' ? null : dorm || null;
      this.setData({
        loading: false,
        // 目标账号是教师：教师不参与运动记录与排名 → 隐藏运动 / 跑分 / 考核内容（班级身份与账号操作保留）
        isTeacherUser: user.role === 'teacher',
        classOnly: false,
        classMissing: false,
        classInfo: null,
        isSuper: (user.permissionGroups || []).includes('superadmin'),
        // 班主任对本班学生的管理权（服务端判定）：走到管理端详情分支也要认它 ——
        // 「有 user.view 的班主任」不会进班级域回退分支，只认权限项的话他们会一个按钮都看不到。
        canManageStudent: !!detail.canManageStudent,
        // 限制类型：优先用班级域下发的（班主任可 login/sync/gps），
        // 管理端权限项给的 sync/gps 作为兜底。
        banScopes: homeroomBanScopes.length ? homeroomBanScopes : detail.canManageStudent ? ['sync', 'gps'] : [],
        // 能力表 = 管理端权限项算出的 caps（上面 setData 已写）∪ 班级域下发的能力。
        // 班主任走管理端读路径时，权限项那套全 false，靠这里把班级域能力并进来。
        caps: mergeCaps(
          {
            editProfile: canPerms,
            resetPassword: canPerms,
            badges: canBadges,
            ban: canUser,
            unban: canUser,
            dorm: canUser,
            unbindWechat: canUser,
            classOfficer: canUser,
            deleteAccount: canPerms,
          },
          homeroomCaps
        ),
        homeroomClasses: user.homeroomClasses || [],
        isClassOfficer: !!user.isClassOfficer,
        dorm: dormRow,
        dormText: dormRow && dormRow.roomText
          ? `${dormRow.roomText}${dormRow.bedNo ? `（${dormRow.bedNo} 床）` : ''}`
          : '未分配',
        // 抽屉副标题（组件 sub 属性）：与「班级管理 → 宿舍」同一口径 = 「班级/学号 · 当前宿舍」
        dormSheetSub: `${user.className || '未分班'} · ${
          dormRow && dormRow.roomText
            ? `${dormRow.roomText}${dormRow.bedNo ? `（${dormRow.bedNo} 床）` : ''}`
            : '未分配'
        }`,
        user: {
          ...user,
          createdText: fmtTime(user.createdAt),
          bannedUntilText: user.bannedUntil ? user.bannedUntil.slice(0, 16).replace('T', ' ') : '',
        },
        // 学生会身份（服务端按 openid 查在任成员记录）：非成员 = { isMember:false }
        union: union || { isMember: false, roles: [], text: '' },
        unionRoles: ((union && union.roles) || []).map((r) => ({
          ...r,
          mainText: [r.deptName, r.roleText].filter(Boolean).join(' · '),
          subText: [r.levelText, r.termLabel].filter(Boolean).join(' · '),
        })),
        bans: bans.map((b) => ({
          ...b,
          timeText: fmtTime(b.createdAt),
          typeText: SCOPE_TEXT[b.banType] || (b.banType === 'manual' ? '限制登录' : '功能限制'),
          // 判定依据（用户 2026-10-30「人封、机封、AI封」）：流水里必须能看出是谁判的，
          // 否则「系统自动」四个字把规则判定和模型判定混成一件，排查误封时无从下手。
          // 字段名刻意用 banSourceLabel 而不是 sourceText：本文件里运动记录已有 sourceText
          //   （值是「GPS 实跑 / 微信运动」），同名两义会让后来者读错上下文。
          banSourceLabel: banSourceLabel(b),
        })),
        restrictions: (restrictions || []).map((r) => {
          const label = banSourceLabel(r);
          return {
            ...r,
            icon: SCOPE_ICON[r.scope] || 'lock-on',
            untilText: r.until ? fmtTime(r.until) : '永久',
            banSourceLabel: label,
            showBanSource: showBanSource(label),
          };
        }),
        sport: {
          totalStepsText: fmt.formatNumber(user.totalSteps || 0),
          totalDistanceText: fmt.formatDistance(user.totalDistance || 0),
          totalDays: user.totalDays || 0,
          badgeCount: (sportArg && sportArg.badgeCount) || 0,
          waterToday: (sportArg && sportArg.waterToday) || { total: 0, target: 0 },
          recentRuns,
        },
        rates: rates
          ? {
              dailyRateText: rates.dailyRate == null ? '—' : `${rates.dailyRate}%`,
              weeklyRateText: rates.weeklyRate == null ? '—' : `${rates.weeklyRate}%`,
              dailyText: rates.dailyTotal ? `达标 ${rates.dailyAchieved} / ${rates.dailyTotal} 天` : '暂无记录',
              weeklyText: rates.weeklyTotal ? `达标 ${rates.weeklyAchieved} / ${rates.weeklyTotal} 周` : '暂无记录',
            }
          : null,
        goal: goal
          ? {
              planName: goal.planName || '默认目标',
              dailyStepsText: fmt.formatNumber(goal.daily && goal.daily.steps),
              weeklyStepsText: fmt.formatNumber(goal.weekly && goal.weekly.steps),
            }
          : null,
        points: pts
          ? {
              totalText: fmt.formatNumber(pts.total || 0),
              todayText: fmt.formatNumber(pts.today || 0),
              weekText: fmt.formatNumber(pts.week || 0),
              enabled: !pts.config || pts.config.enabled !== false,
              configText: pts.config
                ? `日目标 +${pts.config.dailyGoal} · 周目标 +${pts.config.weeklyGoal} · 超出日目标后每再多达成个人目标的 ${pts.config.extraPercent}% 加 ${pts.config.perStepScore} 分（单日上限 +${pts.config.dailyExtraCap}）`
                : '',
            }
          : null,
        // 明细列表改由 /:id/records 分页加载（见 loadRecords），这里不再接收全量
        loginInfo: loginInfo
          ? {
              ...loginInfo,
              wechatBoundAtText: fmtTime(loginInfo.wechatBoundAt),
              lastLoginText: fmtTime(loginInfo.lastLogin),
              lastWxSessionText: fmtTime(loginInfo.lastWxSessionAt),
              lastSyncText: fmtTime(loginInfo.lastSyncAt),
              devices: (loginInfo.devices || []).map((d) => ({
                ...d,
                lastUsedText: fmtTime(d.lastUsedAt || d.createdAt),
                expireText: d.revoked ? '已吊销' : fmtTime(d.expiresAt) + ' 过期',
              })),
            }
          : null,
        // 换用户时清空明细分页缓存，随后按当前 Tab 拉第一页
        records: { runs: [], daily: [], weekly: [], water: [], badges: [] },
        recordPages: { runs: 1, daily: 1, weekly: 1, water: 1, badges: 1 },
        recordTotals: { runs: 0, daily: 0, weekly: 0, water: 0, badges: 0 },
        recordPage: 1,
        recordPagesTotal: 1,
        recordTotal: 0,
      });
      this.loadRecords(this.data.recordTab, 1);
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  // ===== 班级域视图（scope=class：无管理端权限的班主任 / 班委）=====
  // 数据只用 /api/class/*（服务端成员资格校验）。
  // 班主任（且目标是没有管理权限的普通学生）额外拿到「管理权」：编辑资料 / 重置密码 /
  // 发放徽章 / 限制功能 / 删除账户（用户 2026-10-22）。判定完全由服务端给：
  // GET /api/class/student/:id/manage → 200 才有；班委一律 403（这里静默按只读渲染）。
  async loadClassScope() {
    const { id, className, fallbackName } = this.data;
    const cls = className || '';
    let row = null;
    try {
      const res = await auth.get('/api/class/students', { className: cls, keyword: id, page: 1, limit: 5 });
      const list = (res && res.list) || [];
      row = list.find((s) => s.userId === id) || null;
    } catch (e) {
      row = null;
    }
    // 能力探测（用户 2026-10-23 修正）：
    //   旧实现只调 /manage（**仅班主任**），班委拿到 403 → caps 全 false →
    //   连「宿舍」入口都不渲染，于是「班委能改宿舍」在服务端成立、界面上完全看不见。
    //   现在改调 /overview（班主任与班委都通）：它回宿舍面板 + 逐项能力，
    //   studentAccount 类能力对班委恒 false。
    let overview = null;
    try {
      overview = await auth.get(`/api/class/student/${id}/overview?className=${encodeURIComponent(cls)}`);
    } catch (e) {
      overview = null;
    }
    // 班主任额外再取 /manage（用于账户编辑页回填与限制类型；班委 403 → 静默忽略）
    let manage = null;
    try {
      manage = await auth.get(`/api/class/student/${id}/manage?className=${encodeURIComponent(cls)}`);
    } catch (e) {
      manage = null;
    }
    if (!row) {
      this.setData({ loading: false, classOnly: true, classMissing: true });
      return;
    }
    const profile = (manage && manage.profile) || null;
    // 能力表先算好：classFooter 与 caps 都要用（同一个来源，别在模板里再判一遍）
    const mergedCaps = mergeCaps((overview && overview.capabilities) || {}, (manage && manage.capabilities) || {});
    // 宿舍面板数据源：manage（班主任）优先，其次 overview（班主任 + 班委都通）。
    // 只认 manage 会让班委的宿舍抽屉空白（楼名、是否绑微信全拿不到）。
    const dormSrc = (manage && manage.dorm) || (overview && overview.dorm) || {};
    const dormRoomText = dormSrc.roomText || row.roomText || '';
    const todayTarget = Number(row.todayTarget) || 0;
    const weekTarget = Number(row.weekTarget) || 0;
    this.setData({
      loading: false,
      classOnly: true,
      classMissing: false,
      isTeacherUser: false,
      isSuper: false,
      // 管理类操作：只有班级域判定为「本班班主任 + 普通学生」才开；
      // 权限项那三个（canManagePerms / canManageUser / canManageBadges）在这里恒 false。
      // **具体哪几个按钮**由服务端 capabilities 决定（用户 2026-10-23「删除账户他没有这个权限
      // 请你不要显示」）：服务端说不给 → 这里就是 false → 模板不渲染，点了也不会有请求。
      canManagePerms: false,
      canManageUser: false,
      canManageClass: false,
      canManageBadges: false,
      canManageStudent: !!(overview && overview.capabilities && overview.capabilities.studentAccount),
      // 能力表：以 /overview 为准（班主任与班委都通），并合并 /manage 的完整能力（班主任才有）。
      // 为什么合并而不是二选一：/overview 面向「班委也看」的宿舍场景，
      // /manage 才是班主任的完整能力表（含徽章/限制/解绑）。班主任两者都通，取并集最准确。
      caps: mergedCaps,
      // 底部说明按能力表说事实：班委能排宿舍，就不能再写「班委仅查看」（用户 2026-10-24）
      classFooter: mergedCaps.editProfile
        ? '班级视角：班主任可对本班学生「编辑资料 / 重置密码 / 发徽章 / 限制功能 / 排宿舍」；学籍字段与删除账户仍归管理员'
        : mergedCaps.dorm
          ? '班级视角：班委可查看本班学生数据，并可维护本班学生宿舍（查宿与宿舍卫生据此计算）'
          : '班级视角：只读查看本班学生数据',
      // 限制类型：服务端给（班主任可限制 login/sync/gps；班委无此能力）
      banScopes: (manage && manage.banScopes) || [],
      badgeSheetVisible: false,
      badgeItems: [],
      bans: [],
      // 生效中的限制（班主任可解除自己下的 sync/gps 限制）
      // banSourceLabel 两条读路径都要给（与上面管理端分支同字段）：
      // 只在一边给，班主任看到的就永远没有分类，正是历史上「两条路径漂移」的老坑。
      restrictions: ((manage && manage.restrictions) || []).map((r) => {
        const label = banSourceLabel(r);
        return {
          ...r,
          untilText: r.until ? fmtTime(r.until) : '永久',
          banSourceLabel: label,
          showBanSource: showBanSource(label),
        };
      }),
      loginInfo: null,
      rates: null,
      goal: null,
      points: null,
      homeroomClasses: [],
      isClassOfficer: !!row.isClassOfficer,
      // 宿舍面板数据源：manage（仅班主任）→ overview（班主任与班委都通）→ 列表行 roomText。
      // 之前只认 manage：班委拿不到 manage（403）→ 楼名与快捷房间为空，
      // 宿舍抽屉打开后什么都选不了（用户 2026-10-24「身为班委在用户详情里排不了宿舍」）。
      dorm: dormRoomText ? { roomText: dormRoomText, bedNo: dormSrc.bedNo || '', roomId: dormSrc.roomId || '' } : null,
      dormText: dormRoomText || '未分配',
      // 班级视角的学生会身份：/api/class/students 每行带 unionText（「生活部 · 部长」），
      // 没有就是未加入 —— 班主任只读视角也要能看到，不然「学生会」信息在班级入口永远缺失。
      union: row.unionText ? { isMember: true, text: row.unionText } : { isMember: false, roles: [], text: '' },
      unionRoles: row.unionText
        ? [{ mainText: row.unionText, levelText: '学生会', termLabel: '' }]
        : [],
      dormSheetSub: `${cls || '未分班'} · ${dormRoomText || '未分配'}`,
      dormSheetVisible: false,
      // 楼名 / 快捷房间 / 是否绑微信：manage（班主任）与 overview（班主任+班委）都带，取有值的那份。
      // 只认 manage 会让班委的宿舍抽屉变成空白禁用（用户 2026-10-24）。
      dormBuildings: dormSrc.buildings || [],
      dormQuickRooms: dormSrc.quickRooms || [],
      dormWechatBound: !!dormSrc.wechatBound,
      user: {
        _id: id,
        realName: (profile && profile.realName) || row.name || fallbackName || '未命名',
        nickname: '',
        className: cls,
        studentId: row.studentId || '',
        role: 'student',
        gender: (profile && profile.gender) || 0,
        birthdate: (profile && profile.birthdate) || '',
        isClassOfficer: !!row.isClassOfficer,
      },
      // hero 四项换成班级域口径（累计字段班级接口不提供，只有本周 / 活跃 / 跑分）
      sport: {
        totalStepsText: fmt.formatNumber(row.weekSteps),
        totalDistanceText: fmt.formatDistance(row.weekDistance),
        totalDays: row.activeDays || 0,
        badgeCount: 0,
        weekPointsText: fmt.formatNumber(row.weekPoints || 0),
        waterToday: null,
        recentRuns: [],
        classScope: true,
      },
      classInfo: {
        todayStepsText: fmt.formatNumber(row.todaySteps),
        todayTargetText: fmt.formatNumber(todayTarget),
        weekStepsText: fmt.formatNumber(row.weekSteps),
        weekTargetText: fmt.formatNumber(weekTarget),
        achievedToday: !!row.achievedToday,
        achievedWeek: !!row.achievedWeek,
        syncText: row.lastSyncAt ? fmtTime(row.lastSyncAt) : '从未同步',
        totalStepsText: fmt.formatNumber(row.totalSteps || 0),
        totalDays: row.totalDays || 0,
      },
      records: { runs: [], daily: [], weekly: [], water: [], badges: [] },
      recordPages: { runs: 1, daily: 1, weekly: 1, water: 1, badges: 1 },
      recordTotals: { runs: 0, daily: 0, weekly: 0, water: 0, badges: 0 },
      recordPage: 1,
      recordPagesTotal: 1,
      recordTotal: 0,
      recordTab: 'daily',
    });
    this.loadRecords('daily', 1);
  },

  // 主 Tab 切换（概览 / 运动 / 班级 / 账号）：纯前端分组，不重新请求
  switchMainTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.mainTab) return;
    this.setData({ mainTab: tab });
  },

  // 明细 Tab 切换：首次进入该 Tab 才拉数据；已加载过则恢复它自己的页码
  switchRecordTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.recordTab) return;
    const cached = ((this.data.records || {})[tab] || []).length > 0;
    const pages = this.data.recordPages || {};
    const totals = this.data.recordTotals || {};
    const page = cached ? pages[tab] || 1 : 1;
    const total = cached ? totals[tab] || 0 : 0;
    this.setData({
      recordTab: tab,
      recordPage: page,
      recordTotal: total,
      recordPagesTotal: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    });
    if (!cached) this.loadRecords(tab, 1);
  },

  // 运动明细分页加载：每次只取一页（type: runs|daily|weekly|water|badges）
  // 班级域回退（classOnly）走 /api/class/student/:id/records，只有 runs|daily|weekly 三类
  async loadRecords(tab, page) {
    const type = tab || this.data.recordTab;
    if (this.data.recordLoading) return;
    const p = Math.max(1, page || 1);
    this.setData({ recordLoading: true });
    try {
      const res = this.data.classOnly
        ? await auth.get(`/api/class/student/${this.data.id}/records`, {
            className: this.data.className,
            type,
            page: p,
            limit: PAGE_SIZE,
          })
        : await auth.get(`/api/admin/users/${this.data.id}/records`, { type, page: p, limit: PAGE_SIZE });
      const list = ((res && res.list) || []).map((it) => this.fmtRecord(type, it));
      const total = (res && res.total) || 0;
      const pagesTotal = Math.max(1, Math.ceil(total / PAGE_SIZE));
      this.setData({
        records: { ...this.data.records, [type]: list },
        recordPages: { ...this.data.recordPages, [type]: p },
        recordTotals: { ...this.data.recordTotals, [type]: total },
        recordPage: p,
        recordTotal: total,
        recordPagesTotal: pagesTotal,
      });
    } catch (e) {
      wx.showToast({ title: e.message || '明细加载失败', icon: 'none' });
    } finally {
      this.setData({ recordLoading: false });
    }
  },

  // 各类型明细的展示字段（与详情接口口径一致）
  fmtRecord(type, it) {
    if (type === 'runs') {
      return {
        ...it,
        dateText: dateText(it.date),
        distanceText: fmt.formatDistance(it.distance),
        durationText: fmt.formatDuration(it.durationSeconds),
        sourceText: it.source === 'gps' ? 'GPS 实跑' : '微信运动',
      };
    }
    if (type === 'daily') {
      return { ...it, dateText: dateText(it.date), stepsText: fmt.formatNumber(it.steps), pointsText: fmt.formatNumber(it.points || 0) };
    }
    if (type === 'weekly') {
      return {
        ...it,
        rangeText: `${String(it.weekStart).slice(5).replace('-', '.')} - ${String(it.weekEnd).slice(5).replace('-', '.')}`,
        stepsText: fmt.formatNumber(it.steps),
        pointsText: fmt.formatNumber(it.points || 0),
      };
    }
    if (type === 'water') return { ...it, dateText: dateText(it.date) };
    // 徽章：管理端这个 Tab 只返回「已获得」的行，所以图标一律原色（不做灰度）；
    // 等级徽章补上「达标里程 · Lv2」上下文，独立徽章保持原样
    const lv = Number(it.level) || Number(it.tierLevel) || 0;
    const group = String(it.tierGroup || '').trim();
    const groupText = group ? `${group} · Lv${lv}` : '';
    return {
      ...it,
      earnedText: groupText ? `${groupText} · ${fmtTime(it.earnedAt)}` : fmtTime(it.earnedAt),
    };
  },

  // 按钮翻页：上一页 / 下一页（页码条已简化，不再支持跳指定页）
  prevRecordPage() {
    if (this.data.recordPage > 1) this.loadRecords(this.data.recordTab, this.data.recordPage - 1);
  },

  nextRecordPage() {
    if (this.data.recordPage < this.data.recordPagesTotal) {
      this.loadRecords(this.data.recordTab, this.data.recordPage + 1);
    }
  },

  // 解绑微信：二次确认后清除绑定（可被新微信重新绑定）
  // 路径随权限来源走：管理端（user.manage）→ /api/admin/users/:id/unbind-wechat；
  // 本班班主任 → /api/class/student/:id/unbind-wechat（成员资格校验，用户 2026-10-23）。
  unbindWechat() {
    const that = this;
    if (!this.data.caps.unbindWechat) return;
    wx.showModal({
      title: '解绑微信',
      content: '解绑后该账号将被此微信退出登录，可由任意微信重新绑定姓名密码；其运动等数据保留。确认解绑？',
      confirmColor: '#e5484d',
      success: async (res) => {
        if (!res.confirm) return;
        that.setData({ unbinding: true });
        try {
          const { head, q } = that.apiFor('ban'); // 与限制同一来源：能限制就能解绑
          await auth.post(`${head}/unbind-wechat${q}`);
          wx.showToast({ title: '已解绑', icon: 'success' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        } finally {
          that.setData({ unbinding: false });
        }
      },
    });
  },

  // 单条运动详情：管理端走 /api/admin/users/:uid/runs/:runId；
  // 班级域（班主任 / 班委）走 /api/class/student/:uid/run/:runId（成员资格校验、只读、隐藏「再跑一次」）
  openRun(e) {
    const runId = e.currentTarget.dataset.id;
    if (!runId) return;
    const url = this.data.classOnly
      ? `/pages/run/detail?id=${runId}&scope=class&uid=${this.data.id}&className=${encodeURIComponent(this.data.className)}`
      : `/pages/run/detail?id=${runId}&admin=1&uid=${this.data.id}`;
    wx.navigateTo({ url });
  },

  // 日/周记录 → 时段明细页（日：当天逐条；周：按天拆分）
  // 班级视角必须带上 scope=class，明细页才会走 /api/class/student/:id/period（只读）
  openPeriod(e) {
    const { type, date } = e.currentTarget.dataset;
    if (!date) return;
    const u = this.data.user || {};
    const name = u.realName || u.nickname || '';
    const scopeQuery = this.data.classOnly
      ? `&scope=class&className=${encodeURIComponent(this.data.className)}`
      : '';
    wx.navigateTo({
      url: `/packageAdmin/user-detail/period-detail/period-detail?id=${this.data.id}&type=${type || 'day'}&date=${date}&name=${encodeURIComponent(name)}${scopeQuery}`,
    });
  },

  // 同一个动作有两条接口路径：有对应管理权限 → 管理端 `/api/admin/users/:id/...`；
  // 否则（班主任）→ 班级域 `/api/class/student/:id/...`（服务端按班主任+本班学生鉴权）。
  // 这里只决定 URL；权限结论始终由服务端给（canManagePerms / canManageUser / canManageBadges / canManageStudent）。
  apiFor(kind) {
    const d = this.data;
    const viaAdmin = !!{
      account: d.canManagePerms,
      ban: d.canManageUser,
      badges: d.canManageBadges,
      // 宿舍：管理端按 user.manage（宿管），班主任按班级域（只能给自己班学生安排）
      dorm: d.canManageUser,
    }[kind];
    const head = viaAdmin ? `/api/admin/users/${d.id}` : `/api/class/student/${d.id}`;
    // 班级域的每个写接口都要带 className（服务端据此定位作用域）。
    // 多班班主任从「用户管理」列表进来时 URL 里没有 className → 回落到该学生自己的班级名，
    // 否则服务端会按「你负责多个班级，请指定 className」拒绝。
    const cls = d.className || (d.user && d.user.className) || '';
    const q = viaAdmin ? '' : `?className=${encodeURIComponent(cls)}`;
    return { head, q, viaAdmin, className: cls };
  },

  goEdit() {
    const { viaAdmin, className } = this.apiFor('account');
    if (viaAdmin) {
      wx.navigateTo({ url: `/packageAdmin/users/account-edit/account-edit?id=${this.data.id}` });
      return;
    }
    if (!this.data.canManageStudent) {
      wx.showToast({ title: '只有班主任可以编辑本班学生资料', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url:
        `/packageAdmin/users/account-edit/account-edit?id=${this.data.id}` +
        `&scope=class&className=${encodeURIComponent(className || '')}`,
    });
  },

  // 返回：班级视角下数据缺失时的兜底出口
  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/home/home' });
  },

  // 限制账号功能（类型 + 时长 + 原因）——走 ban-sheet 抽屉
  // 班主任（班级域）只允许「限制微信同步 / 限制 GPS」，banScopes 由服务端给，
  // 组件据此收敛选项 —— 不把注定 403 的「限制登录」摆出来。
  openBanSheet() {
    const u = this.data.user || {};
    this.setData({
      banSheet: { visible: true, user: { _id: this.data.id, account: u.account || u.nickname || u.realName || '' }, busy: false },
    });
  },

  onBanSheetClose() {
    this.setData({ 'banSheet.visible': false });
  },

  async onBanSubmit(e) {
    const { scope, days, reason } = e.detail || {};
    const { head, q } = this.apiFor('ban');
    this.setData({ 'banSheet.busy': true });
    try {
      await auth.post(`${head}/ban${q}`, { scope, days, reason: reason || '违反社区规范' });
      const text = { login: '限制登录', sync: '限制微信同步', gps: '限制 GPS' }[scope] || '已限制';
      wx.showToast({ title: `${text}${days > 0 ? ' ' + days + ' 天' : '（永久）'}`, icon: 'none' });
      this.setData({ 'banSheet.visible': false });
      this.load();
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' });
    } finally {
      this.setData({ 'banSheet.busy': false });
    }
  },

  // 解除限制：列出生效中的限制，再补固定三类 + 全部解除
  unban() {
    const that = this;
    const { head, q } = this.apiFor('ban');
    const items = [{ label: '全部解除', scope: 'all' }];
    (this.data.restrictions || []).forEach((r) => items.push({ label: `解除「${r.text}」`, scope: r.scope }));
    [
      { label: '解除限制登录', scope: 'login' },
      { label: '解除微信同步限制', scope: 'sync' },
      { label: '解除 GPS 限制', scope: 'gps' },
    ].forEach((f) => {
      if (!items.some((i) => i.scope === f.scope)) items.push(f);
    });
    wx.showActionSheet({
      itemList: items.map((i) => i.label),
      success: async (res) => {
        const scope = (items[res.tapIndex] || {}).scope || 'all';
        try {
          const r = await auth.post(`${head}/unban${q}`, { scope });
          wx.showToast({ title: r && r.lifted && r.lifted.length ? '已解除' : '该类型当前无生效限制', icon: 'none' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },

  // 删除账户：与列表左滑「删除」同一接口，删完返回列表。
  // ⚠️ 能力由服务端给（caps.deleteAccount）：班主任默认**没有**（用户 2026-10-23）。
  //    这里再挡一道 —— 模板已经不画按钮了，但留个硬闸门，避免日后从别处调进来发一次注定 403 的请求。
  removeAccount() {
    if (!this.data.caps.deleteAccount) {
      wx.showToast({ title: '班主任不能删除学生账户，如需调出本班请用「转移」', icon: 'none' });
      return;
    }
    const that = this;
    const u = this.data.user || {};
    const name = u.account || u.nickname || u.realName || '该用户';
    const { head, q, viaAdmin } = this.apiFor('account');
    void viaAdmin;
    wx.showModal({
      title: '删除账户',
      content: `将删除「${name}」及其全部运动 / 饮水 / 徽章 / 住宿等数据，不可恢复！确认删除？`,
      confirmText: '删除',
      confirmColor: '#e5484d',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.del(`${head}${q}`);
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 600);
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },

  // ===== 班级身份：班主任班级（教师多选抽屉）/ 班委（学生开关）=====
  // 接口 PUT /api/admin/users/:id/class-roles（需 user.manage）
  async openClassSheet() {
    if (!this.data.canManageClass) {
      wx.showToast({ title: '需要「封禁/解封用户」权限', icon: 'none' });
      return;
    }
    this.setData({ classSheetVisible: true, classDraft: [...(this.data.homeroomClasses || [])] });
    if (!this.data.classOptions.length) {
      try {
        // 班级候选复用管理端筛选接口：classes（在用班级名）+ classMeta（每班的年级/院系/系部，供抽屉筛选）
        const f = await auth.get('/api/admin/users/filters');
        const meta = (f.classMeta || []).length
          ? f.classMeta
          : (f.classes || []).map((c) => ({ className: c, grade: gradeOfClassName(c), departmentName: '', schoolName: '' }));
        const schools = [...new Set(meta.map((m) => m.schoolName).filter(Boolean))].sort();
        const grades = [...new Set(meta.map((m) => m.grade).filter(Boolean))].sort().reverse();
        this.setData({
          classOptions: (f.classes || []).map((c) => ({ label: c, value: c })),
          classMeta: meta,
          classSchoolRange: ['全部院系', ...schools],
          classGradeRange: ['全部年级', ...grades],
        });
        this.applyClassFilter();
      } catch (e) {
        wx.showToast({ title: e.message || '班级列表加载失败', icon: 'none' });
      }
    }
  },

  // 按 搜索 / 院系 / 系部 / 年级 过滤班级候选（系部候选随院系联动）
  applyClassFilter() {
    const { classMeta, classKeyword, classSchool, classDept, classGrade } = this.data;
    const kw = String(classKeyword || '').trim();
    const list = (classMeta || []).filter((m) => {
      if (classSchool && m.schoolName !== classSchool) return false;
      if (classDept && m.departmentName !== classDept) return false;
      if (classGrade && m.grade !== classGrade) return false;
      if (kw && !String(m.className).includes(kw)) return false;
      return true;
    });
    const depts = [
      ...new Set(
        (classMeta || [])
          .filter((m) => !classSchool || m.schoolName === classSchool)
          .map((m) => m.departmentName)
          .filter(Boolean)
      ),
    ].sort();
    this.setData({
      classFiltered: list.map((m) => ({ label: m.className, value: m.className })),
      classDeptRange: ['全部系部', ...depts],
    });
  },

  onClassKeyword(e) {
    this.setData({ classKeyword: e.detail.value || '' }, () => this.applyClassFilter());
  },

  onClassSchool(e) {
    const i = Number(e.detail.value) || 0;
    this.setData(
      { classSchoolIndex: i, classSchool: i ? this.data.classSchoolRange[i] : '', classDeptIndex: 0, classDept: '' },
      () => this.applyClassFilter()
    );
  },

  onClassDept(e) {
    const i = Number(e.detail.value) || 0;
    this.setData({ classDeptIndex: i, classDept: i ? this.data.classDeptRange[i] : '' }, () => this.applyClassFilter());
  },

  onClassGrade(e) {
    const i = Number(e.detail.value) || 0;
    this.setData({ classGradeIndex: i, classGrade: i ? this.data.classGradeRange[i] : '' }, () => this.applyClassFilter());
  },

  clearClassFilter() {
    this.setData(
      { classKeyword: '', classSchool: '', classDept: '', classGrade: '', classSchoolIndex: 0, classDeptIndex: 0, classGradeIndex: 0 },
      () => this.applyClassFilter()
    );
  },

  onClassSheetVisible(e) {
    this.setData({ classSheetVisible: !!(e.detail && e.detail.visible) });
  },

  closeClassSheet() {
    this.setData({ classSheetVisible: false });
  },

  onClassDraftChange(e) {
    const value = Array.isArray(e.detail) ? e.detail : (e.detail && e.detail.value) || [];
    this.setData({ classDraft: value });
  },

  // 保存班主任班级（多选；清空 = 取消班主任）
  async saveHomeroomClasses() {
    if (this.data.classSaving) return;
    this.setData({ classSaving: true });
    try {
      const r = await auth.put(`/api/admin/users/${this.data.id}/class-roles`, { homeroomClasses: this.data.classDraft });
      const list = r.homeroomClasses || [];
      this.setData({ homeroomClasses: list, classSheetVisible: false });
      wx.showToast({ title: list.length ? `已分配 ${list.length} 个班` : '已取消班主任', icon: 'none' });
    } catch (err) {
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ classSaving: false });
    }
  },

  // 班委开关（学生）：即时保存，失败回滚。
  // 两条写路径（用户 2026-10-24「班主任在班级 TAB 没有配置班委的权限」）：
  //   · 管理员（user.manage）→ PUT /api/admin/users/:id/class-roles
  //   · 本班班主任 → PUT /api/class/student/:id/officer（成员资格校验，服务端同一份 class-roles 实现）
  // 按钮显隐由 caps.classOfficer 控制（服务端下发），这里只管选 URL。
  async onOfficerChange(e) {
    const value = !!(e.detail && e.detail.value);
    if (this.data.officerSaving) return;
    const prev = this.data.isClassOfficer;
    this.setData({ isClassOfficer: value, officerSaving: true });
    try {
      if (this.data.canManageClass) {
        await auth.put(`/api/admin/users/${this.data.id}/class-roles`, { isClassOfficer: value });
      } else {
        const { head, q } = this.apiFor('account'); // 班主任 → 班级域
        await auth.put(`${head}/officer${q}`, { isClassOfficer: value });
      }
      wx.showToast({ title: value ? '已设为班委（可管本班宿舍/卫生区/教室）' : '已取消班委', icon: 'none' });
    } catch (err) {
      this.setData({ isClassOfficer: prev });
      wx.showToast({ title: err.message || '设置失败', icon: 'none' });
    } finally {
      this.setData({ officerSaving: false });
    }
  },

  // ===== 徽章：手工发放 / 回收 =====
  // 管理端要 badge.manage；班主任（班级域）对本班学生也可发/收（用户 2026-10-22）。
  // 打开发放抽屉（先拉「全部启用中的定义 + 已获得」，再渲染）
  openBadgeSheet() {
    if (!this.data.canManageBadges && !this.data.canManageStudent) {
      wx.showToast({ title: '需要「发放与回收徽章」权限', icon: 'none' });
      return;
    }
    this.setData({ badgeSheetVisible: true });
    this.loadBadgeSheet();
  },

  closeBadgeSheet() {
    this.setData({ badgeSheetVisible: false });
  },

  onBadgeSheetVisible(e) {
    this.setData({ badgeSheetVisible: !!(e.detail && e.detail.visible) });
  },

  // 拉徽章定义与已获得列表 → 组装抽屉（等级组按组折叠，保留上一轮展开状态）
  async loadBadgeSheet() {
    const { head, q } = this.apiFor('badges');
    this.setData({ badgeSheetLoading: true });
    try {
      const r = await auth.get(`${head}/badges${q}`);
      this.applyBadgeCount((r && r.list) || []);
      this.setData({ badgeItems: buildBadgeItems((r && r.definitions) || [], this.data.badgeItems) });
    } catch (e) {
      wx.showToast({ title: e.message || '徽章加载失败', icon: 'none' });
    } finally {
      this.setData({ badgeSheetLoading: false });
    }
  },

  // 等级组展开 / 收起
  toggleBadgeGroup(e) {
    const group = e.currentTarget.dataset.group;
    if (!group) return;
    this.setData({
      badgeItems: (this.data.badgeItems || []).map((it) =>
        it.kind === 'group' && it.tierGroup === group ? { ...it, expanded: !it.expanded } : it
      ),
    });
  },

  // 发放（幂等：重复发放不会重复记录，服务端返回 granted=false）
  async grantBadge(e) {
    const { key, name } = e.currentTarget.dataset;
    if (!key || this.data.badgeGranting) return;
    const hit = findBadgeItem(this.data.badgeItems, key);
    if (hit && hit.earned) {
      wx.showToast({ title: `「${name || key}」已获得`, icon: 'none' });
      return;
    }
    this.setData({ badgeGranting: key });
    try {
      const { head, q } = this.apiFor('badges');
      const r = await auth.post(`${head}/badges${q}`, { badgeKey: key });
      wx.showToast({ title: r && r.granted ? `已发放「${name || key}」` : `「${name || key}」已获得`, icon: 'none' });
      this.applyBadgeCount((r && r.list) || []);
      await this.loadBadgeSheet();
    } catch (err) {
      wx.showToast({ title: err.message || '发放失败', icon: 'none' });
    } finally {
      this.setData({ badgeGranting: '' });
    }
  },

  // 回收（删除获得记录）：必须二次确认，文案写清「再次满足条件会自动重新获得」
  revokeBadge(e) {
    const { key, name } = e.currentTarget.dataset;
    if (!key) return;
    const that = this;
    wx.showModal({
      title: '回收徽章',
      content: `确认回收「${name || key}」？回收 = 删除该获得记录，回收后用户再次满足条件会自动重新获得（解封/到期不会自动恢复）。`,
      confirmText: '回收',
      confirmColor: '#e5484d',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const { head, q } = that.apiFor('badges');
          const r = await auth.del(`${head}/badges/${encodeURIComponent(key)}${q}`);
          wx.showToast({ title: r && r.revoked ? '已回收' : '该用户未获得此徽章', icon: 'none' });
          that.applyBadgeCount((r && r.list) || []);
          if (that.data.badgeSheetVisible) await that.loadBadgeSheet();
        } catch (err) {
          wx.showToast({ title: err.message || '回收失败', icon: 'none' });
        }
      },
    });
  },

  // 发放 / 回收后的本地同步：身份卡与「徽章」计数更新，徽章 Tab 的已获得快照失效
  // （正在看徽章 Tab 时立即重拉；否则切回该 Tab 时再拉，避免打乱当前 Tab 的分页状态）
  applyBadgeCount(list) {
    const count = Array.isArray(list) ? list.length : null;
    const patch = { records: { ...this.data.records, badges: [] } };
    if (count != null) {
      patch.recordTotals = { ...this.data.recordTotals, badges: count };
      if (this.data.sport) patch['sport.badgeCount'] = count;
    }
    this.setData(patch);
    if (this.data.recordTab === 'badges') this.loadRecords('badges', 1);
  },

  // ===== 宿舍：按学生绑定房间（权威数据 dorm_assignments，混宿一间房可住几个班）=====
  // 录入形态**与「班级管理 → 宿舍」共用同一个组件**（主包 components/dorm-sheet）：
  // 单栏「宿舍号（楼号·门号）」+ 可选「床位号」+ 楼栋 / 已有房间快捷 + 退宿 / 保存。
  // 写接口 PUT/DELETE /api/admin/users/:id/dorm，服务端 requirePermission('user.manage')。
  // 写权限沿用本页既有写接口的判定（canManageUser = user.manage，服务端同名 requirePermission 拦截）
  // ===== 加入学生会二维码（用户 2026-10-22）=====
  // 学生在自己主页出示二维码，干部用「扫码加人」扫它 → 一次性凭证，10 分钟有效。
  //
  // ⚠️ 这里的接口是 /api/union/invite/mine —— 它按**当前登录者**发凭证。
  //   管理端在别人主页上打开本页时，拿到的是**管理员自己**的凭证，不是这个学生的！
  //   所以：本页只负责「展示这个学生是谁」，凭证必须由学生本人在自己的小程序里取。
  //   为了让管理员也能生成给学生用的码，接口支持传 userId（管理员有 union.manage 时放行）。
  async openInviteQr() {
    this.setData({ qrVisible: true, qrLoading: true, qrError: '' });
    await this.loadInviteQr();
  },

  async loadInviteQr() {
    this.setData({ qrLoading: true, qrError: '' });
    try {
      const res = await auth.get(`/api/union/invite/mine?userId=${encodeURIComponent(this.data.id)}`);
      const exp = res && res.expiresAt ? new Date(res.expiresAt) : null;
      const pad = (n) => String(n).padStart(2, '0');
      const expiresText = exp
        ? `${pad(exp.getMonth() + 1)}-${pad(exp.getDate())} ${pad(exp.getHours())}:${pad(exp.getMinutes())}`
        : '';
      this.setData({
        qrLoading: false,
        qr: {
          token: (res && res.token) || '',
          // 后端生成的二维码 PNG dataURL；空 = 生成失败，页面回退显示凭证串
          qrImage: (res && res.qrImage) || '',
          expiresText,
          realName: (res && res.realName) || '',
          studentId: (res && res.studentId) || '',
          className: (res && res.className) || '',
        },
      });
    } catch (e) {
      this.setData({ qrLoading: false, qrError: e.message || '生成失败' });
    }
  },

  // 重新生成：旧凭证仍在服务端有效期内，但这里换一张新的更方便现场展示
  async refreshInviteQr() {
    if (this.data.qrLoading) return;
    await this.loadInviteQr();
  },

  closeInviteQr() {
    this.setData({ qrVisible: false });
  },

  async openDormSheet() {
    // 能不能排宿舍**只看服务端下发的 caps.dorm**（用户 2026-10-24 报「班委在用户详情里排不了宿舍」）：
    //   · 管理员 → user.manage
    //   · 班主任 → 班级域 capabilities.dorm
    //   · 班委   → 同样为 true（宿舍是班级事务，班委的本职工作就是查宿）
    // 之前这里判断的是 canManageUser || canManageStudent —— 班委两个都是 false，
    // 于是 WXML 按 caps.dorm 把入口画出来了、一点却弹「只有班主任或管理员可以安排宿舍」。
    // 同一个能力两处各判一遍，必然漂移（AGENTS.md：能力只有一份来源）。
    if (!this.data.caps.dorm) {
      wx.showToast({ title: '只有班主任、班委或管理员可以安排宿舍', icon: 'none' });
      return;
    }
    const d = this.data.dorm || null;
    this.setData({
      dormSheetVisible: true,
      // 是否已绑微信：班级域下 loginInfo 不拉、user 文档也不带 openid，
      // 若在这里用它们重算会把服务端下发的 true 覆盖成 false → 抽屉直接禁用
      // （用户 2026-10-24「班委排宿舍」链路上的第二处卡点）。
      // 班级域一律沿用服务端给的 dormSrc.wechatBound；管理端才按本地已知字段算。
      dormWechatBound: this.data.classOnly
        ? this.data.dormWechatBound
        : !!this.data.user.openid || !!(this.data.loginInfo && this.data.loginInfo.wechatBound),
      dormForm: { roomText: d && d.roomText ? d.roomText : '', bedNo: (d && d.bedNo) || '' },
      dormSheetCanUnbind: !!(d && d.roomText),
    });
    // 快捷候选（楼栋 + 本班已住房间）：打开时才取一次。
    // ⚠️ 楼名清单**跟着宿舍接口一起下发**，不再单独请求 /api/admin/config/buildings ——
    //    那条路径要 building.view / config.view（宿管维护楼名的权限），教师权限组没有，
    //    于是班主任明明要给学生排宿舍，却选不到楼（用户 2026-10-22 报的就是这个）。
    if (!this.data.dormBuildings.length && !this.data.dormQuickRooms.length) {
      this.setData({ dormSheetLoading: true });
      try {
        const { head, q } = this.apiFor('dorm');
        const r = await auth.get(`${head}/dorm${q}`);
        // 服务端已把「系统设置里的宿舍楼 ∪ 历史出现过的楼」合并好（管理端与班级域同一份实现）
        const hist = (r && r.buildings) || [];
        this.setData({
          dormBuildings: hist,
          dormQuickRooms: (r && r.quickRooms) || [],
          dormWechatBound: !!(r && r.wechatBound),
        });
      } catch (e) {
        wx.showToast({ title: e.message || '宿舍候选加载失败', icon: 'none' });
      } finally {
        this.setData({ dormSheetLoading: false });
      }
    }
  },

  closeDormSheet() {
    this.setData({ dormSheetVisible: false });
  },

  // 受控回灌：组件内的输入与楼栋 / 已有房间快捷点击都只抛 change，值由页面持有
  onDormFormChange(e) {
    const { field, value } = (e.detail || {});
    if (field !== 'roomText' && field !== 'bedNo') return;
    this.setData({ [`dormForm.${field}`]: value });
  },

  // 绑定 / 改绑：房间不存在由服务端自动建档，改绑把旧记录置「已换房」
  async submitDorm(e) {
    if (this.data.dormSaving) return;
    // 值以组件抛出的 detail 为准（组件已 trim）；页面 state 只作回灌
    const detail = (e && e.detail) || {};
    const label = String(detail.roomText || this.data.dormForm.roomText || '').trim();
    const bedNo = String(detail.bedNo || this.data.dormForm.bedNo || '').trim();
    if (!label) {
      wx.showToast({ title: '请填写宿舍号，如 1号楼·201', icon: 'none' });
      return;
    }
    if (!this.data.dormWechatBound) {
      wx.showToast({ title: '该学生还没绑定微信，无法记录住宿', icon: 'none' });
      return;
    }
    this.setData({ dormSaving: true });
    try {
      const { head, q } = this.apiFor('dorm');
      const r = await auth.put(`${head}/dorm${q}`, { roomLabel: label, bedNo });
      const extra = r && r.createdRoom ? '（已新建房间）' : r && r.movedFrom ? `（原 ${r.movedFrom}）` : '';
      wx.showToast({ title: `已绑定 ${r.room || label}${extra}`, icon: 'none' });
      // 新建的房间 / 新楼栋要出现在下次打开的快捷里：清空候选缓存，下次 openDormSheet 重取
      this.setData({ dormSheetVisible: false, dormSaving: false, dormBuildings: [], dormQuickRooms: [] });
      this.applyDorm({ roomText: r.room || '', roomId: r.roomId || '', bedNo: (r.bedNo || '').trim() });
    } catch (e2) {
      this.setData({ dormSaving: false });
      // 服务端明确文案（如「该学生还没绑定微信，暂时无法记录住宿」）直接透出，别吞成「操作失败」
      wx.showToast({ title: e2.message || '绑定失败', icon: 'none' });
    }
  },

  // 退宿：在住记录置 checked_out，历史保留，之后可重新绑定（组件只在 canUnbind 为真时抛事件）
  unbindDorm() {
    // 与 openDormSheet 同一口径：只认服务端下发的 caps.dorm（管理员 / 班主任 / 班委）
    if (!this.data.caps.dorm) {
      wx.showToast({ title: '只有班主任、班委或管理员可以安排宿舍', icon: 'none' });
      return;
    }
    const that = this;
    // 文案取「当前在住」的房间（dorm），不取输入框里的未保存值，避免确认后写着没生效的房号
    const cur = (that.data.dorm || {}).roomText || '';
    wx.showModal({
      title: '退宿',
      content: cur
        ? `确认把「${cur}」标记为退宿？历史记录保留，之后可重新绑定。`
        : '当前没有在住记录，无需退宿。',
      confirmColor: '#e5484d',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const { head, q } = that.apiFor('dorm');
          const r = await auth.del(`${head}/dorm${q}`);
          wx.showToast({ title: r && r.checkedOut ? '已退宿' : (r && r.reason) || '当前没有在住记录', icon: 'none' });
          that.setData({ dormSheetVisible: false, dormBuildings: [], dormQuickRooms: [] });
          if (r && r.checkedOut) await that.applyDorm(null);
        } catch (err) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      },
    });
  },

  // 绑定 / 退宿后的本地同步：不再整页重拉，只改宿舍那一行（含退宿按钮可用态与抽屉副标题）
  async applyDorm(dorm) {
    const row = dorm || null;
    const text = row && row.roomText
      ? `${row.roomText}${row.bedNo ? `（${row.bedNo} 床）` : ''}`
      : '未分配';
    this.setData({
      dorm: row,
      dormText: text,
      dormSheetSub: `${(this.data.user && this.data.user.className) || '未分班'} · ${text}`,
      dormForm: { roomText: row && row.roomText ? row.roomText : '', bedNo: (row && row.bedNo) || '' },
      dormSheetCanUnbind: !!(row && row.roomText),
    });
  },

  /**
   * 密码变更（用户 2026-10-26：「重置密码」改称「密码变更」，点开有两个动作）。
   *
   *   ① 恢复初始密码 —— 教师 123456 / 学生 学号后8位或身份证后8位
   *   ② 设置密码     —— 管理员直接指定新密码（不强制改密，旧初始密码立即失效）
   *
   * 用**自己的 t-popup 选择层**而不是 wx.showActionSheet（用户 2026-10-26：「这个也太难看了」）：
   *   · ActionSheet 是微信原生控件，样式完全不可控 —— 白底黑字、行高巨大，
   *     而且「恢复初始密码（教师 123456 / 学生 学号·身份证后8位）」这种长说明塞进
   *     itemList 必然折成两行，视觉上很难看（截图正是这个形态）；
   *   · 改成项目统一的 .tt-sheet 弹层：主标题 + 两个带副说明的选项卡片，与全站风格一致。
   *
   * 权限来源仍是服务端：管理端 permission.manage，或本班班主任（caps.resetPassword 由服务端下发）。
   */
  changePassword() {
    if (!this.data.caps.resetPassword) return;
    const u = this.data.user || {};
    this.setData({
      pwdMenuVisible: true,
      pwdIsTeacher: u.role === 'teacher',
    });
  },

  closePwdMenu() {
    this.setData({ pwdMenuVisible: false });
  },

  onPwdMenuVisible(e) {
    if (!(e.detail && e.detail.visible)) this.closePwdMenu();
  },

  // 选择层里的两个动作（data-act 区分）
  onPwdMenuPick(e) {
    const act = (e.currentTarget && e.currentTarget.dataset.act) || '';
    this.setData({ pwdMenuVisible: false });
    if (act === 'initial') this.restoreInitialPassword();
    else if (act === 'set') this.openPwdSheet();
  },

  // 动作一：恢复初始密码
  restoreInitialPassword() {
    const that = this;
    const isTeacher = (this.data.user && this.data.user.role) === 'teacher';
    wx.showModal({
      title: '恢复初始密码',
      content: isTeacher
        ? '将把该教师账号的密码恢复为 123456，并要求其下次登录时修改。确认恢复？'
        : '将把该学生账号的密码恢复为名单初始密码（学号后8位 / 身份证后8位），并要求其下次登录时修改。确认恢复？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const { head, q } = that.apiFor('account');
          const r = await auth.post(`${head}/reset-password${q}`, { mode: 'initial' });
          wx.showModal({ title: '已恢复', content: r.message, showCancel: false });
          that.load();
        } catch (err) {
          // 没有名单初始密码数据的账号会走到这里（服务端明确报错，让管理员改用「设置新密码」）
          wx.showModal({ title: '无法恢复', content: err.message, showCancel: false });
        }
      },
    });
  },

  // 动作二：设置新密码（打开弹层）
  openPwdSheet() {
    if (!this.data.caps.resetPassword) return;
    const u = this.data.user || {};
    this.setData({
      pwdSheetVisible: true,
      pwdTargetName: u.realName || u.nickname || u.account || '该账号',
      pwdForm: { password: '', confirm: '' },
      pwdStrength: this.computePwdStrength(''),
      pwdSaving: false,
    });
  },

  closePwdSheet() {
    this.setData({ pwdSheetVisible: false, pwdForm: { password: '', confirm: '' }, pwdSaving: false });
  },

  onPwdSheetVisible(e) {
    if (!(e.detail && e.detail.visible)) this.closePwdSheet();
  },

  onPwdInput(e) {
    const field = (e.currentTarget && e.currentTarget.dataset.field) || '';
    if (field !== 'password' && field !== 'confirm') return;
    const patch = { [`pwdForm.${field}`]: e.detail.value };
    // 只在改「新密码」时更新强度提示（确认框的输入不参与强度计算）
    if (field === 'password') patch.pwdStrength = this.computePwdStrength(e.detail.value);
    this.setData(patch);
  },

  // 强度提示（与服务端 pwd.validateNewPassword 同口径；额外建议字母+数字，但不拦提交）
  computePwdStrength(pwd) {
    const s = String(pwd || '');
    if (!s) return { cls: '', icon: 'info-circle', color: 'var(--tt-text-3)', text: '6-20 位，建议字母 + 数字组合' };
    if (s.length < 6) return { cls: 'is-weak', icon: 'error-circle', color: 'var(--td-error-color-6)', text: '至少 6 位' };
    if (s.length > 20) return { cls: 'is-weak', icon: 'error-circle', color: 'var(--td-error-color-6)', text: '最多 20 位' };
    const hasLetter = /[A-Za-z]/.test(s);
    const hasDigit = /\d/.test(s);
    if (hasLetter && hasDigit && s.length >= 8) {
      return { cls: 'is-strong', icon: 'check-circle', color: 'var(--td-success-color-5)', text: '强度良好' };
    }
    return { cls: 'is-ok', icon: 'info-circle', color: 'var(--td-warning-color-6)', text: '可用；字母 + 数字且 8 位以上更安全' };
  },

  async submitPwd() {
    if (this.data.pwdSaving) return;
    const { password, confirm } = this.data.pwdForm || {};
    if (password.length < 6 || password.length > 20) {
      wx.showToast({ title: '新密码需为 6-20 位', icon: 'none' });
      return;
    }
    if (password !== confirm) {
      wx.showToast({ title: '两次输入的密码不一致', icon: 'none' });
      return;
    }
    this.setData({ pwdSaving: true });
    try {
      const { head, q } = this.apiFor('account');
      const r = await auth.post(`${head}/reset-password${q}`, { mode: 'set', password });
      this.setData({ pwdSheetVisible: false, pwdSaving: false, pwdForm: { password: '', confirm: '' } });
      wx.showModal({
        title: '密码已设置',
        content: `${r.message || '设置成功'}。请把新密码告知该用户，旧初始密码已失效。`,
        showCancel: false,
      });
      this.load();
    } catch (err) {
      this.setData({ pwdSaving: false });
      wx.showToast({ title: err.message || '设置失败', icon: 'none', duration: 2500 });
    }
  },
});
