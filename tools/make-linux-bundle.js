/**
 * 打包 Linux 部署包：node tools/make-linux-bundle.js
 *
 * 自测（改过凭据扫描规则后必跑）：node tools/make-linux-bundle.js --selftest
 *
 * 产出：dist/campus-run-backend-<version>-linux.tar.gz
 *
 * 为什么单独一个脚本而不是手工 zip：
 *   ① server/.env、miniprogram/config/env.js 都含真实凭据，**绝不能进包**（AGENTS.md 红线）；
 *   ② Windows 上打的包如果保留 CRLF，Linux 里 bash 脚本会报 "$'\r': command not found"；
 *   ③ .sh 必须带可执行位，否则部署时要人工 chmod，容易漏。
 *
 * 包内结构：
 *   campus-run/
 *     server/          源码（不含 node_modules / .env / uploads / tmp）
 *     deploy/          install.sh / systemd / nginx / .env 模板 / DEPLOY.md
 *     DEPLOY.md        同上（根目录也放一份，解压就能看见）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ---------- 凭据扫描规则（先定义，供自测与打包共用）----------
/**
 * 一行文本里是否含「真实的」MongoDB 连接串（带账号密码）。
 *
 * 为什么要独立成函数并配自测：这条正则既是安全闸门也是「别误伤文档」的过滤器 ——
 * 改宽了会放过真凭据（更糟），改窄了会把 `.env` 模板里的 `<用户名>:<密码>@` 示例当成泄漏、
 * 导致打包直接失败（实测踩过一次）。用 `--selftest` 把正反例都钉住。
 *
 * 判据：
 *   ① 用户名/密码含尖括号、中文、或明确占位词 → 示例，放行；
 *   ② 有凭据 且 主机看起来是真的（IPv4 / 常见 TLD 域名，可带端口）→ 认定泄漏。
 */
