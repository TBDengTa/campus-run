/**
 * 北斗运动音效（**零资源文件**，运行时合成 WAV）。
 *
 * 为什么不用 mp3：主包已经 3.10MB（上限 2MB，超 1.1MB），再塞音频文件是雪上加霜；
 * 而把 mp3 放分包又会有「首抽前要下载分包」的延迟，正卡在最需要声音的那一刻。
 * 所以这里用纯 JS 合成 16bit PCM WAV（几个音符，几十毫秒），写进用户目录后复用。
 *
 * 三条硬约束（改之前先读）：
 *   ① **失败一律静默**：合成失败 / 写文件失败 / 播放失败 → 只 console.warn，
 *      **绝不影响抽奖与入账**。音效是锦上添花，不能成为新的故障点。
 *   ② **首次播放必须在用户手势同一个 tick 里发起**：iOS 上不在手势内创建的音频上下文
 *      可能永久静音（用户听到的是「没有音效」，且无任何报错）。
 *   ③ **遵守系统静音**：obeyMuteSwitch = true（iOS 侧边静音键按下就不响）。
 *
 * 音效设计（三档，与动效三档对齐）：
 *   normal 普通中奖 —— 两个上行短音（C5 → E5），约 180ms
 *   rare   稀有     —— 三个上行音（C5 → E5 → G5），约 300ms
 *   rarest 最稀有   —— 四个音 + 高八度尾音（C5 → E5 → G5 → C6），约 520ms
 *   none   空奖     —— 一个下行短音（G4 → E4），轻，不刺耳
 */

const FS_NAME = {
  normal: 'bd_win_normal.wav',
  rare: 'bd_win_rare.wav',
  rarest: 'bd_win_rarest.wav',
  none: 'bd_win_none.wav',
};

const SAMPLE_RATE = 16000; // 16k 足够（只是提示音），文件小、合成快

// 音符表（频率 Hz）
const NOTE = { G4: 392, E4: 330, C5: 523, E5: 659, G5: 784, C6: 1047 };

// 每档音效的音符序列：[频率, 时长ms]
const SEQUENCES = {
  normal: [[NOTE.C5, 90], [NOTE.E5, 110]],
  rare: [[NOTE.C5, 80], [NOTE.E5, 80], [NOTE.G5, 140]],
  rarest: [[NOTE.C5, 70], [NOTE.E5, 70], [NOTE.G5, 100], [NOTE.C6, 220]],
  none: [[NOTE.G4, 90], [NOTE.E4, 120]],
};

/**
 * 合成 WAV（16bit 单声道 PCM）。
 *
 * 每个音符用「正弦 + 指数衰减包络」：纯正弦听起来像电报音，加包络才有「叮」的质感。
 * 结尾留 10ms 静音，避免播放器把尾部爆音（click）放出来。
 *
 * @param {Array<[number, number]>} seq [[频率, 时长ms], ...]
 * @returns {{buffer: ArrayBuffer|Uint8Array, sampleCount:number}}
 */
function synthWav(seq) {
  const totalMs = seq.reduce((s, [, ms]) => s + ms, 0) + 10;
  const sampleCount = Math.floor((SAMPLE_RATE * totalMs) / 1000);
  const dataBytes = sampleCount * 2; // 16bit
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);

  // ---- WAV 头（44 字节，标准 RIFF）----
  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  // ---- 采样点 ----
  let cursor = 0;
  for (const [freq, ms] of seq) {
    const need = Math.floor((SAMPLE_RATE * ms) / 1000);
    for (let i = 0; i < need; i += 1) {
      const t = i / SAMPLE_RATE;
      // 指数衰减包络：起音立即到峰值，然后 ~5 个时间常数内衰到接近 0
      const env = Math.exp((-5 * i) / need);
      // 正弦，振幅 0.32（留足余量，多个音叠加也不削波）
      const v = Math.sin(2 * Math.PI * freq * t) * env * 0.32;
      const pcm = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
      view.setInt16(44 + cursor * 2, pcm, true);
      cursor += 1;
    }
  }
  // 尾部静音（cursor 之后默认就是 0，不必写）
  return { buffer: buf, sampleCount };
}

// ===== 运行时状态（模块级单例，跨页面重进复用）=====
let ctx = null; // InnerAudioContext 单例
let ctxSrc = ''; // 当前 ctx 绑定的文件路径
let audioReady = false; // 至少成功prepare过一次
let disabled = false; // 运行时失败后永久关闭（本次会话内不再重试）
const fileCache = new Map(); // 档位 -> 已写入的文件路径

// storage 键：用户手动关闭音效
const STORAGE_KEY = 'tt_beidou_sfx_off';

function userMuted() {
  try {
    if (typeof wx === 'undefined' || !wx.getStorageSync) return false;
    return !!wx.getStorageSync(STORAGE_KEY);
  } catch (e) {
    return false;
  }
}

function setUserMuted(off) {
  try {
    if (typeof wx === 'undefined') return;
    if (off) wx.setStorageSync(STORAGE_KEY, 1);
    else wx.removeStorageSync(STORAGE_KEY);
  } catch (e) {
    /* storage 不可用就只影响本次会话 */
  }
}

