/**
 * 静态检查：管理端页面的「写操作」入口必须被写权限控制（wx:if / disabled）。
 *
 * 用户 2026-10-22 两轮要求：
 *   ① 「只有查看权限时应该不显示操作功能按钮，而不是点击后被后端拒绝掉」；
 *   ② 点名清单：管理中枢的北斗运动 / 学生会扫码加人、用户管理的操作、组织架构、考核与目标、
 *      申诉审核、内容与通知、徽章管理（「我只有查看权限却还要操作功能」）。
 *
 * 实现要点（第二版，第一版漏过真问题）：
 *   旧版用「缩进近似祖先」找守卫，**会把兄弟子树的 wx:if 当成祖先**：
 *   徽章页头部「+ 新增徽章」有 wx:if="{{canManage}}"，而列表行的「编辑/删除」缩进更深，
 *   向上扫到那一行就判定「已守卫」，于是漏报了真实事故。现在改成**真正的标签栈解析**：
 *   扫描每个开标签，压栈/出栈维护祖先链，写操作只看**自己 + 真正的祖先**。
 *
 * 判定：单个节点上带 `bind:tap` / `catch:tap` / `bind:confirm` / `bind:change`，
 * 动作名属于写操作（add/save/remove/edit/review/upload/ban/…）且不在纯 UI 白名单里 →
 * 该节点或任一祖先必须有权限条件：
 *   canManage / canPerms / canImport / canEdit / canReview / readonly / disabled="{{!can…}}"
 *   或「只有写权限才进得去的模式开关」（bulkMode / formVisible …）。
 *
 * 白名单 WRITE_ONLY_PAGES：整页只有在持有写权限时才能进入，不存在只读用户。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');
const ADMIN = path.join(ROOT, 'packageAdmin');

const WRITE_ACTIONS =
  /^(add|create|save|submit|remove|del|delete|edit|update|rename|apply|publish|revoke|grant|award|review|approve|reject|ban|unban|reset|import|upload|transfer|kick|leave|join|generate|gen|unbind|bind|batch|set|clear|toggle[A-Z]\w*|open[A-Z]\w*(Create|Add|Edit|Upload|Import|Ban|Grant|Publish|Group|Level)|open(Create|Add|Edit|Upload|Import|Ban|Grant|Publish))/i;

// 纯界面状态动作：展开/收起/清筛选/切 tab/预览/复制 —— 只读用户同样需要。
const UI_ONLY_ACTIONS =
  /^(toggleFilters|clearFilters|toggleDeptExpand|toggleModuleDept|clearKeyword|resetFilters|clearChecked|toggleBulk|clearClassFilter|toggleBadgeGroup|toggleBatchMode|toggleCheckAll|toggleRow|toggleExpand|toggleGroup|togglePick|toggleSelect|toggleSheet|toggleTab|toggleCard|toggleUnfold|toggleUnassigned|toggleFilters|switchTab|switchSlot|onCat|onItemTap|onResetFilters|onFormVisible|onIconVisible|onMode|preview|copyLink|goStats|changeYear|chooseIcon|closeForm|closeSheet|closeResult|closePickers|closeTransferSheet|closeDeptAdd|closeModuleEdit|closeAdd|clearResult|back|close[A-Z]\w*|resetModule)$/;

// 整页都需要写权限才能进入（不存在只读用户）
const WRITE_ONLY_PAGES = new Set([
  // 入口在 nav-groups 里就是 perm:'permission.manage'，服务端整页挂 permission.manage
  'permissions/groups.wxml',
]);

// `caps.*` 是服务端下发的「能力表」（/api/class/student/:id/manage 的 capabilities，
// 用户 2026-10-23：班主任连「删除账户」按钮都不该看到）。它同样是有效守卫 ——
// 但只有页面 JS 里真的存在 caps 字段时才算数，否则 `{{caps.x}}` 恒为 undefined，
// 相当于把整排按钮永久隐藏（比报错更糟：功能静默消失）。下面单独校验这一点。

const PERM_GUARD =
  /canManage|canPerms|canImport|canEdit|canSave|canWrite|canOperate|canReview|canCreate|canDelete|canAward|canApprove|canGrant|canAssign|canTransfer|readonly|readOnly|isReadOnly|caps\./;
// 「只有写权限才进得去的模式」也算守卫：进入该模式的开关本身必须带权限条件
// （开关若没带，它自己就会被本检查报出来，所以用模式做守卫不会漏）。
const MODE_GUARD = /\{\{\s*(bulkMode|batchMode|editMode|formVisible|showEdit|editing|createMode)\s*\}\}/;

// 把注释替换成等长空白（保留换行，行号不变）：注释里出现的 wx:if 不算守卫，
// 注释里的示例也不该被当成真实入口。
function stripComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

const TAG_OPEN = /<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const TAG_CLOSE = /<\/\s*([a-zA-Z][\w-]*)\s*>/g;

function tokensOf(src) {
  const tokens = [];
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;
  for (const m of src.matchAll(TAG_OPEN)) {
    tokens.push({ idx: m.index, type: 'open', tag: m[1], attrs: m[2] || '', selfClose: m[3] === '/' });
  }
  for (const m of src.matchAll(TAG_CLOSE)) {
    tokens.push({ idx: m.index, type: 'close', tag: m[1] });
  }
  tokens.sort((a, b) => a.idx - b.idx);
  for (const t of tokens) t.line = lineOf(t.idx);
  return tokens;
}

const bad = [];
const scanned = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'miniprogram_npm' || entry.name === 'node_modules') continue;
      walk(p);
      continue;
    }
    if (!entry.name.endsWith('.wxml')) continue;

    const rel = path.relative(ADMIN, p).replace(/\\/g, '/');
    if (!fs.existsSync(p.replace(/\.wxml$/, '.js'))) continue;
    if (WRITE_ONLY_PAGES.has(rel)) continue;
    scanned.push(rel);

    const src = stripComments(fs.readFileSync(p, 'utf8'));
    const stack = [];
    for (const t of tokensOf(src)) {
      if (t.type === 'close') {
        // 弹栈到同名标签（容忍未闭合节点导致的偏差，不至于整棵树错位）
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          if (stack[i].tag === t.tag) {
            stack.length = i;
            break;
          }
        }
        continue;
      }
      // 开标签：先按「自己 + 祖先」判定，再入栈
      const bindings = [...t.attrs.matchAll(/(?:bind|catch):(?:tap|confirm|change)="([\w]+)"/g)].map((m) => m[1]);
      const actions = bindings.filter((a) => WRITE_ACTIONS.test(a) && !UI_ONLY_ACTIONS.test(a));
      if (actions.length) {
        const chain = [...stack.map((s) => s.attrs), t.attrs];
        const guarded = chain.some((attrs) => PERM_GUARD.test(attrs) || MODE_GUARD.test(attrs));
        if (!guarded) {
          for (const action of actions) bad.push({ file: rel, line: t.line, action, tag: t.tag });
        }
      }
      if (!t.selfClose) stack.push(t);
    }
  }
}

walk(ADMIN);

// 额外校验：WXML 里用到 caps.* 的页面，JS 必须有 caps 字段（否则 {{caps.x}} 恒 undefined，
// 整排按钮会静默消失 —— 比报错更难发现）。caps 的两处赋值：
//   ① 管理端视角：load() 按权限项换算成同一套字段；
//   ② 班级域视角：服务端 capabilities 直接落 data。
for (const rel of scanned) {
  const wxmlPath = path.join(ADMIN, rel);
  const jsPath = wxmlPath.replace(/\.wxml$/, '.js');
  const wxmlSrc = stripComments(fs.readFileSync(wxmlPath, 'utf8'));
  if (!/\bcaps\./.test(wxmlSrc)) continue;
  const jsSrc = fs.readFileSync(jsPath, 'utf8');
  if (!/\bcaps\s*:/.test(jsSrc) || !/caps:\s*\(manage && manage\.capabilities\)/.test(jsSrc)) {
    bad.push({ file: rel, line: 0, action: 'caps 未在 JS 中定义（模板用了 caps.*）', tag: 'js' });
  }
}

if (bad.length) {
  console.log(`❌ ${bad.length} 处写操作入口没有写权限控制（只读用户会看到能点、点了被拒）：`);
  for (const b of bad) console.log(`   packageAdmin/${b.file}:${b.line}  ${b.tag} bind=${b.action}`);
  console.log('\n修法：给这些节点或**真正的祖先**加 wx:if="{{canManage}}"，或 disabled="{{!canManage}}"；');
  console.log('      页面没有 canManage 时用 utils/admin-perm.js::applyManage(this, "<模块>.manage") 统一算。');
  process.exit(1);
}

console.log(`检查 ${scanned.length} 个管理端页面（标签栈解析，bind/catch 写操作入口）`);
console.log('写操作入口都已按写权限控制（只读用户看不到操作按钮）');
