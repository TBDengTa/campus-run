/**
 * 1.0 → 2.0 数据迁移脚本
 *
 * 用法（先在 server/.env 配置新旧库连接）：
 *   npm run migrate:dry   # 试运行，只统计不写入
 *   npm run migrate       # 正式迁移
 *
 * 说明：
 * - 旧库自造的 32 位 hex _id 全部重新生成为 ObjectId，引用字段（userId/banRecordId/
 *   planId/parentId/sponsorId/pageId/contentId）通过内存映射重写
 * - 字段统一：_openid→openid，created_at→createdAt，距离统一为米，时间统一为 Date
 * - 丢弃：pay_orders / plan_config / beidou_plans 及空废弃表（classes/schools/
 *   departments/ads/banned_users_records/goal_rules）
 * - 激励视频、用户徽章按 openid+key 去重合并
 */

const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const DRY_RUN = process.argv.includes('--dry-run');
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGO_DB_NAME || 'campus_run';
const LEGACY_URI = process.env.LEGACY_MONGO_URI || MONGO_URI;
const LEGACY_DB = process.env.LEGACY_MONGO_DB_NAME || 'tangtang_run';

const report = { collections: {}, warnings: [] };
const log = (...a) => console.log(...a);
const warn = (msg) => {
  report.warnings.push(msg);
  console.warn('  [警告]', msg);
};