/** 把某档音效写到用户目录，返回路径（失败返回 ''） */
function ensureFile(kind) {
  if (fileCache.has(kind)) return fileCache.get(kind);
  const name = FS_NAME[kind];
  if (!name) return '';
  try {
    // typeof 保护：非小程序环境（检查器/自检脚本）里 wx 可能未定义，
    // 直接访问会抛 ReferenceError。这里返回 '' 即可，调用方会静默跳过。
    if (typeof wx === 'undefined') return '';
    const fsm = wx.getFileSystemManager && wx.getFileSystemManager();
    if (!fsm) return '';
    const dir = wx.env && wx.env.USER_DATA_PATH;
    if (!dir) return '';
    const path = `${dir}/${name}`;
    // 已存在就复用（避免每次进页面重写）
    try {
      fsm.accessSync(path);
      fileCache.set(kind, path);
      return path;
    } catch (e) {
      /* 不存在，继续写 */
    }
    const seq = SEQUENCES[kind];
    if (!seq) return '';
    const { buffer } = synthWav(seq);
    fsm.writeFileSync(path, buffer, 'binary');
    fileCache.set(kind, path);
    return path;
  } catch (e) {
    console.warn('[sfx] 写入音效文件失败（本次静默，不影响抽奖）', e && e.message);
    return '';
  }
}

/** 确保 InnerAudioContext 单例就绪；失败返回 null */
function ensureCtx() {
  if (ctx) return ctx;
  if (typeof wx === 'undefined') return null;
  if (!wx.createInnerAudioContext) return null;
  ctx = wx.createInnerAudioContext();
  // iOS 尊重系统静音键：地铁/开会场景不该突然出声
  ctx.obeyMuteSwitch = true;
  ctx.autoplay = false;
  ctx.onError((err) => {
    console.warn('[sfx] 音频播放出错（本次静默）', err && err.errMsg);
    disabled = true;
  });
  return ctx;
}

/**
 * 播放一档音效。**永不抛异常**（调用方可以裸调）。
 *
 * @param {'normal'|'rare'|'rarest'|'none'} kind
 * @param {{force?:boolean}} [opts] force=true 忽略用户静音（目前未用，留给调试）
 * @returns {boolean} 是否真的发起了播放
 */
function play(kind, opts = {}) {
  if (disabled) return false;
  if (!opts.force && userMuted()) return false;
  try {
    const path = ensureFile(kind);
    if (!path) return false;
    const c = ensureCtx();
    if (!c) return false;
    // 同一实例换曲目要重新 set src；换了 src 需要重新 play
    if (ctxSrc !== path) {
      c.src = path;
      ctxSrc = path;
    }
    c.seek && c.seek(0);
    c.play();
    audioReady = true;
    return true;
  } catch (e) {
    console.warn('[sfx] 播放失败（本次静默）', e && e.message);
    disabled = true;
    return false;
  }
}

/** 震动分级（与音效三档对齐）。不支持的平台静默跳过。 */
function vibrate(kind) {
  try {
    if (typeof wx === 'undefined' || !wx.vibrateShort) return;
    if (kind === 'rarest') {
      wx.vibrateShort({ type: 'heavy' });
      setTimeout(() => {
        try {
          wx.vibrateShort({ type: 'heavy' });
        } catch (e) {
          /* 第二下失败无所谓 */
        }
      }, 140);
      return;
    }
    if (kind === 'rare') {
      wx.vibrateShort({ type: 'medium' });
      return;
    }
    if (kind === 'none') return; // 空奖不震（负反馈别做得太重）
    wx.vibrateShort({ type: 'light' });
  } catch (e) {
    /* 震动不可用完全不影响业务 */
  }
}

/**
 * 预热：必须在**用户手势的同步栈**里调用（如 tap handler 开头）。
 *
 * 为什么需要：iOS 上 `InnerAudioContext` 如果不是在用户手势里首次创建，
 * 之后的 `play()` 可能被静默忽略（无报错、无声）。抽奖是**异步**请求（await 之后才 play），
 * 那时已经脱离手势上下文 —— 所以在点抽奖的那一刻先把它建好、把文件备好。
 *
 * 幂等：重复调用只做存在性检查，开销可忽略。永不抛。
 */
function prewarm() {
  if (disabled || userMuted()) return false;
  try {
    // 预建上下文（关键：发生在手势栈内）
    const c = ensureCtx();
    if (!c) return false; // 没有音频能力（wx 缺失/不支持 InnerAudioContext）
    // 预写最可能用到的两档文件（普通与稀有），避免播放时同步写盘造成卡顿
    const a = ensureFile('normal');
    const b = ensureFile('rare');
    return !!(a || b);
  } catch (e) {
    return false;
  }
}

module.exports = {
  synthWav,
  prewarm,
  play,
  vibrate,
  userMuted,
  setUserMuted,
  // 测试用
  _internal: { SEQUENCES, SAMPLE_RATE, FS_NAME },
};