function looksLikeRealMongoUri(rawLine) {
  const line = String(rawLine || '').trim();
  if (!/MONGO_URI\s*=\s*mongodb(\+srv)?:\/\//i.test(line)) return false;
  const cred = line.match(/:\/\/([^@/\s]+)@/);
  if (!cred) return false; // 无凭据：安全
  const userInfo = cred[1];
  // 凭据明显是占位（尖括号 / 中文 / placeholder 类词）→ 是文档示例
  if (
    /[<>【】「」]/.test(userInfo) ||
    /[\u4e00-\u9fa5]/.test(userInfo) ||
    /placeholder|replace|change-?me|your[_-]?(user|pass)|example|demo|xxx/i.test(userInfo)
  ) {
    return false;
  }
  // 主机是占位（<host> / your-host）→ 也是示例。
  // 注意：**不要**因为主机含 example 就放行 —— `db.example.com` 是合法域名写法，
  // 而占位主机通常带尖括号或 your- 前缀，用这两个特征区分即可。
  const host = line.slice(line.indexOf('@') + 1).split(/[/?]/)[0];
  if (/[<>]/.test(host) || /^your-|\.your-|placeholder/i.test(host)) return false;
  return (
    /^\d{1,3}(\.\d{1,3}){3}(:\d{2,5})?$/.test(host) ||
    /^[a-z0-9][a-z0-9.-]*\.(com|net|org|tech|cn|io|local|internal|cloud|top|xyz|site|online|dev)(:\d{2,5})?$/i.test(host)
  );
}

// ---------- 自测模式 ----------
if (process.argv.includes('--selftest')) {
  const cases = [
    ['MONGO_URI=mongodb://mongo_X:secret@s1.tangbo.tech:27017/?authSource=admin', true, '真实连接串（域名+密码）'],
    ['MONGO_URI=mongodb://root:Abc12345@10.0.0.5:27017', true, 'IPv4 + 密码'],
    ['MONGO_URI=mongodb://admin:p%40ss@db.example.com:27017', true, 'URL 编码密码 + 域名'],
    ['  MONGO_URI=mongodb://usr:pwd@s1.tangbo.tech:27017', true, '带缩进的真实串'],
    ['MONGO_URI=mongodb://a:b@my-db.internal:27017', true, '内部域名带凭据'],
    ['MONGO_URI=mongodb+srv://u:p@cluster0.abcde.mongodb.net/test', true, 'mongodb+srv 云库'],
    ['MONGO_URI=mongodb://<用户名>:<密码>@127.0.0.1:27017/?authSource=admin', false, '文档占位符（中文+尖括号）'],
    ['MONGO_URI=mongodb://user:password@your-host:27017', false, '占位主机'],
    ['MONGO_URI=mongodb://127.0.0.1:27017', false, '无凭据（未开认证）'],
    ['MONGO_URI=mongodb://placeholder:placeholder@127.0.0.1:27017', false, 'placeholder 占位'],
    ['# 示例：MONGO_URI=mongodb://<用户名>:<密码>@<主机>:27017', false, '中文说明行'],
    ['MONGO_URI=mongodb://<user>:<pass>@db.example.com:27017', false, '尖括号占位 + 真实域名'],
  ];
  let bad = 0;
  for (const [text, want, label] of cases) {
    const got = looksLikeRealMongoUri(text);
    const pass = got === want;
    if (!pass) bad += 1;
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${label} → 期望${want ? '拦截' : '放行'}，实际${got ? '拦截' : '放行'}`);
  }
  console.log(bad ? `\n${bad} 项失败` : '\n✅ 凭据扫描规则：真实凭据全部拦截、文档示例全部放行');
  process.exit(bad ? 1 : 0);
}

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');
const PKG_NAME = 'campus-run';
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'package.json'), 'utf8'));
const VERSION = pkgJson.version || '2.0.0';
const TARBALL = path.join(OUT_DIR, `${PKG_NAME}-backend-${VERSION}-linux.tar.gz`);

// 打包时排除的东西（相对 server/）
const SERVER_EXCLUDE = new Set([
  'node_modules',
  '.env', // 真实凭据，红线
  '.env.local',
  'uploads', // 运行时上传文件，部署后由服务自己创建
  'tmp',
]);

function isExcludedServer(name) {
  if (SERVER_EXCLUDE.has(name)) return true;
  if (/^\.env\.(local|production|development)$/.test(name)) return true;
  if (name.startsWith('_tmp')) return true; // 本地调试脚本
  if (name.endsWith('.log')) return true;
  return false;
}

/** CRLF → LF（bash / systemd / Nginx 配置都要求，否则会带 \r 报错） */
function toLf(buf) {
  return buf.toString('utf8').replace(/\r\n/g, '\n');
}

const manifest = [];
let fileCount = 0;

function addFile(relInPkg, absPath, { lf = false, executable = false } = {}) {
  if (!fs.existsSync(absPath)) return;
  const content = lf ? Buffer.from(toLf(fs.readFileSync(absPath)), 'utf8') : fs.readFileSync(absPath);
  manifest.push({ relInPkg, content, executable });
  fileCount += 1;
}

function addTree(relPrefix, absDir, { skip = () => false } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const e of entries) {
    const abs = path.join(absDir, e.name);
    if (skip(e.name)) continue;
    if (e.isDirectory()) {
      addTree(`${relPrefix}/${e.name}`, abs, { skip });
    } else if (e.isFile()) {
      const name = e.name;
      const isText = /\.(js|json|md|sh|conf|service|example|txt|yml|yaml)$/i.test(name);
      addFile(`${relPrefix}/${name}`, abs, {
        lf: isText,
        executable: name.endsWith('.sh'),
      });
    }
  }
}

// ---------- server ----------
addTree('server', path.join(ROOT, 'server'), {
  skip: (name) => isExcludedServer(name),
});

// ---------- deploy ----------
addFile('deploy/install.sh', path.join(ROOT, 'deploy', 'install.sh'), { lf: true, executable: true });
addFile('deploy/setup-https.sh', path.join(ROOT, 'deploy', 'setup-https.sh'), { lf: true, executable: true });
addFile('deploy/preflight.js', path.join(ROOT, 'deploy', 'preflight.js'), { lf: true });
addFile('deploy/DEPLOY.md', path.join(ROOT, 'deploy', 'DEPLOY.md'), { lf: true });
addFile('deploy/.env.production.example', path.join(ROOT, 'deploy', '.env.production.example'), { lf: true });
addTree('deploy/systemd', path.join(ROOT, 'deploy', 'systemd'), {});
addTree('deploy/nginx', path.join(ROOT, 'deploy', 'nginx'), {});
addFile('DEPLOY.md', path.join(ROOT, 'deploy', 'DEPLOY.md'), { lf: true });

// ===== 数据修复工具（用户 2026-10-28）=====
// 打包默认**不含 tools/**（那里面全是开发期静态检查，服务器上没用）。
// 但「班级名规范化」是**运维型**迁移脚本：换库 / 换环境 / 重新导入名单后
// 都可能需要再跑一次，而运维人员手上只有这个发布包。
// 所以单独挑出这一类「可重复运行、带 dry-run」的脚本入包，放在 tools/ 下，用法与仓库里一致。
for (const name of ['fix-class-names.js', 'backfill-gps-steps.js']) {
  const src = path.join(ROOT, 'tools', name);
  if (fs.existsSync(src)) addFile(`tools/${name}`, src, { lf: true });
}

// ---------- 可选的「预设连接串」：只进 tar 包，不落仓库 ----------
// 用法：node tools/make-linux-bundle.js --mongo-uri='mongodb://用户:密码@127.0.0.1:27017/?authSource=admin'
// 目的：私有部署时省掉「装完再手改 .env」这一步。因为 dist/ 已在 .gitignore 里，
//       凭据只会存在于你本机的产物中，不会进版本库；同时也被下面的安全闸门显式豁免。
const mongoUriArg = (process.argv.find((a) => a.startsWith('--mongo-uri=')) || '').slice('--mongo-uri='.length);
if (mongoUriArg) {
  manifest.push({
    relInPkg: 'deploy/preset.env',
    content: Buffer.from(`# 部署包预设（由 tools/make-linux-bundle.js --mongo-uri 注入）\n# 仅存在于本产物中，不进入版本库。install.sh 会把它合并进 server/.env。\nMONGO_URI=${mongoUriArg.trim()}\n`, 'utf8'),
    executable: false,
    allowSecret: true, // 明确声明：本文件就是承载凭据的，跳过扫描
  });
  fileCount += 1;
}

