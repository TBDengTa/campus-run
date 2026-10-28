/**
 * 示例账户管理接口（需 config.manage）。
 *
 * 用户 2026-10-24：「增加新的功能 示例账户 功能，创建 示例学生1(班长权限)、示例教师1(班主任权限)、
 * 示例学生2(学生会) 密码为123456，不自动绑定微信，并且在首次登录输入新的密码增加跳过功能」
 * 后续补充：微信「登录时自行绑定也不能绑定」→ 示例账号的绑定可被任意微信抢占、退出登录自动解绑。
 *
 * 权限：**config.manage**（与系统配置同级）——示例账号能登录学生会复核界面，
 * 属于「能影响演示环境的事」，不该发给只有 user.view 的人。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { wrap, ok } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
const demo = require('../../services/demo-accounts');

const router = express.Router();

/**
 * 接口版本标记（排查用）。
 *
 * 背景（用户 2026-10-24「示例账户页一直显示未创建」，但库里账号确实存在）：
 * 本地逐层验证全对，唯一解释是**线上跑的后端 / 手机上编译的小程序不是最新版**。
 * 与其远程猜版本，不如让接口自报：
 *   · `apiVersion` 每次改这块就 +1；页面把它显示出来。
 *     老后端没有这个字段 → 页面显示「旧版本」，一眼确认部署没生效；
 *   · `build` = 代码文件时间，和部署动作对得上号。
 */
const API_VERSION = 'demo-rows-25';
let buildTag = '';
try {
  buildTag = fs.statSync(path.join(__dirname, '../../index.js')).mtime.toISOString();
} catch (e) {
  /* 读不到不影响接口 */
}

// 时间格式化（与前端展示口径一致：YYYY-MM-DD HH:mm）
function fmtTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 查看示例账号状态（是否已创建、是否已绑微信）
router.get(
  '/',
  requirePermission('config.view'),
  wrap(async (req, res) => {
    const list = await demo.listDemoAccounts();
    const specs = demo.DEMO_SPECS.map((s) => ({ key: s.key, label: s.label, desc: s.desc }));

    // **服务端直接把「定义 + 状态」合并成 rows 返回**。
    //
    // 为什么不让前端自己合并（用户 2026-10-24 报「创建后示例账户页仍显示未创建」）：
    //   前端旧实现遍历 specs、用 list[index] 取状态；只要 list 为空 / 少一条 / 顺序变化，
    //   状态就整体错位成「未创建」，而且**不报错**（渲染的是 undefined.exists）。
    //   合并放在唯一的权威侧后，客户端无论怎么遍历都不会错位；
    //   byKey 用 Map 而不是下标，从根上消除「顺序依赖」。
    const byKey = new Map(list.map((it) => [it.key, it]));
    const rows = specs.map((s) => {
      const st = byKey.get(s.key) || {};
      return {
        key: s.key,
        label: s.label,
        desc: s.desc,
        exists: !!st.exists,
        bound: !!st.bound,
        boundAt: st.boundAt || null,
        boundAtText: st.boundAt ? fmtTime(st.boundAt) : '',
        lastLoginAt: st.lastLoginAt || null,
        passwordChangeSkipped: !!st.passwordChangeSkipped,
        diag: st.diag || null, // 未命中时的诊断（查了什么 / 库里有什么）
      };
    });

    ok(res, {
      apiVersion: API_VERSION,
      build: buildTag,
      db: demo.dbInfo(), // 连的是哪个库（主机+库名，不含凭据）
      password: demo.DEMO_PASSWORD,
      className: demo.DEFAULT_CLASS,
      specs,
      list,
      rows, // 首选：前端直接用这个（已按 key 合并，不会错位）
      anyExists: rows.some((x) => x.exists),
    });
  })
);

// 创建 / 重置（幂等）
router.post(
  '/seed',
  requirePermission('config.manage'),
  wrap(async (req, res) => {
    const className = String((req.body && req.body.className) || '').trim();
    const result = await demo.seedDemoAccounts({ className });
    ok(res, {
      ...result,
      password: demo.DEMO_PASSWORD,
      message: `示例账户已就绪（班级：${result.className}，统一密码 ${demo.DEMO_PASSWORD}）`,
    });
  })
);

// 解绑某个示例账号的微信（换人测试时用；退出登录也会自动调这一逻辑）
router.post(
  '/:key/unbind',
  requirePermission('config.manage'),
  wrap(async (req, res) => {
    const result = await demo.releaseDemoBinding(req.params.key);
    ok(res, result);
  })
);

// 全部清理（只删示例账号与学生会记录，**不动班级与真实学生**）
router.delete(
  '/',
  requirePermission('config.manage'),
  wrap(async (req, res) => {
    const result = await demo.removeDemoAccounts();
    ok(res, result);
  })
);

module.exports = router;
