const User = require('../models/user');
const pwd = require('./password');
const XLSX = require('xlsx');

const MAX_ROWS = 5000;

// 解析表格（SheetJS）：.xlsx/.xls 文件 Buffer 与 CSV 文本统一走此路径，
// 支持引号/字段内逗号转义（替代旧的自制 split(',') 解析）；取第一个 sheet
function parseSheet(input) {
  const wb = XLSX.read(input, { type: Buffer.isBuffer(input) ? 'buffer' : 'string' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!rows.length) return [];
  const keys = Object.keys(rows[0]).map((k) => String(k).trim());
  const has = (names) => keys.some((k) => names.includes(k));
  if (!has(['姓名', 'name', 'Name']) || !has(['学号', 'studentId', 'studentid', 'StudentId'])) {
    throw new Error('表格需包含列：姓名,学号');
  }
  return rows;
}

function parseRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Buffer.isBuffer(payload)) return parseSheet(payload);
  const text = String(payload || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error('JSON 需为数组');
    return arr;
  }
  return parseSheet(text);
}

// 年级归一化：去掉结尾的「级」，只留年份文本（如 "2024级" → "2024"）
function normalizeGrade(v) {
  return String(v || '').replace(/级$/, '').trim();
}

// 年级推导：学号前 4 位即入学年份（如 20230101 → "2023"）
// 前 4 位不是合理年份（1900~2099）时返回空串，避免把随机数字当年级
function gradeFromStudentId(studentId) {
  const m = String(studentId || '').trim().match(/^(\d{4})/);
  if (!m) return '';
  const year = Number(m[1]);
  return year >= 1900 && year <= 2099 ? m[1] : '';
}

// 班级名 → 年级：与 gradeFromStudentId 同口径（4 位年份，不在 1900~2099 返回空串）
// 班级名约定是「年级后两位 + 专业」，两种历史写法都要容错：
// - 「23级机电1班」→ 2023（带「级」字）
// - 「25大数据与会计」→ 2025（不带「级」字，导入/手填都出现过）
// - 「2023级大数据技术」→ 2023（已写满 4 位年份时按 4 位解析，不再补 20）
function gradeFromClassName(className) {
  const s = String(className || '').trim();
  const four = s.match(/^(\d{4})/);
  if (four) return gradeFromStudentId(four[1]);
  const two = s.match(/^(\d{2})\s*级?/);
  return two ? gradeFromStudentId(`20${two[1]}`) : '';
}

// 班级自动识别 = 年级后两位 + 专业（如 2023 + 大数据技术 →「23级大数据技术」）
// - 年级或专业缺失 → 保留原值（不覆盖，避免把名单里的班级抹掉）
// - 原班级已是同一「年级+专业」的更细班（如「23级机电1班」）→ 原样保留，不丢班序号
function classNameFromGradeSpecialty(grade, specialty, current = '') {
  const g = String(grade || '').trim();
  const s = String(specialty || '').trim();
  const cur = String(current || '').trim();
  if (!g || !s) return cur;
  const prefix = `${g.slice(-2)}级${s}`;
  if (cur.indexOf(prefix) === 0 && cur.length > prefix.length) return cur;
  return prefix;
}

// 规范化一行
// 性别解析：支持 男/女/保密 与 1/2/0；无法识别返回 null
function parseGender(v) {
  const s = String(v == null ? '' : v).trim();
  if (['男', '1'].includes(s)) return 1;
  if (['女', '2'].includes(s)) return 2;
  if (['保密', '0'].includes(s)) return 0;
  return null;
}

// 出生日期解析：YYYY-MM-DD / YYYY.M.D / Excel 日期序列号；失败返回 null
function parseBirthdate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d{5}$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return null;
}

