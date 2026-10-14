const User = require('../models/user');
const pwd = require('./password');

const MAX_ROWS = 5000;

// 解析 CSV 文本（首行为表头：姓名,学号,身份证号,学校,院系,班级,专业）
function parseCsv(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((h) => h.trim());
  const idx = (names) => header.findIndex((h) => names.includes(h));
  const iName = idx(['姓名', 'name']);
  const iSid = idx(['学号', 'studentId', 'studentid']);
  const iIdc = idx(['身份证号', '身份证', 'idCard', 'idcard', 'idCardNo']);
  const iSchool = idx(['学校', 'school']);
  const iDept = idx(['院系', 'department']);
  const iClass = idx(['班级', 'className']);
  const iSpec = idx(['专业', 'specialty']);
  const iGrade = idx(['年级', '级', 'grade']);
  if (iName < 0 || iSid < 0) throw new Error('CSV 需包含表头：姓名,学号');
  return lines.slice(1).map((line) => {
    const cols = line.split(',').map((c) => c.trim());
    const row = { name: cols[iName], studentId: cols[iSid] };
    if (iIdc >= 0) row.idCardNo = cols[iIdc];
    if (iSchool >= 0) row.school = cols[iSchool];
    if (iDept >= 0) row.department = cols[iDept];
    if (iClass >= 0) row.className = cols[iClass];
    if (iSpec >= 0) row.specialty = cols[iSpec];
    if (iGrade >= 0) row.grade = cols[iGrade];
    return row;
  });
}

function parseRows(payload) {
  if (Array.isArray(payload)) return payload;
  const text = String(payload || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error('JSON 需为数组');
    return arr;
  }
  return parseCsv(text);
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
 * 返回 { mode, created, updated, failed: [{ row, reason }] }
 */
async function importRows(rows, mode = 'create') {
  if (rows.length > MAX_ROWS) throw new Error(`单次导入上限 ${MAX_ROWS} 行`);
  const result = { mode, total: rows.length, created: 0, updated: 0, failed: [] };
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

  // ===== 更新模式：仅更新已有用户的性别与出生日期 =====
  if (mode === 'update') {
    for (const item of items) {
      const existing = await User.findOne({ studentId: item.studentId });
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

  // ===== 创建模式 =====
  for (const item of items) {
    try {
      const existing = await User.findOne({ studentId: item.studentId });
      if (existing) {
        // 已存在：更新学籍信息 + 附加更新性别与出生日期，不动账号/密码/微信绑定（姓名可选更新）
        if (item.name) {
          existing.realName = item.name;
          if (!existing.account) existing.account = item.name;
        }
        if (item.school) existing.schoolName = item.school;
        if (item.department) existing.departmentName = item.department;
        if (item.className) existing.className = item.className;
        if (item.specialty) existing.specialty = item.specialty;
        // 名单未给年级时按学号前 4 位（入学年份）推导
        const grade = item.grade || gradeFromStudentId(item.studentId);
        if (grade) existing.grade = grade;
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

      // 同名且同初始密码 → 拒绝（通过姓名找候选，再比对初始密码哈希）
      const sameName = await User.find({ account: item.name }).lean();
      const conflict = sameName.find((u) => initials.some((p) => pwd.verifyPassword(p, u.passwordHash) || pwd.matchesAnyInitial(p, u.initialHashes)));
      if (conflict) {
        result.failed.push({
          row: `${item.name}/${item.studentId}`,
          reason: `与已有账号重名且初始密码相同（${conflict.studentId || conflict.openid || conflict._id}），请学校核实后调整`,
        });
        continue;
      }

      await User.create({
        account: item.name,
        realName: item.name,
        studentId: item.studentId,
        schoolName: item.school,
        departmentName: item.department,
        className: item.className,
        specialty: item.specialty,
        grade: item.grade || gradeFromStudentId(item.studentId),
        gender: item.gender != null ? item.gender : 0,
        birthdate: item.birthdate ? new Date(item.birthdate) : undefined,
        role: 'student',
        passwordHash: pwd.hashPassword(initials[0]),
        initialHashes: initials.map((p) => pwd.hashPassword(p)),
        resetHashes: initials.map((p) => pwd.hashPassword(p)),
        mustChangePassword: true,
      });
      result.created += 1;
    } catch (e) {
      result.failed.push({ row: `${item.name}/${item.studentId}`, reason: e.code === 11000 ? '学号已存在（唯一键冲突）' : e.message });
    }
  }
  return result;
}

module.exports = {
  importRows,
  parseRows,
  parseCsv,
  initialPasswords,
  normalizeGrade,
  gradeFromStudentId,
  classNameFromGradeSpecialty,
};
