const express = require('express');
const { auth } = require('../../middlewares/auth');
const { adminOnly } = require('../../middlewares/admin');

const router = express.Router();

// 管理端全部接口：登录态 + 管理员角色双重校验
router.use(auth, adminOnly);

router.use('/users', require('./users'));
router.use('/appeals', require('./appeals'));
router.use('/ads', require('./ads'));
router.use('/content', require('./content'));
router.use('/config', require('./config'));
router.use('/dashboard', require('./dashboard'));
router.use('/upload', require('./upload'));

module.exports = router;