function normalizeRow(row, index) {
  const name = String(row.name || row.姓名 || '').trim();
  const studentId = String(row.studentId || row.学号 || '').trim();
  const idCardNo = String(row.idCardNo || row.idcard || row.身份证号 || row.身份证 || '').trim();
  if (!studentId) return { error: `第 ${index + 1} 行缺少学号` };
  const gender = parseGender(row.gender != null ? row.gender : row.性别);
  const birthdate = parseBirthdate(row.birthdate != null ? row.birthdate : row.出生日期);
  if (row.性别 != null && String(row.性别).trim() !== '' && gender == null) {
    return { error: `第 ${index + 1} 行性别无法识别：${row.性别}` };
  }
  if (row.出生日期 != null && String(row.出生日期).trim() !== '' && birthdate == null) {
    return { error: `第 ${index + 1} 行出生日期格式错误：${row.出生日期}` };
  }
  return {
    name,
    studentId,
    idCardNo,
    gender,
    birthdate,
    school: String(row.school || row.学校 || '').trim(),
    department: String(row.department || row.院系 || '').trim(),
    className: String(row.className || row.班级 || '').trim(),
    specialty: String(row.specialty || row.专业 || '').trim(),
    grade: normalizeGrade(row.grade || row.年级 || ''),
  };
}

// ===== 智能导入：列名别名识别 + 缺失字段推导 =====
// 文件列名不固定，唯一稳定的是学号（姓名建议提供）；其余列有多少算多少
const CANONICAL_ALIASES = {
  studentId: ['学号', '学生学号'],
  name: ['姓名', '名字', '学生姓名'],
  gender: ['性别'],
  idCardNo: ['证件号码', '证件号', '身份证号', '身份证', '身份证号码'],
  className: ['班级', '班', '行政班', '班级名称'],
  specialty: ['专业', '专业名称'],
  department: ['院系', '系', '系部', '学院'],
  school: ['学校', '院校', '校区'],
  grade: ['年级', '入学年份'],
  birthdate: ['出生日期', '出生年月', '生日'],
};

// 表头别名 → 规范键；未识别的键原样保留（normalizeRow 的中英文兼容继续兜底）
function remapRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    const key = String(k).trim();
    const canonical = Object.keys(CANONICAL_ALIASES).find((c) => CANONICAL_ALIASES[c].includes(key));
    out[canonical || key] = v;
  }
  return out;
}

// 从身份证号提取出生日期（18 位取 7-14 位，15 位老证取 7-12 位补 19xx）；格式非法或日期不存在返回 null
function birthdateFromIdCard(idCard) {
  const s = String(idCard || '').trim();
  if (!/^\d{15}$/.test(s) && !/^\d{17}[\dXx]$/.test(s)) return null;
  const raw = s.length === 15 ? `19${s.slice(6, 12)}` : s.slice(6, 14);
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1900 || year > 2100) return null;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// 从身份证号提取性别（18 位第 17 位奇偶，15 位取末位）：奇=1 男，偶=2 女；非法返回 null
function genderFromIdCard(idCard) {
  const s = String(idCard || '').trim();
  if (!/^\d{15}$/.test(s) && !/^\d{17}[\dXx]$/.test(s)) return null;
  const digit = Number(s.length === 15 ? s[14] : s[16]);
  if (Number.isNaN(digit)) return null;
  return digit % 2 === 1 ? 1 : 2;
}

// 从班级名解析专业（去掉「NN级」前缀；不匹配格式返回空）
function specialtyFromClassName(className) {
  const m = String(className || '').trim().match(/^\d{2}级(.+)$/);
  return m ? m[1].trim() : '';
}

