/**
 * 学生会成员「部门 ↔ 职务」矛盾数据自查 / 修正。
 *
 * 背景（用户 2026-10-21）：「主席团中怎么能有部长这类的职务呢」。
 * 服务端已加 assertRoleFitsDept 拦新数据，但**历史数据**（在这个校验之前录入的）可能仍存在：
 *   ① deptKey='presidium' 但 role 是 minister / vice_minister / member；
 *   ② role 是 president / vice_president 但 deptKey 不是 presidium。
 * 这类记录会让人在「主席团」下看到「部长」，通讯录与复核范围也跟着错。
 *
 * 用法：
 *   node scripts/fix-union-role-dept.js            # 只报告，不改数据（默认）
 *   node scripts/fix-union-role-dept.js --apply    # 实际修正
 *
 * 修正策略（保守，可解释）：
 *   · 主席团 + 部长类 → 把 role 降为 member（保留在主席团里，人不会消失）；
 *   · 主席/副主席 + 业务部门 → 把 deptKey 改成 presidium（保留职务，因为职务更能代表身份）；
 *   · 每条都打印修正前后的具体值，方便人工核对。
 */
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const config = require('../src/config');
const UnionMember = require('../src/models/union-member');

const PRESIDIUM_KEY = 'presidium';
const PRESIDIUM_ROLES = ['president', 'vice_president'];
const DEPT_ROLES = ['minister', 'vice_minister', 'member'];

function violationOf(m) {
  const isPresidiumDept = m.deptKey === PRESIDIUM_KEY;
  const isPresidiumRole = PRESIDIUM_ROLES.includes(m.role);
  if (isPresidiumDept && !isPresidiumRole) return 'presidium-dept-nonpresidium-role';
  if (isPresidiumRole && !isPresidiumDept) return 'presidium-role-other-dept';
  return '';
}

async function main() {
  const apply = process.argv.includes('--apply');
  const [base, query] = config.mongoUri.split('?');
  const uri = `${base.replace(/\/$/, '')}/${config.dbName}${query ? `?${query}` : ''}`;
  await mongoose.connect(uri);
  console.log(`[db] ${config.dbName}${apply ? '（修正模式）' : '（只读检查，加 --apply 才会改）'}`);

  const rows = await UnionMember.find({ status: 'active' }).lean();
  const bad = rows.filter((m) => violationOf(m));
  console.log(`[scan] 在职成员 ${rows.length} 条，部门/职务矛盾 ${bad.length} 条`);

  if (!bad.length) {
    console.log('[done] 没有需要修正的数据');
    await mongoose.disconnect();
    return;
  }

  for (const m of bad) {
    const kind = violationOf(m);
    if (kind === 'presidium-dept-nonpresidium-role') {
      console.log(`  · ${m.realName || m.openid} | 主席团 · ${m.role} → 主席团 · member`);
      if (apply) {
        await UnionMember.updateOne({ _id: m._id }, { $set: { role: 'member' } });
      }
    } else {
      console.log(`  · ${m.realName || m.openid} | ${m.deptName || m.deptKey} · ${m.role} → 主席团 · ${m.role}`);
      if (apply) {
        await UnionMember.updateOne(
          { _id: m._id },
          { $set: { deptKey: PRESIDIUM_KEY, deptName: '主席团' } }
        );
      }
    }
  }

  if (apply) {
    console.log(`[done] 已修正 ${bad.length} 条`);
  } else {
    console.log('[done] 未修改任何数据；确认无误后加 --apply 执行');
  }
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('[fail]', e.message);
  process.exit(1);
});
