/**
 * 首屏广告几何核算：node tools/ad-above-fold.js
 *
 * 用途：产品要求四个横幅（+我的页）**首屏不滚动即可见**，而开发者工具自动化端口关闭、
 *       真机填充拿不到 → 这里用「WXSS 里写死的尺寸 + 页面 ad-banner 之前的兄弟节点」静态算出：
 *         广告块 top / 广告块高 / top+高 / 首屏高（windowHeight）/ 余量 / 最近可点击元素间距
 *       全部数值都是 rpx（750rpx = 屏宽）。所有尺寸都标了来源（哪条 WXSS 规则），便于复核。
 *
 * 口径与前提（页面里也都注释了）：
 *   · 首屏高 = 视口高 − 自定义导航栏（微信自绘导航 88rpx ≈ 44px），不扣 tabBar（这几个页面都不是 tab 页）；
 *   · 文字行高按 WXSS 显式 line-height 取值，没有显式 line-height 的按 fontSize × LINE_FACTOR 估；
 *     所以数字是**估算**：只要「top + 高 < 首屏高」且余量为正，就说明不滚动可见（余量越大越稳）；
 *   · 广告未填充时按占位高 200rpx 算（ad-banner.js 的 MIN_HEIGHT_RPX）——**最坏情况**；
 *     实测更矮时 top+高 只会更小，仍在首屏；
 *   · 饮水页是 variant="flow-fixed"：固定视口底部，top = 首屏高 − 广告高，必定在首屏内。
 */
const LINE_FACTOR = 1.5; // 未显式给 line-height 时：行高 ≈ fontSize × 1.5（微信默认 1.4~1.5，取保守值）
const NAVBAR_RPX = 88; // 微信自绘导航栏（44px @375px 宽）
const AD_MIN_RPX = 200; // ad-banner.js::MIN_HEIGHT_RPX（占位 = 最坏情况）
const AD_MARGIN_RPX = 24; // .ad-banner 的上/下外边距（var(--tt-gap)）
const CARD_MARGIN_RPX = 24; // .tt-card / .tt-hero / .tt-section 的外边距
const TT_PAGE_TOP_RPX = 24; // .tt-page padding-top

// 首屏场景（windowHeight 为微信 windowHeight，含导航栏）
const VIEWPORTS = [
  { name: 'iPhone SE/8 类（min 屏）', windowHeight: 1334 },
  { name: 'iPhone 13/14 (390×844)', windowHeight: 1624 },
];

