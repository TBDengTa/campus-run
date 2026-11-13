/**
 * 端到端验证：检查照片「解除所有上传限制」（用户 2026-11-12）
 *
 * 真连库、真挂 routes/upload.js（auth 按 header 打桩），上传一个 **20MB** 的临时文件：
 *   · 旧实现：服务端 100MB / 前端压缩策略，20MB 本身能过，但这条用例锁的是「没有隐性上限」；
 *   · 现在：服务端不设 fileSize、nginx client_max_body_size 0，照片原图直传。
 * 同时验证：
 *   · 非学生会成员仍然 403（限制解除的是「照片大小/张数/画质」，不是身份校验）；
 *   · normalizeDetails 收 12 张照片不再截断（旧实现静默丢 3 张）。
 *
 * 跑完删文件与临时账号，核对残留为 0。
 * 用法：node tools/verify-check-photo-unlimited.js
 */
const path = require('path');
const fs = require('fs');
const serverDir = path.join(__dirname, '..', 'server');
const config = require(path.join(serverDir, 'src', 'config'));
const mongoose = require(path.join(serverDir, 'node_modules', 'mongoose'));
const express = require(path.join(serverDir, 'node_modules', 'express'));

const User = require(path.join(serverDir, 'src', 'models', 'user'));
const UnionMember = require(path.join(serverDir, 'src', 'models', 'union-member'));
const FileObject = require(path.join(serverDir, 'src', 'models', 'file-object'));
const checkModules = require(path.join(serverDir, 'src', 'services', 'check-modules'));
const { unlinkUpload } = require(path.join(serverDir, 'src', 'utils', 'uploader'));
const unionSvc = require(path.join(serverDir, 'src', 'services', 'union'));

let failed = 0;
function assert(cond, label, extra) {
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '  ← ' + JSON.stringify(extra)}`);
  if (!cond) failed += 1;
}

const TS = Date.now();
const TAG = `photo_${TS}`;

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });

  const createdUsers = [];
  const createdMembers = [];
  let bigFile = '';

  const authMw = require(path.join(serverDir, 'src', 'middlewares', 'auth'));
  const actors = new Map();
  authMw.auth = (req, res, next) => {
    const who = req.headers['x-actor'] || '';
    const doc = actors.get(who);
    if (!doc) return res.status(401).json({ code: 401, message: '未登录' });
    req.user = doc;
    next();
  };
  const uploadRouter = require(path.join(serverDir, 'src', 'routes', 'upload'));
  const app = express();
  app.use('/api/upload', uploadRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || 500).json({ code: err.code || 500, message: err.message }));
  const port = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s.address().port));
  });
  const BASE = `http://127.0.0.1:${port}`;

  try {
    const member = await User.create({
      openid: `${TAG}_member`,
      account: `${TAG}_member`,
      realName: '照片验证-成员',
      role: 'student',
      className: `${TAG}_C`,
    });
    createdUsers.push(member._id);
    const outsider = await User.create({
      openid: `${TAG}_outsider`,
      account: `${TAG}_outsider`,
      realName: '照片验证-非成员',
      role: 'student',
      className: `${TAG}_C`,
    });
    createdUsers.push(outsider._id);
    const rec = await UnionMember.create({
      userId: member._id,
      openid: member.openid,
      realName: member.realName,
      level: 'school',
      deptKey: 'presidium',
      deptName: '主席团',
      role: 'president',
      status: 'active',
    });
    createdMembers.push(rec._id);
    unionSvc.clearIdentityCache(member.openid);

    actors.set('member', member);
    actors.set('outsider', outsider);

    const upload = async (who, bytes, name) => {
      const form = new FormData();
      // 20MB 的「图片」：服务端只校验类型（image/*），不解析像素，所以内容不必须是真图
      form.append('file', new Blob([Buffer.alloc(bytes, 7)], { type: 'image/jpeg' }), name);
      const res = await fetch(`${BASE}/api/upload/check-photo`, {
        method: 'POST',
        headers: { 'x-actor': who },
        body: form,
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };

    console.log('[1] 20MB 照片上传');
    const r1 = await upload('member', 20 * 1024 * 1024, 'big.jpg');
    assert(r1.status === 200 && r1.data.code === 0, '20MB 照片上传成功（无体积上限）', r1);
    assert(!!(r1.data && r1.data.data && r1.data.data.url), '返回可访问 URL', r1.data);

    console.log('\n[2] 非成员仍被拒');
    const r2 = await upload('outsider', 1024, 'x.jpg');
    assert(r2.status === 403 && r2.data.code === 403002, '非学生会成员 403（身份校验没被放开）', r2);

    console.log('\n[3] 记录照片不截断');
    const urls = Array.from({ length: 12 }, (_, i) => `https://example.com/p${i}.jpg`);
    const out = checkModules.normalizeDetails(
      { fields: [{ key: 'photos', type: 'photo' }] },
      { photos: urls }
    );
    assert(Array.isArray(out.photos) && out.photos.length === 12, '12 张照片全部保留（旧实现 slice(0,9) 丢 3 张）', out.photos);

    // 记录刚上传的文件名，供清理
    bigFile = String((r1.data && r1.data.data && r1.data.data.url) || '').split('/uploads/')[1] || '';
  } catch (e) {
    failed += 1;
    console.error('运行失败：', e);
  } finally {
    await FileObject.deleteMany({ uploader: { $in: createdUsers } });
    if (bigFile) unlinkUpload(bigFile);
    await UnionMember.deleteMany({ _id: { $in: createdMembers } });
    await User.deleteMany({ _id: { $in: createdUsers } });
    unionSvc.clearIdentityCache();

    const leftFiles = await FileObject.countDocuments({ uploader: { $in: createdUsers } });
    const leftMembers = await UnionMember.countDocuments({ userId: { $in: createdUsers } });
    const leftUsers = await User.countDocuments({ _id: { $in: createdUsers } });
    assert(leftFiles + leftMembers + leftUsers === 0, '清理核对：临时数据残留为 0', { leftFiles, leftMembers, leftUsers });

    await mongoose.disconnect();
    console.log(`\n照片上传限制端到端：${failed} 项失败`);
    process.exit(failed ? 1 : 0);
  }
})();