function str(row, ...keys) {
  for (const k of keys) {
    const v = row[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// 文件内重复学号只保留最后一行（智能模式：重复内容以新数据替换）；无学号的行原样保留（后续归一化报错）
function dedupeByStudentId(rows) {
  const map = new Map();
  const noSid = [];
  for (const r of rows) {
    const sid = str(r, 'studentId', '学号');
    if (sid) map.set(sid, r);
    else noSid.push(r);
  }
  return [...map.values(), ...noSid];
}

// 智能模式推导：年级←学号/班级前缀；专业←班级；班级←年级+专业；出生日期/性别←证件号码；
// 院系/学校←同班级已有学生 → 同专业已有学生（库内最常见非空值）。显式提供的列一律不覆盖。
async function smartFillRows(rawRows) {
  const rows = rawRows.map(remapRow);

  for (const row of rows) {
    const studentId = str(row, 'studentId', '学号');
    const className = str(row, 'className', '班级');

    // 年级：列 → 学号前 4 位 → 班级前缀
    let grade = normalizeGrade(row.grade || '');
    if (!grade) grade = gradeFromStudentId(studentId);
    if (!grade) {
      const m = className.match(/^(\d{2})级/);
      if (m) grade = `20${m[1]}`;
    }
    if (grade) row.grade = grade;

    // 专业：列 → 班级去前缀
    if (!str(row, 'specialty')) {
      const fromClass = specialtyFromClassName(className);
      if (fromClass) row.specialty = fromClass;
    }

    // 班级：缺失时按「年级+专业」组合补出
    if (!className) {
      const derived = classNameFromGradeSpecialty(grade, str(row, 'specialty'), '');
      if (derived) row.className = derived;
    }

    // 出生日期 / 性别：证件号码兜底（显式列不覆盖）
    const idCard = str(row, 'idCardNo', '身份证号', '身份证');
    if (!str(row, 'birthdate', '出生日期')) {
      const birth = birthdateFromIdCard(idCard);
      if (birth) row.birthdate = birth;
    }
    if (parseGender(row.gender) == null) {
      const g = genderFromIdCard(idCard);
      if (g != null) row.gender = g === 1 ? '男' : '女';
    }
  }

  // 院系/学校：同班级 → 同专业 已有学生匹配（一次聚合查全）
  const needMatch = rows.filter((r) => !str(r, 'department') || !str(r, 'school'));
  if (needMatch.length) {
    const tally = (list) => {
      const count = new Map();
      for (const v of list) {
        const t = String(v || '').trim();
        if (!t) continue;
        count.set(t, (count.get(t) || 0) + 1);
      }
      let best = '';
      let bestN = 0;
      for (const [v, n] of count) {
        if (n > bestN) {
          best = v;
          bestN = n;
        }
      }
      return best;
    };
    const classNames = [...new Set(needMatch.map((r) => str(r, 'className')).filter(Boolean))];
    const specialties = [...new Set(needMatch.map((r) => str(r, 'specialty')).filter(Boolean))];
    const byClass = new Map();
    const bySpec = new Map();
    if (classNames.length) {
      const docs = await User.aggregate([
        { $match: { className: { $in: classNames } } },
        { $group: { _id: '$className', schools: { $push: '$schoolName' }, departments: { $push: '$departmentName' } } },
      ]);
      for (const d of docs) byClass.set(d._id, { school: tally(d.schools), department: tally(d.departments) });
    }
    if (specialties.length) {
      const docs = await User.aggregate([
        { $match: { specialty: { $in: specialties } } },
        { $group: { _id: '$specialty', schools: { $push: '$schoolName' }, departments: { $push: '$departmentName' } } },
      ]);
      for (const d of docs) bySpec.set(d._id, { school: tally(d.schools), department: tally(d.departments) });
    }
    for (const row of needMatch) {
      const fromClass = byClass.get(str(row, 'className'));
      const fromSpec = bySpec.get(str(row, 'specialty'));
      if (!str(row, 'school')) {
        const school = (fromClass && fromClass.school) || (fromSpec && fromSpec.school) || '';
        if (school) row.school = school;
      }
      if (!str(row, 'department')) {
        const department = (fromClass && fromClass.department) || (fromSpec && fromSpec.department) || '';
        if (department) row.department = department;
      }
    }
  }

  // 文件内重复学号去重：重复内容以最后出现的行替换
  return dedupeByStudentId(rows);
}

// 初始密码（可多个）：身份证后8 / 学号后8
function initialPasswords(row) {
  const list = [];
  const idc8 = pwd.last8(row.idCardNo);
  const sid8 = pwd.last8(row.studentId);
  if (idc8) list.push(idc8);
  if (sid8 && !list.includes(sid8)) list.push(sid8);
  return list;
}

/**
 * 导入名单（管理端导入与学校推送共用）
 * mode='create'（默认，导入新用户）：
 * - 按 studentId upsert：已存在 → 更新学籍信息 + 附加更新性别与出生日期（不改密码/微信绑定）
 * - 新建 → 初始密码（身份证后8/学号后8），mustChangePassword=true
 * - 同名且同初始密码 → 拒绝该行
 * mode='update'（仅更新已有用户）：表头只需 学号、性别、出生日期；
 * - 按学号匹配已有用户，仅更新性别与出生日期；学号不存在则失败报告，绝不创建
 * mode='smart'（智能）：不约定列集（学号必填、姓名建议提供），先做列名识别与字段推导（smartFillRows），
 * - 再按 create 语义 upsert：学号已存在 → 按提供字段更新；不存在 → 创建
 * 返回 { mode, created, updated, failed: [{ row, reason }] }
 */
async function importRows(rows, mode = 'create') {
  if (rows.length > MAX_ROWS) throw new Error(`单次导入上限 ${MAX_ROWS} 行`);
  const requestedMode = ['smart', 'update'].includes(mode) ? mode : 'create';
  // 智能模式：列名识别 + 缺失字段推导（含文件内重复学号去重），随后按创建模式的 upsert 语义写库
  if (requestedMode === 'smart') rows = await smartFillRows(rows);
  const effective = requestedMode === 'smart' ? 'create' : requestedMode;
  const result = { mode: requestedMode, total: rows.length, created: 0, updated: 0, failed: [] };
  // 先归一化，收集合法行
  const items = [];
  for (let i = 0; i < rows.length; i++) {
    const n = normalizeRow(rows[i], i);
    if (n.error) {
      result.failed.push({ row: i + 1, reason: n.error });
      continue;
    }
    items.push(n);
  }

  // 批量预载：已有用户（按学号）与同名候选（重名同密码冲突检测用），整批各一次查询
  // （原先逐行 findOne 2-3 次，几千行会超出请求超时）
  const bySid = new Map();
  const byAccount = new Map();
  if (items.length) {
    const docs = await User.find({ studentId: { $in: items.map((i) => i.studentId) } });
    for (const d of docs) bySid.set(d.studentId, d);
    if (effective !== 'update') {
      const names = [...new Set(items.map((i) => i.name).filter(Boolean))];
      if (names.length) {
        const candidates = await User.find({ account: { $in: names } })
          .select('account studentId openid passwordHash initialHashes')
          .lean();
        for (const u of candidates) {
          if (!byAccount.has(u.account)) byAccount.set(u.account, []);
          byAccount.get(u.account).push(u);
        }
      }
    }
  }

  // ===== 更新模式：仅更新已有用户的性别与出生日期 =====
  if (effective === 'update') {
    for (const item of items) {
      const existing = bySid.get(item.studentId);
      if (!existing) {
        result.failed.push({ row: `${item.studentId}`, reason: '学号不存在，仅支持更新已有用户' });
        continue;
      }
      if (item.gender != null) existing.gender = item.gender;
      if (item.birthdate) existing.birthdate = new Date(item.birthdate);
      if (item.gender == null && !item.birthdate) {
        result.failed.push({ row: item.studentId, reason: '该行无可更新的性别/出生日期' });
        continue;
      }
      await existing.save();
      result.updated += 1;
    }
    return result;
  }

  // ===== 创建/智能模式：按学号 upsert =====

  // 文件内重复学号：以最后出现的行替换（与智能模式推导后的去重保持同一语义）
  const deduped = new Map();
  items.forEach((item) => deduped.set(item.studentId, item));
  const upsertItems = [...deduped.values()];

  // 段1：已存在 → 逐个更新；新建行 → 内存预检（姓名 / 初始密码 / 重名同密码冲突）
  const toCreate = [];
  for (const item of upsertItems) {
    const existing = bySid.get(item.studentId);
    if (existing) {
      // 已存在：更新学籍信息 + 附加更新性别与出生日期，不动账号/密码/微信绑定（姓名可选更新）
      if (item.name) {
        existing.realName = item.name;
        if (!existing.account) existing.account = item.name;
      }
      if (item.school) existing.schoolName = item.school;
      if (item.department) existing.departmentName = item.department;
      if (item.specialty) existing.specialty = item.specialty;
      // 名单未给年级时按学号前 4 位（入学年份）推导
      const grade = item.grade || gradeFromStudentId(item.studentId);
      if (grade) existing.grade = grade;
      // 班级统一按「年级+专业」组合：名单班级列可选，显式写了同前缀更细班时原样保留
      const specialty = item.specialty || existing.specialty;
      if (item.className || (grade && specialty)) {
        existing.className = classNameFromGradeSpecialty(grade, specialty, item.className);
      }
      if (item.gender != null) existing.gender = item.gender;
      if (item.birthdate) existing.birthdate = new Date(item.birthdate);
      await existing.save();
      result.updated += 1;
      continue;
    }

    if (!item.name) {
      result.failed.push({ row: `${item.studentId}`, reason: '新用户缺少姓名（创建模式必填）' });
      continue;
    }
    const initials = initialPasswords(item);
    if (!initials.length) {
      result.failed.push({ row: `${item.name}/${item.studentId}`, reason: '学号与身份证均不足 8 位，无法生成初始密码' });
      continue;
    }
    // 同名且同初始密码 → 拒绝（候选 = 库内同名账号）
    const conflict = (byAccount.get(item.name) || []).find((u) =>
      initials.some((p) => pwd.verifyPassword(p, u.passwordHash) || pwd.matchesAnyInitial(p, u.initialHashes))
    );
    if (conflict) {
      result.failed.push({
        row: `${item.name}/${item.studentId}`,
        reason: `与已有账号重名且初始密码相同（${conflict.studentId || conflict.openid || conflict._id}），请学校核实后调整`,
      });
      continue;
    }
    toCreate.push(item);
  }

  // 段2：新建行 → 并行预计算哈希（scrypt 跑 libuv 线程池；原先逐个同步算 3-5 遍是超时主因）
  //      → insertMany 一次批量写入（ordered:false，单行冲突不影响其他行）
  if (toCreate.length) {
    const hashSets = await Promise.all(toCreate.map((item) => pwd.hashInitialPasswordSet(initialPasswords(item))));
    const docs = toCreate.map((item, i) => {
      const grade = item.grade || gradeFromStudentId(item.studentId);
      return {
        account: item.name,
        realName: item.name,
        studentId: item.studentId,
        schoolName: item.school,
        departmentName: item.department,
        // 班级统一按「年级+专业」组合：名单班级列可选，显式写了同前缀更细班时原样保留
        className: classNameFromGradeSpecialty(grade, item.specialty, item.className),
        specialty: item.specialty,
        grade,
        gender: item.gender != null ? item.gender : 0,
        birthdate: item.birthdate ? new Date(item.birthdate) : undefined,
        role: 'student',
        passwordHash: hashSets[i].passwordHash,
        initialHashes: hashSets[i].initialHashes,
        resetHashes: hashSets[i].resetHashes,
        mustChangePassword: true,
      };
    });
    const handleDoc = (doc) => {
      if (!doc) return;
      bySid.set(doc.studentId, doc);
      result.created += 1;
    };
    try {
      const res = await User.insertMany(docs, { ordered: false, rawResult: true });
      // 成功：res.mongoose.results 即插入的文档数组
      for (const doc of (res.mongoose && res.mongoose.results) || []) handleDoc(doc);
    } catch (e) {
      // 部分成功：错误对象带 writeErrors（含 index）与 insertedDocs
      const errIndex = new Map();
      for (const we of e.writeErrors || []) errIndex.set(we.index, we);
      for (const doc of e.insertedDocs || []) handleDoc(doc);
      for (const [index, we] of errIndex) {
        const doc = docs[index] || {};
        result.failed.push({
          row: `${doc.account || ''}/${doc.studentId || ''}`,
          reason: String(we.errmsg || '').includes('11000') ? '学号已存在（唯一键冲突）' : we.errmsg,
        });
      }
    }
  }
  return result;
}

module.exports = {
  importRows,
  parseRows,
  parseSheet,
  normalizeRow,
  remapRow,
  smartFillRows,
  birthdateFromIdCard,
  genderFromIdCard,
  initialPasswords,
  normalizeGrade,
  gradeFromStudentId,
  gradeFromClassName,
  classNameFromGradeSpecialty,
};