// ---------- 安全闸门：任何命中真实凭据特征的文件都不许进包 ----------
const BANNED_PATTERNS = [
  /^server\/\.env$/,
  /^server\/uploads\//,
  /^server\/node_modules\//,
  /^miniprogram\/config\/env\.js$/,
];
const hits = manifest.filter((m) => BANNED_PATTERNS.some((re) => re.test(m.relInPkg)));
if (hits.length) {
  console.error('[bundle] 拒绝打包：以下文件含真实凭据 / 不应分发：');
  for (const h of hits) console.error('  -', h.relInPkg);
  process.exit(1);
}

// 内容级检查：包里不能出现看起来像真实密钥的长十六进制串（示例文件里的占位符不算）
// 注：looksLikeRealMongoUri 定义在文件开头（与 --selftest 共用同一份规则，避免两处漂移）
const SECRET_DANGER = [];
for (const m of manifest) {
  // 显式声明 allowSecret 的文件（deploy/preset.env，由 --mongo-uri 注入的私有预设）跳过扫描
  if (m.allowSecret) continue;
  const text = m.content.toString('utf8');
  // JWT_SECRET=<64位以上十六进制>
  const mm = text.match(/JWT_SECRET\s*=\s*([a-f0-9]{48,})/i);
  if (mm) SECRET_DANGER.push(`${m.relInPkg}: 疑似真实 JWT_SECRET`);
  // 微信 AppSecret（32 位十六进制）直接出现在配置里
  const aw = text.match(/WX_APPSECRET\s*=\s*([a-f0-9]{32})\b/i);
  if (aw) SECRET_DANGER.push(`${m.relInPkg}: 疑似真实 WX_APPSECRET`);
  // MongoDB 连接串：逐行判定（见 looksLikeRealMongoUri 注释）
  if (text.split('\n').some(looksLikeRealMongoUri)) {
    SECRET_DANGER.push(`${m.relInPkg}: 疑似真实 MongoDB 连接串（含账号密码）`);
  }
}