function toDate(v, fallback = null) {
  if (v == null) return fallback;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? fallback : d;
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

// 旧库距离单位为 km，统一转米；已 >= 1000 的视为已是米不再转换
function kmToM(v) {
  const n = toNum(v, 0);
  if (!n) return 0;
  return n < 1000 ? Math.round(n * 1000) : Math.round(n);
}

// "mm:ss" / "hh:mm:ss" → 秒
function durationToSeconds(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return Math.round(v);
  const parts = String(v).split(':').map((p) => parseInt(p, 10) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

async function drain(cur) {
  const out = [];
  await cur.forEach((d) => out.push(d));
  return out;
}

async function bulkInsert(target, docs, name) {
  if (!docs.length) return 0;
  if (DRY_RUN) return docs.length;
  let inserted = 0;
  for (let i = 0; i < docs.length; i += 2000) {
    const batch = docs.slice(i, i + 2000).map((d) => ({ insertOne: { document: d } }));
    try {
      const r = await target.bulkWrite(batch, { ordered: false });
      inserted += r.insertedCount;
    } catch (e) {
      // 重复键等单条失败不中断
      inserted += e.result ? e.result.insertedCount || 0 : 0;
      if (!/duplicate key/i.test(e.message)) warn(`${name} 批量写入异常：${e.message}`);
    }
  }
  return inserted;
}

// ---------- 默认徽章（旧徽章无法解析映射时使用） ----------
const DEFAULT_BADGES = [
  { key: 'first_run', name: '初次奔跑', description: '完成第一次跑步打卡', type: 'total_days', target: 1, sort: 1 },
  { key: 'steps_100k', name: '十万步', description: '累计步数达到 100,000', type: 'total_steps', target: 100000, sort: 2 },
  { key: 'steps_500k', name: '五十万步', description: '累计步数达到 500,000', type: 'total_steps', target: 500000, sort: 3 },
  { key: 'steps_1m', name: '百万步传说', description: '累计步数达到 1,000,000', type: 'total_steps', target: 1000000, sort: 4 },
  { key: 'single_20k', name: '两万步勇士', description: '单日步数达到 20,000', type: 'single_steps', target: 20000, sort: 5 },
  { key: 'single_5km', name: '五公里达成', description: '单次跑步距离达到 5 公里', type: 'single_distance', target: 5000, sort: 6 },
  { key: 'days_7', name: '坚持一周', description: '累计打卡 7 天', type: 'total_days', target: 7, sort: 7 },
  { key: 'days_30', name: '坚持一月', description: '累计打卡 30 天', type: 'total_days', target: 30, sort: 8 },
  { key: 'days_100', name: '百日坚持', description: '累计打卡 100 天', type: 'total_days', target: 100, sort: 9 },
  { key: 'streak_7', name: '七日连击', description: '连续打卡 7 天', type: 'streak_days', target: 7, sort: 10 },
];

const BADGE_TYPE_MAP = {
  // 旧库真实 conditionType：login_days 登录/打卡天数，achievement_count 达标天数
  login_days: 'total_days',
  achievement_count: 'goal_days',
  // 2.0 类型与可能的旧别名
  total_steps: 'total_steps',
  total_distance: 'total_distance',
  total_days: 'total_days',
  goal_days: 'goal_days',
  single_steps: 'single_steps',
  single_distance: 'single_distance',
  streak_days: 'streak_days',
};

async function main() {
  const t0 = Date.now();
  log(`\n========= 唐唐快跑 1.0 → 2.0 迁移${DRY_RUN ? '（试运行，不写入）' : ''} =========`);
  log(`旧库: ${LEGACY_DB}  →  新库: ${DB_NAME}\n`);

  const legacy = new MongoClient(LEGACY_URI, { serverSelectionTimeoutMS: 10000 });
  const target = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  await legacy.connect();
  await target.connect();
  const L = legacy.db(LEGACY_DB);
  const T = target.db(DB_NAME);

  const count = async (name) => await L.collection(name).countDocuments();

  // ---------- 0. 旧库概览 ----------
  const legacyCollections = (await L.listCollections().toArray()).map((c) => c.name);
  log('—— 旧库集合概览 ——');
  for (const name of legacyCollections.sort()) {
    log(`  ${name}: ${await count(name)}`);
  }

  // ---------- 1. users ----------
  log('\n—— 迁移 users ——');
  const usersCol = T.collection('users');
  const oldUsers = await drain(L.collection('users').find({}));
  // role 分布
  const roleDist = {};
  for (const u of oldUsers) {
    const r = String(u.role || 'user');
    roleDist[r] = (roleDist[r] || 0) + 1;
  }
  log('  旧 role 分布:', JSON.stringify(roleDist));

  const userIdMap = new Map(); // 旧 _id → 新 ObjectId
  const openidMap = new Map(); // openid → 新 ObjectId（去重后）
  const usersDocs = [];
  const seenOpenid = new Map();
  let skippedNoOpenid = 0;
  for (const u of oldUsers) {
    const openid = u._openid || u.boundOpenid;
    if (!openid) {
      skippedNoOpenid += 1;
      continue;
    }
    const prev = seenOpenid.get(openid);
    const uTime = toDate(u.updatedAt || u.createdAt, new Date(0)).getTime();
    if (prev && prev._t >= uTime) continue;
    seenOpenid.set(openid, { ...u, _t: uTime });
  }
  if (skippedNoOpenid) {
    log(`  旧库 ${skippedNoOpenid} 个档案未关联微信 openid（未注册/匿名），跳过`);
  }
  for (const u of seenOpenid.values()) {
    const openid = u._openid || u.boundOpenid;
    const newId = new ObjectId();
    userIdMap.set(String(u._id), newId);
    openidMap.set(openid, newId);
    const banned = u.banned === true;
    // 2.0 角色：student/teacher；旧 admin → 教师 + 超级管理员权限组
    const wasAdmin = u.role && u.role !== 'user' && u.role !== 'student';
    const role = wasAdmin ? 'teacher' : 'student';
    let avatarUrl = u.avatarUrl || '';
    if (typeof avatarUrl === 'string' && avatarUrl.startsWith('data:') && avatarUrl.length > 2000) {
      avatarUrl = ''; // 内联 base64 头像不入库
    }
    usersDocs.push({
      _id: newId,
      openid,
      nickname: u.nickName || u.nickname || '',
      avatarUrl,
      realName: u.realName || '',
      studentId: u.studentId || '',
      schoolId: null, // 组织重映射阶段回填
      schoolName: u.school || u.schoolName || '',
      departmentId: null,
      departmentName: u.department || u.departmentName || '',
      className: u.className || '',
      specialty: u.specialty || '',
      gender: toNum(u.gender, 0) || 0,
      birthdate: toDate(u.birthdate),
      role,
      permissionGroups: wasAdmin ? ['superadmin'] : [],
      permissions: [],
      status: banned ? 'banned' : 'active',
      banReason: u.banReason || '',
      banType: u.banType || '',
      bannedUntil: toDate(u.bannedUntil),
      bannedAt: toDate(u.bannedAt),
      createdAt: toDate(u.createdAt, new Date()),
      updatedAt: toDate(u.updatedAt, new Date()),
    });
  }
  report.collections.users = await bulkInsert(usersCol, usersDocs, 'users');
  log(`  users: ${report.collections.users}/${usersDocs.length}`);

  // ---------- 2. wx_sessions（session_keys + users.sessionKey 合并） ----------
  log('—— 迁移 wx_sessions ——');
  const wxDocs = new Map();
  for (const s of await drain(L.collection('session_keys').find({}))) {
    if (s._id && s.sessionKey) wxDocs.set(String(s._id), { sessionKey: s.sessionKey, updatedAt: toDate(s.updatedAt) });
  }
  for (const u of oldUsers) {
    const openid = u._openid || u.boundOpenid;
    if (openid && u.sessionKey && !wxDocs.has(openid)) {
      wxDocs.set(openid, { sessionKey: u.sessionKey, updatedAt: toDate(u.sessionKeyUpdatedAt) });
    }
  }
  const wxSessions = [...wxDocs.entries()].map(([openid, v]) => ({
    openid,
    sessionKey: v.sessionKey,
    updatedAt: v.updatedAt || new Date(),
  }));
  report.collections.wx_sessions = await bulkInsert(T.collection('wx_sessions'), wxSessions, 'wx_sessions');
  log(`  wx_sessions: ${report.collections.wx_sessions}/${wxSessions.length}`);

  // ---------- 3. run_records ----------
  log('—— 迁移 run_records ——');
  const runDocs = [];
  await L.collection('run_records').find({}).forEach((r) => {
    const openid = r._openid;
    if (!openid) return;
    runDocs.push({
      openid,
      source: r.source === 'run' || r.source === 'gps' ? 'gps' : 'werun',
      date: r.date,
      steps: toNum(r.steps, 0),
      distance: kmToM(r.distance),
      calories: toNum(r.calories, 0),
      durationSeconds: r.durationSeconds != null ? toNum(r.durationSeconds, 0) : durationToSeconds(r.duration),
      pace: r.pace || '',
      goalAchieved: r.goalAchieved === true,
      startTime: toDate(r.startTime),
      endTime: toDate(r.endTime),
      routePoints: Array.isArray(r.routePoints) ? r.routePoints : undefined,
      location: r.location || '',
      createdAt: toDate(r.createdAt, new Date()),
      updatedAt: toDate(r.updatedAt, new Date()),
    });
  });
  report.collections.run_records = await bulkInsert(T.collection('run_records'), runDocs, 'run_records');
  log(`  run_records: ${report.collections.run_records}/${runDocs.length}`);

  // ---------- 4. beidouRecords → reward_video_records（按 openid+date 聚合） ----------
  log('—— 迁移 reward_video_records ——');
  const rvAgg = await L
    .collection('beidouRecords')
    .aggregate([
      {
        $group: {
          _id: { openid: '$_openid', date: '$date' },
          watchCount: { $sum: { $toDouble: { $ifNull: ['$watchCount', 0] } } },
          stepsEarned: { $sum: { $toDouble: { $ifNull: ['$earnedSteps', 0] } } },
          createdAt: { $min: '$createdAt' },
        },
      },
    ])
    .toArray();
  const rvDocs = rvAgg
    .filter((g) => g._id && g._id.openid)
    .map((g) => ({
      openid: g._id.openid,
      date: g._id.date,
      watchCount: Math.round(g.watchCount),
      stepsEarned: Math.round(g.stepsEarned),
      createdAt: toDate(g.createdAt, new Date()),
      updatedAt: toDate(g.createdAt, new Date()),
    }));
  report.collections.reward_video_records = await bulkInsert(
    T.collection('reward_video_records'),
    rvDocs,
    'reward_video_records'
  );
  log(`  reward_video_records: ${report.collections.reward_video_records}/${rvDocs.length}`);

  // ---------- 5. ban_history → ban_records ----------
  log('—— 迁移 ban_records ——');
  const banIdMap = new Map();
  const banDocs = [];
  for (const b of await drain(L.collection('ban_history').find({}))) {
    const newId = new ObjectId();
    banIdMap.set(String(b._id), newId);
    const newUserId = userIdMap.get(String(b.userId)) || null;
    if (!newUserId) warn(`ban_history ${b._id} 找不到对应用户 userId=${b.userId}`);
    banDocs.push({
      _id: newId,
      userId: newUserId,
      openid: b.openid || '',
      action: b.action === 'unban' ? 'unban' : 'ban',
      banType: b.banType || 'sync',
      reason: b.reason || '',
      durationDays: toNum(b.duration, 0),
      bannedUntil: toDate(b.bannedUntil),
      operator: 'system',
      createdAt: toDate(b.createdAt, new Date()),
      updatedAt: toDate(b.createdAt, new Date()),
    });
  }
  // 用 users 映射回填 openid
  for (const doc of banDocs) {
    if (doc.userId) {
      const found = usersDocs.find((u) => String(u._id) === String(doc.userId));
      if (found) doc.openid = found.openid;
    }
    if (!doc.openid) doc.openid = '';
  }
  report.collections.ban_records = await bulkInsert(T.collection('ban_records'), banDocs, 'ban_records');
  log(`  ban_records: ${report.collections.ban_records}/${banDocs.length}`);

  // ---------- 6. appeals ----------
  log('—— 迁移 appeals ——');
  const appealDocs = [];
  for (const a of await drain(L.collection('appeals').find({}))) {
    const status = ['pending', 'approved', 'rejected'].includes(a.status) ? a.status : 'pending';
    appealDocs.push({
      openid: a._openid || '',
      banRecordId: a.banRecordId ? banIdMap.get(String(a.banRecordId)) || null : null,
      studentId: a.studentId || '',
      realName: a.realName || '',
      banReason: a.banReason || '',
      content: a.content || '',
      status,
      reply: a.reply || '',
      reviewedBy: a.reviewedBy || '',
      reviewedAt: toDate(a.reviewedAt),
      createdAt: toDate(a.createdAt, new Date()),
      updatedAt: toDate(a.updatedAt, new Date()),
    });
  }
  report.collections.appeals = await bulkInsert(T.collection('appeals'), appealDocs, 'appeals');
  log(`  appeals: ${report.collections.appeals}/${appealDocs.length}`);

  // ---------- 7. body_data ----------
  log('—— 迁移 body_data ——');
  const bodyDocs = [];
  for (const b of await drain(L.collection('body_data').find({}))) {
    if (!b.openid) continue;
    bodyDocs.push({
      openid: b.openid,
      height: toNum(b.height, 0) || null,
      weight: toNum(b.weight, 0) || null,
      bmi: toNum(b.bmi, 0) || null,
      bmiLevel: b.bmiLevel || '',
      preferenceLevel: ['relaxed', 'moderate', 'intense'].includes(b.preferenceLevel) ? b.preferenceLevel : 'moderate',
      createdAt: toDate(b.updatedAt, new Date()),
      updatedAt: toDate(b.updatedAt, new Date()),
    });
  }
  report.collections.body_data = await bulkInsert(T.collection('body_data'), bodyDocs, 'body_data');
  log(`  body_data: ${report.collections.body_data}/${bodyDocs.length}`);

  // ---------- 8. goal_plans（重新生成 _id，idmap 供 user_plans 回填） ----------
  log('—— 迁移 goal_plans ——');
  const planIdMap = new Map();
  const planDocs = [];
  for (const p of await drain(L.collection('goal_plans').find({}))) {
    const newId = new ObjectId();
    planIdMap.set(String(p._id), newId);
    planDocs.push({
      _id: newId,
      name: p.name || '',
      gender: ['male', 'female', 'all'].includes(p.gender) ? p.gender : 'all',
      preferenceLevel: ['relaxed', 'moderate', 'intense'].includes(p.preferenceLevel) ? p.preferenceLevel : 'moderate',
      bmiMin: toNum(p.bmiMin, 0),
      bmiMax: toNum(p.bmiMax, 100),
      daily: {
        steps: toNum(p.dailySteps, 5000),
        distance: kmToM(p.dailyDistance) || 3000,
        calories: toNum(p.dailyCalories, 250),
        durationMinutes: toNum(p.dailyDuration, 45),
      },
      weekly: { steps: toNum(p.weeklySteps, 35000), distance: kmToM(p.weeklyDistance) || 21000 },
      enabled: p.enabled !== false,
      isDefault: p.isDefault === true,
      createdAt: toDate(p.createdAt, new Date()),
      updatedAt: toDate(p.updatedAt, new Date()),
    });
  }
  report.collections.goal_plans = await bulkInsert(T.collection('goal_plans'), planDocs, 'goal_plans');
  log(`  goal_plans: ${report.collections.goal_plans}/${planDocs.length}`);

  // user_plans → user_goals
  const ugDocs = [];
  for (const up of await drain(L.collection('user_plans').find({}))) {
    if (!up.openid) continue;
    const newPlanId = planIdMap.get(String(up.planId)) || null;
    ugDocs.push({
      openid: up.openid,
      planId: newPlanId,
      planName: up.planName || '',
      autoMatched: up.autoMatched !== false,
      createdAt: toDate(up.updatedAt, new Date()),
      updatedAt: toDate(up.updatedAt, new Date()),
    });
  }
  report.collections.user_goals = await bulkInsert(T.collection('user_goals'), ugDocs, 'user_goals');
  log(`  user_goals: ${report.collections.user_goals}/${ugDocs.length}`);

  // ---------- 9. water_intakes → water_records ----------
  log('—— 迁移 water_records ——');
  const waterDocs = [];
  for (const w of await drain(L.collection('water_intakes').find({}))) {
    if (!w._openid || !w.date) continue;
    const logs = (w.records || []).map((r) => ({
      time: toDate(r.time, new Date()),
      amount: toNum(r.amount, 0),
      type: r.type || '水',
    }));
    waterDocs.push({
      openid: w._openid,
      date: w.date,
      target: toNum(w.target, 2000),
      total: logs.reduce((s, l) => s + l.amount, 0),
      logs,
      createdAt: toDate(w.created_at || w.createdAt, new Date()),
      updatedAt: toDate(w.updated_at || w.updatedAt, new Date()),
    });
  }
  report.collections.water_records = await bulkInsert(T.collection('water_records'), waterDocs, 'water_records');
  log(`  water_records: ${report.collections.water_records}/${waterDocs.length}`);

  // ---------- 10. badges + user_badges ----------
  log('—— 迁移 badges ——');
  const oldBadges = await drain(L.collection('badges').find({}));
  const badgeIdMap = new Map(); // 旧 badge _id → 新 key
  let badgeDocs = [];
  for (const b of oldBadges) {
    const type = BADGE_TYPE_MAP[b.conditionType || b.type] || null;
    const target = toNum(b.conditionValue ?? b.target ?? b.value, 0);
    if (!type || !target) {
      warn(`badges "${b.name || b._id}" 无法映射(conditionType=${b.conditionType}, target=${target})，将整体使用默认徽章`);
      continue;
    }
    const key = String(b.key || b._id);
    badgeIdMap.set(String(b._id), key);
    badgeDocs.push({
      key,
      name: b.name || key,
      description: b.description || '',
      icon: b.imageUrl || b.icon || '',
      type,
      target,
      tierGroup: b.tierGroup || '',
      tierLevel: toNum(b.tierLevel, 0),
      tierColor: b.tierColor || '',
      sort: toNum(b.sortOrder ?? b.sort, 100),
      enabled: b.enabled !== false,
      createdAt: toDate(b.createdAt, new Date()),
      updatedAt: toDate(b.updatedAt, new Date()),
    });
  }
  if (badgeDocs.length === 0) {
    log('  旧徽章无法映射，使用 2.0 默认徽章定义');
    badgeDocs = DEFAULT_BADGES.map((b) => ({ ...b, createdAt: new Date(), updatedAt: new Date() }));
  }
  report.collections.badges = await bulkInsert(T.collection('badges'), badgeDocs, 'badges');
  log(`  badges: ${report.collections.badges}/${badgeDocs.length}`);

  const validKeys = new Set(badgeDocs.map((b) => b.key));
  const ubSeen = new Set();
  const ubDocs = [];
  for (const ub of await drain(L.collection('user_badges').find({}))) {
    const openid = ub._openid || ub.openid;
    let key = ub.badgeId || ub.badgeKey || ub.key;
    if (key && badgeIdMap.has(String(key))) key = badgeIdMap.get(String(key));
    if (!openid || !key) {
      warn(`user_badges 跳过字段缺失文档 ${ub._id || ''}`);
      continue;
    }
    if (!validKeys.has(String(key))) {
      warn(`user_badges 引用了未知徽章 key=${key}，跳过`);
      continue;
    }
    const dedupe = `${openid}|${key}`;
    if (ubSeen.has(dedupe)) continue;
    ubSeen.add(dedupe);
    ubDocs.push({
      openid,
      badgeKey: String(key),
      createdAt: toDate(ub.obtainedAt || ub.createdAt, new Date()),
    });
  }
  report.collections.user_badges = await bulkInsert(T.collection('user_badges'), ubDocs, 'user_badges');
  log(`  user_badges: ${report.collections.user_badges}/${ubDocs.length}`);

  // ---------- 11. organizations（重新生成 _id 并回填 parentId/用户所属） ----------
  log('—— 迁移 organizations ——');
  const orgIdMap = new Map();
  const oldOrgs = await drain(L.collection('organizations').find({}));
  for (const o of oldOrgs) orgIdMap.set(String(o._id), new ObjectId());
  const orgDocs = [];
  for (const o of oldOrgs) {
    if (!['school', 'department', 'specialty'].includes(o.type)) {
      warn(`organizations 跳过未知类型 type=${o.type} name=${o.name}`);
      continue;
    }
    const parentId = o.parentId ? orgIdMap.get(String(o.parentId)) || null : null;
    orgDocs.push({
      _id: orgIdMap.get(String(o._id)),
      name: o.name || '',
      type: o.type,
      parentId,
      parentName: o.parentName || '',
      sort: toNum(o.sort, 0),
      createdAt: toDate(o.createdAt, new Date()),
      updatedAt: toDate(o.updatedAt, new Date()),
    });
  }
  report.collections.organizations = await bulkInsert(T.collection('organizations'), orgDocs, 'organizations');
  log(`  organizations: ${report.collections.organizations}/${orgDocs.length}`);

  // 回填 users.schoolId/departmentId：按组织名称匹配（schoolName/departmentName 已带名字）
  if (!DRY_RUN && orgDocs.length) {
    const findOrg = (name, type) => orgDocs.find((o) => o.type === type && o.name === name);
    for (const u of usersDocs) {
      const s = u.schoolName && findOrg(u.schoolName, 'school');
      if (s) u.schoolId = s._id;
      const d = u.departmentName && findOrg(u.departmentName, 'department');
      if (d) u.departmentId = d._id;
    }
    const bulk = usersDocs.map((u) => ({
      updateOne: { filter: { _id: u._id }, update: { $set: { schoolId: u.schoolId, departmentId: u.departmentId } } },
    }));
    for (let i = 0; i < bulk.length; i += 2000) {
      await usersCol.bulkWrite(bulk.slice(i, i + 2000), { ordered: false });
    }
  }

  // class_monitors
  const cmDocs = [];
  for (const c of await drain(L.collection('class_monitors').find({}))) {
    if (!c.openid || !c.className) continue;
    cmDocs.push({ openid: c.openid, studentId: c.studentId || '', className: c.className });
  }
  report.collections.class_monitors = await bulkInsert(T.collection('class_monitors'), cmDocs, 'class_monitors');
  log(`  class_monitors: ${report.collections.class_monitors}/${cmDocs.length}`);

  // ---------- 12. 广告族 ----------
  log('—— 迁移广告族 ——');
  const sponsorIdMap = new Map();
  const sponsorDocs = [];
  for (const s of await drain(L.collection('ad_sponsors').find({}))) {
    const newId = new ObjectId();
    sponsorIdMap.set(String(s._id), newId);
    sponsorDocs.push({
      _id: newId,
      name: s.name || '',
      contact: s.contact || '',
      phone: s.phone || '',
      email: s.email || '',
      logo: s.logo || '',
      active: s.active !== false,
      createdAt: toDate(s.createdAt, new Date()),
      updatedAt: toDate(s.updatedAt, new Date()),
    });
  }
  report.collections.ad_sponsors = await bulkInsert(T.collection('ad_sponsors'), sponsorDocs, 'ad_sponsors');
  log(`  ad_sponsors: ${report.collections.ad_sponsors}/${sponsorDocs.length}`);

  const pageIdMap = new Map();
  const pageDocs = [];
  for (const p of await drain(L.collection('ad_pages').find({}))) {
    const newId = new ObjectId();
    pageIdMap.set(String(p._id), newId);
    pageDocs.push({
      _id: newId,
      name: p.name || '',
      slug: p.slug || String(p._id),
      htmlContent: p.htmlContent || '',
      enabled: p.enabled !== false,
      createdAt: toDate(p.createdAt, new Date()),
      updatedAt: toDate(p.updatedAt, new Date()),
    });
  }
  report.collections.ad_pages = await bulkInsert(T.collection('ad_pages'), pageDocs, 'ad_pages');
  log(`  ad_pages: ${report.collections.ad_pages}/${pageDocs.length}`);

  const contentIdMap = new Map();
  const contentDocs = [];
  for (const c of await drain(L.collection('ad_contents').find({}))) {
    const newId = new ObjectId();
    contentIdMap.set(String(c._id), newId);
    contentDocs.push({
      _id: newId,
      slotKey: c.slotKey || '',
      sponsorId: c.sponsorId ? sponsorIdMap.get(String(c.sponsorId)) || null : null,
      title: c.title || '',
      imageUrl: c.imageUrl || '',
      linkType: ['web', 'page', 'none'].includes(c.linkType) ? c.linkType : 'web',
      linkUrl: c.linkUrl || '',
      pageId: c.pageId ? pageIdMap.get(String(c.pageId)) || null : null,
      startDate: c.startDate || '',
      endDate: c.endDate || '',
      weight: toNum(c.weight, 1),
      enabled: c.enabled !== false,
      totalPv: toNum(c.totalPv, 0),
      totalClick: toNum(c.totalClick, 0),
      createdAt: toDate(c.createdAt, new Date()),
      updatedAt: toDate(c.updatedAt, new Date()),
    });
  }
  report.collections.ad_contents = await bulkInsert(T.collection('ad_contents'), contentDocs, 'ad_contents');
  log(`  ad_contents: ${report.collections.ad_contents}/${contentDocs.length}`);

  const slotDocs = [];
  for (const s of await drain(L.collection('ad_slots').find({}))) {
    if (!s.key) continue;
    slotDocs.push({
      key: s.key,
      page: s.page || '',
      name: s.name || s.key,
      type: ['banner', 'card', 'splash'].includes(s.type) ? s.type : 'banner',
      maxSponsors: toNum(s.maxSponsors, 5),
      exclusive: s.exclusive === true,
      enabled: s.enabled !== false,
      createdAt: toDate(s.createdAt, new Date()),
      updatedAt: toDate(s.updatedAt, new Date()),
    });
  }
  report.collections.ad_slots = await bulkInsert(T.collection('ad_slots'), slotDocs, 'ad_slots');
  log(`  ad_slots: ${report.collections.ad_slots}/${slotDocs.length}`);

  // ad_stats：202 万级，流式重映射 contentId/sponsorId
  log('—— 迁移 ad_stats（大表，分批写入）——');
  let adStatCount = 0;
  if (!DRY_RUN) {
    const col = T.collection('ad_stats');
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      const r = await col.bulkWrite(batch.map((d) => ({ insertOne: { document: d } })), { ordered: false });
      adStatCount += r.insertedCount;
      batch = [];
    };
    const stream = L.collection('ad_stats').find({});
    // eslint-disable-next-line no-restricted-syntax
    for await (const s of stream) {
      const contentId = contentIdMap.get(String(s.contentId));
      if (!contentId) continue; // 引用不到的明细丢弃
      batch.push({
        contentId,
        slotKey: s.slotKey || '',
        sponsorId: s.sponsorId ? sponsorIdMap.get(String(s.sponsorId)) || null : null,
        type: s.type === 'click' ? 'click' : 'pv',
        openid: s._openid || '',
        date: s.date || '',
        createdAt: toDate(s.timestamp, new Date()),
      });
      if (batch.length >= 5000) await flush();
    }
    await flush();
  } else {
    adStatCount = await count('ad_stats');
  }
  report.collections.ad_stats = adStatCount;
  log(`  ad_stats: ${adStatCount}`);

  // ---------- 13. 基础内容 ----------
  log('—— 迁移基础内容 ——');
  const holidayDocs = [];
  for (const h of await drain(L.collection('holidays').find({}))) {
    if (!h.date) continue;
    holidayDocs.push({
      date: h.date,
      name: h.name || '',
      type: h.type || 'festival',
      year: toNum(h.year, parseInt(h.date.slice(0, 4), 10)),
    });
  }
  report.collections.holidays = await bulkInsert(T.collection('holidays'), holidayDocs, 'holidays');
  log(`  holidays: ${report.collections.holidays}/${holidayDocs.length}`);

  const annDocs = [];
  for (const a of await drain(L.collection('announcements').find({}))) {
    annDocs.push({
      title: a.title || '',
      content: a.content || '',
      type: a.type || 'notice',
      priority: toNum(a.priority, 0),
      enabled: a.enabled !== false,
      startAt: toDate(a.startAt),
      endAt: toDate(a.endAt),
      createdAt: toDate(a.createdAt, new Date()),
      updatedAt: toDate(a.updatedAt, new Date()),
    });
  }
  report.collections.announcements = await bulkInsert(T.collection('announcements'), annDocs, 'announcements');
  log(`  announcements: ${report.collections.announcements}/${annDocs.length}`);

  const clDocs = [];
  for (const c of await drain(L.collection('changelogs').find({}))) {
    clDocs.push({
      version: c.version || '0.0.0',
      title: c.title || '',
      content: c.content || '',
      date: c.date || '',
      createdAt: toDate(c.createdAt, new Date()),
      updatedAt: toDate(c.updatedAt, new Date()),
    });
  }
  report.collections.changelogs = await bulkInsert(T.collection('changelogs'), clDocs, 'changelogs');
  log(`  changelogs: ${report.collections.changelogs}/${clDocs.length}`);

  // ---------- 14. goal_config（goals + graded_goals 合并为单例） ----------
  log('—— 迁移 goal_config ——');
  const goalsDoc = (await drain(L.collection('goals').find({}).limit(1)))[0] || {};
  const gradedDoc = (await drain(L.collection('graded_goals').find({}).limit(1)))[0] || {};
  const graded = [];
  for (const seg of gradedDoc.segments || gradedDoc.items || []) {
    if (seg && seg.time) graded.push({ time: seg.time, percent: toNum(seg.percent, 0) });
  }
  const goalConfigDoc = {
    key: 'default',
    daily: {
      steps: toNum(goalsDoc.daily_steps, 5000),
      distance: kmToM(goalsDoc.daily_distance) || 3000,
      calories: toNum(goalsDoc.daily_calories, 250),
    },
    weekly: {
      steps: toNum(goalsDoc.weekly_steps, 35000),
      distance: kmToM(goalsDoc.weekly_distance) || 21000,
      calories: toNum(goalsDoc.weekly_calories, 1750),
    },
    graded: graded.length
      ? graded
      : [
          { time: '10:00', percent: 40 },
          { time: '16:00', percent: 70 },
          { time: '22:00', percent: 100 },
        ],
    anticheat: {
      maxStepJumpPerSync: 13000,
      minPaceSecondsPerKm: 120,
      banDays: 7,
      enabled: true,
    },
    rewardVideo: { dailyLimit: 10, stepsPerWatch: 1000, enabled: true },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  if (!DRY_RUN) {
    await T.collection('goal_config').updateOne({ key: 'default' }, { $set: goalConfigDoc }, { upsert: true });
    report.collections.goal_config = 1;
  } else {
    report.collections.goal_config = 1;
  }
  log('  goal_config: 1（goals + graded_goals 合并单例）');

  // ---------- 15. 索引 ----------
  if (!DRY_RUN) {
    log('\n—— 创建索引 ——');
    const idx = [
      ['users', [{ openid: 1 }, { unique: true }]],
      ['users', [{ studentId: 1 }, { unique: true, sparse: true }]],
      ['run_records', [{ openid: 1, date: 1 }]],
      ['run_records', [{ date: 1 }]],
      ['reward_video_records', [{ openid: 1, date: 1 }, { unique: true }]],
      ['water_records', [{ openid: 1, date: 1 }, { unique: true }]],
      ['user_badges', [{ openid: 1, badgeKey: 1 }, { unique: true }]],
      ['user_badges', [{ openid: 1 }]],
      ['ban_records', [{ userId: 1 }]],
      ['ban_records', [{ openid: 1 }]],
      ['appeals', [{ openid: 1 }]],
      ['appeals', [{ status: 1 }]],
      ['body_data', [{ openid: 1 }, { unique: true }]],
      ['user_goals', [{ openid: 1 }, { unique: true }]],
      ['organizations', [{ type: 1 }]],
      ['organizations', [{ parentId: 1 }]],
      ['class_monitors', [{ openid: 1 }, { unique: true }]],
      ['class_monitors', [{ className: 1 }]],
      ['ad_slots', [{ key: 1 }, { unique: true }]],
      ['ad_contents', [{ slotKey: 1 }]],
      ['ad_contents', [{ sponsorId: 1 }]],
      ['ad_pages', [{ slug: 1 }, { unique: true }]],
      ['ad_stats', [{ contentId: 1, date: 1 }]],
      ['ad_stats', [{ slotKey: 1, date: 1 }]],
      ['ad_stats', [{ date: 1 }]],
      ['ad_stats', [{ sponsorId: 1, date: 1 }]],
      ['holidays', [{ date: 1 }, { unique: true }]],
      ['holidays', [{ year: 1 }]],
      ['changelogs', [{ version: -1 }]],
      ['wx_sessions', [{ openid: 1 }, { unique: true }]],
    ];
    for (const [col, [keys, opts]] of idx) {
      try {
        await T.collection(col).createIndex(keys, opts || {});
      } catch (e) {
        warn(`索引创建失败 ${col} ${JSON.stringify(keys)}: ${e.message}`);
      }
    }
    log('  索引创建完成');
  }

  // ---------- 汇总 ----------
  log('\n========= 迁移报告 =========');
  for (const [name, n] of Object.entries(report.collections)) {
    log(`  ${name.padEnd(24)} ${n}`);
  }
  if (report.warnings.length) {
    log(`\n警告 ${report.warnings.length} 条：`);
    for (const w of report.warnings.slice(0, 30)) log('  -', w);
    if (report.warnings.length > 30) log(`  ... 其余 ${report.warnings.length - 30} 条见日志`);
  }
  log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s${DRY_RUN ? '（试运行，未写入任何数据）' : '，迁移完成。'}`);

  await legacy.close();
  await target.close();
}

main().catch((e) => {
  console.error('\n迁移失败:', e);
  process.exit(1);
});
