const mongoose = require('mongoose');

const { Schema } = mongoose;

const userSchema = new Schema(
  {
    openid: { type: String, required: true, unique: true },
    unionid: { type: String, index: true },
    nickname: { type: String, default: '' },
    avatarUrl: { type: String, default: '' },
    realName: { type: String, default: '' },
    studentId: { type: String, default: '', index: { unique: true, sparse: true } },
    schoolId: { type: Schema.Types.ObjectId, ref: 'Organization' },
    schoolName: { type: String, default: '' },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Organization' },
    departmentName: { type: String, default: '' },
    className: { type: String, default: '' },
    specialty: { type: String, default: '' },
    gender: { type: Number, default: 0 }, // 0 未知 1 男 2 女
    birthdate: { type: Date },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    status: { type: String, enum: ['active', 'banned'], default: 'active' },
    banReason: { type: String, default: '' },
    banType: { type: String, default: '' }, // sync 同步异常 / manual 人工
    bannedUntil: { type: Date },
    bannedAt: { type: Date },
    // 汇总缓存（由跑步记录聚合刷新）
    totalSteps: { type: Number, default: 0 },
    totalDistance: { type: Number, default: 0 }, // 米
    totalDays: { type: Number, default: 0 },
    lastSyncAt: { type: Date },
  },
  { timestamps: true }
);

userSchema.methods.toSafeJSON = function () {
  const obj = this.toJSON();
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('User', userSchema, 'users');