// 每个页面：广告之前的兄弟节点栈（顺序即文档顺序）
// kind=fixed 表示从视口底部锚定（flow-fixed 形态）
const PAGES = [
  {
    page: 'pages/badges/badges',
    unit: 'adunit-09dddc560022022c',
    placement: '汇总卡之后、3 列矩阵之前',
    stack: [
      { label: '.tt-page padding-top', h: TT_PAGE_TOP_RPX, src: 'app.wxss .tt-page' },
      {
        label: '汇总卡 .badge-sum',
        h: 102,
        src: 'badges.wxss .badge-sum padding 20+20 ／ 内容 38rpx×1.2 + 10rpx 进度条 → 取 62',
      },
      { label: '卡片下外边距', h: CARD_MARGIN_RPX, src: 'app.wxss .tt-card margin-bottom' },
    ],
    nearestClickable: { label: '矩阵徽章格 .badge-cell（下方相邻，图片卡非按钮）', gapRpx: AD_MARGIN_RPX },
  },
  {
    page: 'pages/goal-plan/goal-plan',
    unit: 'adunit-431307a81dc3d26a',
    placement: '「当前生效目标」hero 之后、AI 智能匹配卡之前',
    stack: [
      { label: '.tt-page padding-top', h: TT_PAGE_TOP_RPX, src: 'app.wxss .tt-page' },
      {
        label: 'hero .tt-hero.gp-hero',
        h: 477,
        src: 'goal-plan.wxss + app.wxss：padding 34+30 ／ label 24×1.5=36 ／ name 10+42×1.25=63 ／ chips 18+33 ／ stats 30+26+81',
      },
      { label: 'hero 下外边距', h: CARD_MARGIN_RPX, src: 'app.wxss .tt-hero margin-bottom' },
    ],
    nearestClickable: {
      label: 'hero 内提示条「修改身体数据」（上方相邻）／下方 AI 匹配按钮',
      gapRpx: AD_MARGIN_RPX,
    },
  },
  {
    page: 'pages/body-data/body-data',
    unit: 'adunit-e21e9b1b1c5f690d',
    placement: 'BMI 概览卡 + 关键指标卡之后、编辑表单之前',
    stack: [
      { label: '.tt-page padding-top', h: TT_PAGE_TOP_RPX, src: 'app.wxss .tt-page' },
      {
        label: 'hero .tt-hero（BMI 概览）',
        h: 405,
        src: 'app.wxss .tt-hero padding 40+36 ／ body-data.wxss：top 41 ／ num 20+92+12 ／ tip 38 ／ meta 22+20+2+36 ／ 估 56',
      },
      { label: 'hero 下外边距', h: CARD_MARGIN_RPX, src: 'app.wxss .tt-hero margin-bottom' },
      { label: '分组标题「关键指标」', h: 73, src: 'app.wxss .tt-section margin 8+20 + 行高 30×1.5=45' },
      {
        label: '关键指标卡 .tt-card',
        h: 204,
        src: 'app.wxss .tt-card padding 32+32 ／ .tt-stat-value 40×1.2=48 + label 8+36 ／ .tt-divider+note 估 48',
      },
      { label: '卡片下外边距', h: CARD_MARGIN_RPX, src: 'app.wxss .tt-card margin-bottom' },
    ],
    nearestClickable: {
      label: '「保存并匹配目标计划」按钮（页面最下方，与广告同屏但相隔多个区块）',
      gapRpx: 0,
      note: '广告不与其相邻：中间隔着「编辑身体数据」分组 + 表单卡（见下方 spacing 明细）',
    },
  },
  {
    page: 'pages/profile/profile（我的页横幅自查）',
    unit: 'adunit-eeb7b18e406d94b1',
    placement: '「我的信息」卡（含学籍网格）之后、「累计数据」卡之前',
    stack: [
      { label: '.tt-page padding-top', h: TT_PAGE_TOP_RPX, src: 'app.wxss .tt-page' },
      {
        label: '身份卡 .tt-hero.id-card（含学籍网格）',
        h: 506,
        src: 'app.wxss .tt-hero padding 40+36 ／ profile.wxss .enroll-grid 24+18+4 + 3 行 ×(36+14) ／ .enroll-tip 2+32',
      },
      { label: '卡片下外边距', h: CARD_MARGIN_RPX, src: 'app.wxss .tt-hero margin-bottom' },
    ],
    nearestClickable: { label: '身份卡（头像按钮/学籍提示）在上方、累计数据卡在下方（非按钮）', gapRpx: AD_MARGIN_RPX },
  },
  {
    page: 'pages/water/water',
    unit: 'adunit-d3c555674f1c360c',
    placement: '首屏固定视口底部（variant="flow-fixed"，不占文档流）',
    fixed: true,
    stack: [],
    nearestClickable: {
      label: '「下滑记录喝水」提示文字（非按钮，舞台内）；「记一笔」快捷按钮在下一屏卡片',
      gapRpx: 24,
    },
  },
];

