const mongoose = require('mongoose');

// 组织架构树：school → department → specialty
const organizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    type: { type: String, enum: ['school', 'department', 'specialty'], required: true, index: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    parentName: { type: String, default: '' },
    sort: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Organization', organizationSchema, 'organizations');
