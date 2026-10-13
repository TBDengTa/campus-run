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

// 规范化一行
function normalizeRow(row, index) {
  const name = String(row.name || row.姓名 || '').trim();
  const studentId = String(row.studentId || row.学号 || '').trim();
  const idCardNo = String(row.idCardNo || row.idcard || row.身份证号 || row.身份证 || '').trim();
  if (!name) return { error: `第 ${index + 1} 行缺少姓名` };
  if (!studentId) return { error: `第 ${index + 1} 行缺少学号` };
  return {
    name,
    studentId,
    idCardNo,
    school: String(row.school || row.学校 || '').trim(),
    department: String(row.department || row.院系 || '').trim(),
    className: String(row.className || row.班级 || '').trim(),
    specialty: String(row.specialty || row.专业 || '').trim(),
    grade: normalizeGrade(row.grade || row.年级 || row.级),
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
 * 规则：
 * - 按 studentId upsert：已存在 → 仅更新院系班级等信息（绑定后不改密码/账号）
 * - 新建 → 生成初始密码哈希（身份证后8/学号后8），mustChangePassword=true，未绑定微信
 * - 同名且同初始密码 → 拒绝该行（学校需保证唯一）
 * 返回 { created, updated, failed: [{ row, reason }] }
 */
async function importRows(rows) {
  if (rows.length > MAX_ROWS) throw new Error(`单次导入上限 ${MAX_ROWS} 行`);
  const result = { total: rows.length, created: 0, updated: 0, failed: [] };
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

  for (const item of items) {
    try {
      const existing = await User.findOne({ studentId: item.studentId });
      if (existing) {
        // 已存在：仅更新学籍信息，不动账号/密码/微信绑定
        existing.realName = item.name;
        if (!existing.account) existing.account = item.name;
        if (item.school) existing.schoolName = item.school;
        if (item.department) existing.departmentName = item.department;
        if (item.className) existing.className = item.className;
        if (item.specialty) existing.specialty = item.specialty;
        if (item.grade) existing.grade = item.grade;
        await existing.save();
        result.updated += 1;
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
        grade: item.grade,
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

module.exports = { importRows, parseRows, parseCsv, initialPasswords };