// 广告块与「最近主操作按钮」的间距明细（按页面结构算，全部 rpx）
const SPACING = [
  {
    page: 'pages/badges/badges',
    items: [
      { from: '广告块下沿', to: '汇总卡下沿', gap: AD_MARGIN_RPX, src: '.ad-banner margin-bottom 24 + .badge-grid padding-top 16（下面是图片卡，不是按钮）' },
    ],
  },
  {
    page: 'pages/body-data/body-data',
    items: [
      { from: '广告块下沿', to: '「保存并匹配目标计划」按钮上沿', gap: 512, src: '表单分组标题 73 + 表单卡（3×120 + 2×分隔 + padding 64）≈ 415 + 卡片下边距 24；≥24 ✅' },
    ],
  },
  {
    page: 'pages/goal-plan/goal-plan',
    items: [
      { from: 'hero 提示条下沿', to: '广告块上沿', gap: AD_MARGIN_RPX, src: '.tt-hero margin-bottom 24（相邻兄弟外边距，≥24 ✅）' },
      { from: '广告块下沿', to: '「AI 智能匹配我的目标」按钮上沿', gap: 131, src: '分组标题 .tt-section 53 + 卡片 padding-top 32 + 说明块 40 + 24 = 131；≥24 ✅' },
    ],
  },
  {
    page: 'pages/water/water',
    items: [
      { from: '舞台「下滑…」提示文字下沿', to: '横幅上沿', gap: 24, src: '横幅固定在视口底部、不占文档流；文字与视口底的距离由 --wt-ad-h 让位保证 ≥24 ✅' },
    ],
  },
];

const sum = (list) => list.reduce((n, it) => n + it.h, 0);

function report() {
  const lines = [];
  lines.push('首屏广告几何核算（rpx；750rpx = 屏宽）');
  lines.push(`前提：首屏高 = windowHeight − 自绘导航 ${NAVBAR_RPX}rpx；广告高按占位 ${AD_MIN_RPX}rpx（最坏情况）`);
  lines.push('');

  for (const vp of VIEWPORTS) {
    const fold = vp.windowHeight - NAVBAR_RPX;
    lines.push(`== 首屏场景：${vp.name}｜windowHeight=${vp.windowHeight} → 首屏可用高 ${fold}rpx`);
    for (const p of PAGES) {
      const top = sum(p.stack) + AD_MARGIN_RPX; // 广告块上沿（广告自身 margin-top 也占位）
      const adTop = p.fixed ? fold - AD_MIN_RPX : top;
      const adBottom = adTop + AD_MIN_RPX;
      const margin = fold - adBottom;
      // 判定：整块落在首屏内（fixed 贴底时底边 = 视口底，也算「不滚动就能看到」）
      const inFold = adTop >= 0 && adBottom <= fold;
      lines.push(
        `  ${p.page}  unit=${p.unit}\n` +
          `    位置：${p.placement}\n` +
          `    top=${adTop}  高=${AD_MIN_RPX}  top+高=${adBottom}  首屏高=${fold}  余量=${margin}  ` +
          `${inFold ? '✅ 不滚动可见' : '❌ 超出首屏'}`
      );
      for (const it of p.stack) lines.push(`      + ${it.h}rpx  ${it.label}  〔${it.src}〕`);
      lines.push(
        `      最近可点击元素：${p.nearestClickable.label}${p.nearestClickable.note ? '——' + p.nearestClickable.note : ''}`
      );
    }
    lines.push('');
  }

  lines.push('== 与最近按钮/主操作的间距（要求 ≥ 24rpx）');
  for (const s of SPACING) {
    lines.push(`  ${s.page}`);
    for (const it of s.items) lines.push(`    ${it.from} → ${it.to}：${it.gap}rpx ${it.gap >= 24 ? '✅' : '❌'}  〔${it.src}〕`);
  }
  lines.push('');
  lines.push('== 备注');
  lines.push('  · 广告未填充时占位 200rpx（最坏）；实测更矮 → top+高 更小，仍首屏可见；');
  lines.push('  · 广告加载失败只 console.error，占位保留、不跳动，页面功能不受影响；');
  lines.push('  · 教师账号 showAd=false → 整块不进 DOM，本核算的所有占位都不发生（0 请求、0 曝光）。');

  console.log(lines.join('\n'));
}

report();
