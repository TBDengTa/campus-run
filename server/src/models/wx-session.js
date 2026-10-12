const mongoose = require('mongoose');

// 微信会话密钥，用于解密微信运动数据
const wxSessionSchema = new mongoose.Schema(
  {
    openid: { type: String, required: true, unique: true },
    sessionKey: { type: String, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('WxSession', wxSessionSchema, 'wx_sessions');
