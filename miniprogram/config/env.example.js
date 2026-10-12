// 环境配置示例：复制本文件为同目录 env.js（已被 .gitignore 忽略）并填入真实地址
// env.js 不会提交到仓库，真实服务器地址只存在于本地
module.exports = {
  // 后端 API 基础地址（必须是 https 且已加入小程序 request 合法域名）
  BASE_URL: 'https://your-server.example.com',
  // 广告落地页 H5 基础地址（web-view 业务域名）
  AD_PAGE_BASE_URL: 'https://your-adpage-domain.example.com',

  // ===== 本地测试登录（配合后端 DEV_LOGIN=true 使用）=====
  // 开启后不走微信登录，直接用约定账号，便于本地切换角色测试
  DEV_LOGIN: false,
  // 可选值：dev-student（学生视角）/ dev-teacher（教师视角）/ dev-admin（管理员视角）
  DEV_ROLE: 'dev-student',
};