if (SECRET_DANGER.length) {
  console.error('[bundle] 拒绝打包：检测到疑似真实凭据：');
  for (const s of SECRET_DANGER) console.error('  -', s);
  process.exit(1);
}

// ---------- 写出 tar.gz ----------
fs.mkdirSync(OUT_DIR, { recursive: true });

/**
 * 自己写 ustar 头，不依赖 bsdtar：
 * Windows 上 fs.chmod 是空操作，bsdtar 打出来的 .sh 会是 0664（没有可执行位），
 * 用户必须先 `chmod +x` 才能 `./deploy/install.sh`。这里直接控制 mode 字段。
 */
function tarHeader({ name, size, mode, type }) {
  const buf = Buffer.alloc(512, 0);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    // ustar 支持 prefix(155) + name(100)：在分隔处切开
    const parts = name.split('/');
    let i = parts.length - 1;
    base = parts[i];
    while (i > 0 && Buffer.byteLength(parts.slice(0, i).join('/')) > 155) i -= 1;
    prefix = parts.slice(0, i).join('/');
    base = parts.slice(i).join('/');
    if (Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) {
      throw new Error(`路径过长，无法写入 ustar 头：${name}`);
    }
  }
  const write = (str, offset, len) => buf.write(str, offset, len, 'utf8');
  write(base, 0, 100);
  write((mode & 0o7777).toString(8).padStart(7, '0') + '\0', 100, 8);
  write('0000000\0', 108, 8); // uid
  write('0000000\0', 116, 8); // gid
  write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12);
  buf.write('        ', 148, 8, 'utf8'); // 校验和占位（8 空格）
  write(type, 156, 1); // '0' 文件 / '5' 目录
  write('ustar\0', 257, 6);
  write('00', 263, 2);
  write(prefix, 345, 155);
  // 校验和：整头按字节求和
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += buf[i];
  write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return buf;
}

function pad512(n) {
  const rem = n % 512;
  return rem === 0 ? 0 : 512 - rem;
}

// 目录条目（确保解压后目录权限统一 0755，且空目录也能建出来）
const dirs = new Set();
for (const m of manifest) {
  const parts = m.relInPkg.split('/');
  for (let i = 1; i <= parts.length; i += 1) {
    const dir = `${PKG_NAME}/${parts.slice(0, i).join('/')}`;
    if (i < parts.length) dirs.add(dir);
  }
}

const chunks = [];
for (const dir of [...dirs].sort()) {
  chunks.push(tarHeader({ name: `${dir}/`, size: 0, mode: 0o755, type: '5' }));
}
for (const m of manifest.sort((a, b) => (a.relInPkg < b.relInPkg ? -1 : 1))) {
  const name = `${PKG_NAME}/${m.relInPkg}`;
  const mode = m.executable ? 0o755 : 0o644;
  chunks.push(tarHeader({ name, size: m.content.length, mode, type: '0' }));
  chunks.push(m.content);
  const pad = pad512(m.content.length);
  if (pad) chunks.push(Buffer.alloc(pad, 0));
}
// 结束块：两个 512 全零
chunks.push(Buffer.alloc(1024, 0));

const tarBuf = Buffer.concat(chunks);
const gz = require('zlib').gzipSync(tarBuf, { level: 9 });
fs.writeFileSync(TARBALL, gz);

const sizeMb = (fs.statSync(TARBALL).size / 1024 / 1024).toFixed(2);
console.log(`\n[bundle] 打包完成：${path.relative(ROOT, TARBALL)}`);
console.log(`[bundle] 版本 ${VERSION} · ${fileCount} 个文件 · ${sizeMb} MB`);
console.log('[bundle] 已排除：node_modules / .env / uploads / tmp / 调试脚本');
console.log('[bundle] 已做凭据扫描：未发现真实密钥');
console.log('[bundle] install.sh 权限：0755（解压后可直接 ./deploy/install.sh）');
