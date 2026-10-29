/**
 * 串行跑全部检查器与端到端验证 —— **必须串行**，不能并发。
 *
 * 为什么单独提供这个脚本（而不是让人自己 for 循环）：
 *   本仓库的检查器/验证脚本大量**共享同一个数据库**与**同一份进程内缓存**，
 *   并行跑会互相污染，表现为「明明没改代码却红了」的假失败，极难判断。
 *   真实踩过：
 *     · verify-homeroom-scope / verify-teacher-rebind 会自建临时账号并删除，
 *       与 verify-class-status 的统计窗口撞在一起 → 达标人数对不上；
 *     · check-console-live 会**启动完整 app**（占用端口、连库、重置会话缓存），
 *       与其它任何连库脚本并行都会互相干扰；
 *     · check-server-contract 会读文件系统，与写文件的脚本并行时结果不稳定。
 *
 * 用法：
 *   node tools/run-all.js            # 静态检查 + 端到端，全部串行
 *   node tools/run-all.js --check    # 只跑静态检查
 *   node tools/run-all.js --verify   # 只跑端到端
 *
 * 退出码：0 = 全部通过；非 0 = 有失败（并打印失败清单，便于 CI 判断）。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TOOLS = __dirname;
const args = process.argv.slice(2);
const onlyCheck = args.includes('--check');
const onlyVerify = args.includes('--verify');

// 顺序很重要：先跑纯静态的（快、不连库），再跑连库的；
// 连库的里面，把「会启动 app」的放最后（它占用端口与会话缓存）。
function listFiles(prefix) {
  return fs
    .readdirSync(TOOLS)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.js') && f !== path.basename(__filename))
    // check-miniprogram.js 需要微信开发者工具产物，常规跑不了，跳过
    .filter((f) => f !== 'check-miniprogram.js')
    .sort();
}

const checks = listFiles('check-');
// 「会启动完整服务」的检查器必须最后跑（见文件头）
const serviceChecks = checks.filter((f) => f === 'check-console-live.js');
const staticChecks = checks.filter((f) => f !== 'check-console-live.js');

const verifies = listFiles('verify-');

const results = [];
function run(kind, file) {
  const started = Date.now();
  let okFlag = true;
  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(TOOLS, file)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000,
      env: { ...process.env, NODE_ENV: 'test' },
    });
  } catch (e) {
    okFlag = false;
    out = `${e.stdout || ''}\n${e.stderr || ''}`;
  }
  const ms = Date.now() - started;
  results.push({ kind, file, ok: okFlag, ms });
  const mark = okFlag ? '✓' : '✗';
  console.log(`${mark} ${file.padEnd(34)} ${String(ms).padStart(6)} ms`);
  if (!okFlag) {
    // 只打印失败行，避免刷屏；完整输出让用户自己再单跑一次看
    const failLines = out
      .split('\n')
      .filter((l) => /FAIL|✗|❌/.test(l))
      .slice(0, 5);
    for (const l of failLines) console.log('    ' + l.trim());
  }
  return okFlag;
}

console.log('=== 静态检查（串行；会启动服务的放最后）===\n');
if (!onlyVerify) {
  for (const f of staticChecks) run('check', f);
  for (const f of serviceChecks) run('check', f);
}

if (!onlyCheck) {
  console.log('\n=== 端到端验证（串行；共享同一数据库，绝不能并发）===\n');
  for (const f of verifies) run('verify', f);
}

const failed = results.filter((r) => !r.ok);
const total = results.length;
console.log(`\n=== 汇总：${total - failed.length}/${total} 通过 ===`);
if (failed.length) {
  console.log('失败清单：');
  for (const f of failed) console.log(`  ✗ ${f.file}（${f.kind}）`);
  console.log('\n处理建议：单独重跑一次确认，例如  node tools/' + failed[0].file);
  console.log('（若单跑通过，说明是并发/临时数据干扰，不是代码问题）');
  process.exit(1);
}
console.log('全部通过');
process.exit(0);
