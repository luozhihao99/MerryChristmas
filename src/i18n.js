/**
 * 三语支持：中文 / English / ไทย（泰语）。
 *
 * · 语言在首屏遮罩上选（.lang-pick 三个按钮），存 localStorage（键 tree.lang），
 *   下次进来自动预选上一次的选择；没存过就按浏览器语言猜（zh→中文、th→泰语、
 *   其余→英语）。
 * · 静态文案：HTML 元素挂 data-i18n="key"（文本）/ data-i18n-title="key"（title），
 *   applyStatic() 在启动和切换语言时统一刷一遍。
 * · 动态文案（加载进度、状态条、玩法提示、拉弓提示、音频错误）：main.js 里
 *   t('key') 现取；切换语言后下一次刷新文案时自然切过去。
 * · 粒子文字特效（love you 字幕、弹幕、miss you）保持原样不翻译 —— 那是画面，
 *   不是 UI。
 */

const STORE = 'tree.lang';

const STR = {
  zh: {
    'trackTitle.stream': '默认音乐 · 流式播放 · 鼓点驱动呼吸',
    'trackTitle.noSpec': '默认音乐 · 流式播放 · 读不到频谱，呼吸用内置节奏',
    'mp.cancel': '取消',
    'mp.connect': '正在连接…',
    'mp.loading': '正在载入 {p}%',
    'mp.slow': '网络较慢，仍在连接…',
    'mp.retry': '再试一次',
    'track.connect': '正在连接默认音乐…',
    'track.slow': '网络较慢，仍在连接音乐…',
    'track.timeout': '音乐加载超时，可以再试一次',
    'track.builtin': '内置节奏 · 点音乐换一首',
    docTitle: 'Merry Christmas · 手势粒子圣诞树',
    brandSub: '手势粒子圣诞树 · MediaPipe Hands × Three.js',
    btnMusic: '放入音乐',
    btnPlay: '播放',
    btnPause: '暂停',
    btnResume: '继续',
    btnHints: '玩法',
    btnHintsTitle: '显示 / 隐藏玩法一览',
    btnCam: '摄像头',
    btnCamTitle: '显示 / 隐藏摄像头小窗',
    btnCleanTitle: '清屏 · 只留画面（Esc 或右下角「菜单」恢复）',
    beatTitle: '鼓点',
    trackNone: '无音乐 · 内置律动',
    camOff: '摄像头未启动',
    handsUnit: '只手',
    scoreLabel: '礼物已接住',
    playPill: '点击播放音乐',
    cleanToast: '已进入清屏 · 右下角图标可退出（Esc 也行）',
    uncleanTitle: '退出清屏 · 显示菜单（Esc）',
    note: '请允许使用摄像头，举起双手即可开始',
    skip: '不等了，先看看树',
    'load.ready': '准备好了',
    'load.waking': '正在唤醒雪夜…',
    'load.needles': '正在铺开针叶…',
    'load.stage': '正在搭建舞台…',
    'load.connect': '正在连接手势模型…',
    'load.download': '正在下载手势模型 {a} / {b} MB',
    'load.finish': '正在收尾…',
    'load.webgl2': '当前浏览器不支持 WebGL2，请用 Chrome / Edge 打开',
    'gest.camWait': '正在等待摄像头…',
    'gest.handsUp': '把手举到镜头前',
    'gest.starting': '正在启动手势识别…',
    'gest.asking': '正在请求摄像头权限…',
    'ready.ok': '准备好了',
    'ready.fail': '摄像头未授权 · 进入音乐模式',
    'ready.timeout': '准备好了 · 手势马上可用',
    'audio.reading': '正在读取…',
    'audio.decoding': '正在解码音频…',
    'audio.stream': '流式播放',
    'audio.beat': '鼓点驱动呼吸',
    'audio.fail': '加载失败 · 点 ? 看支持格式',
    'audio.err.empty': '这个文件是空的 · 换一个试试',
    'audio.err.unsupported': '浏览器解不开这个格式 · 换 mp3 / m4a 试试（带版权保护的曲子不行）',
    'audio.err.encoding': '音频编码不支持 · 换标准 mp3 试试',
    'audio.err.generic': '音频加载失败 · 换 mp3 / m4a 试试，点 ? 看说明',
    'cam.noHttps': '当前为音乐模式 · 摄像头需要 https 或 localhost',
    'cam.needHttps': '摄像头需要 https · 当前为音乐模式',
    'cam.denied': '摄像头未授权 · 当前为音乐模式',
    'camOff.needHttps': '需要 https 才能用摄像头',
    'camOff.denied': '摄像头未授权',
    wechat: '微信内不能选文件 · 请用浏览器打开',
    'tip.bow': '试试 · 双手拉弓：两手一前一后拉开，松手放箭',
    'tip.spread': '试试 · 双手张开合拢：缩放整棵树',
    'tip.slide': '试试 · 侧掌扇风：掌心朝侧左右挥，树会转起来',
    'tip.heart': '试试 · 双手比心：两手指尖并拢，停住别动',
    'tip.call': '试试 · 打电话：拇指 + 小指伸出，放一盏孔明灯',
    'tip.like': '试试 · 点赞：竖起大拇指，撒一蓬金箔',
    'tip.ok': '试试 · 单手 OK：拇指食指成圈，流星雨 + 烟花',
    'bowtip.shot': '箭已出弦 · 再拉一次',
    'bowtip.full': '已拉满 · 两手一松就放箭',
    'bowtip.mid': '继续拉 · 松手立即放箭',
    'bowtip.low': '两手再拉开一点',
    'bowtip.start': '两手指尖分开 · 一只手半握',
    rippleOff: '水波纹特效已关闭（main.js 的 RIPPLE_ENABLED）',
    statusBoot: '正在加载模型…',
    mpTitle: '先听一首歌？',
    mpDesc: '模型和摄像头还在准备，这几秒可以先听着。',
    mpYes: '开启音乐',
    mpNo: '先不用',
    'hint.fist': '握拳|树体收拢、彩灯转暗',
    'hint.bow': '双手拉弓|两手一前一后拉开 → 松手放箭',
    'hint.spread': '双手开合|缩放整棵树',
    'hint.clap': '拍手|爆雪 + 星光',
    'hint.slide': '侧掌扇风|掌心朝侧 · 左右扇 → 树绕轴转',
    'hint.tray': '掌心向上|托盘接礼物',
    'hint.heart': '双手比心|两手各捏半心 · 并拢停住',
    'hint.call': '打电话|拇指 + 小指伸出 · 放一盏孔明灯',
    'hint.like': '点赞|拇指竖起 · 四指收回 · 金箔纸屑',
    'hint.ok': '单手 OK|拇指食指成圈 · 三指伸开 · 爱心 + 流星 + 烟花',
  },

  en: {
    'trackTitle.stream': 'Default music · streaming · beats drive the breathing',
    'trackTitle.noSpec': 'Default music · streaming · spectrum blocked, breathing on internal groove',
    'mp.cancel': 'Cancel',
    'mp.connect': 'Connecting…',
    'mp.loading': 'Loading {p}%',
    'mp.slow': 'Slow network · still connecting…',
    'mp.retry': 'Retry',
    'track.connect': 'Connecting default music…',
    'track.slow': 'Slow network · still loading music…',
    'track.timeout': 'Music load timed out · try again',
    'track.builtin': 'Built-in groove · add music to change',
    docTitle: 'Merry Christmas · Gesture Particle Tree',
    brandSub: 'Gesture Particle Tree · MediaPipe Hands × Three.js',
    btnMusic: 'Add music',
    btnPlay: 'Play',
    btnPause: 'Pause',
    btnResume: 'Resume',
    btnHints: 'Gestures',
    btnHintsTitle: 'Show / hide gesture list',
    btnCam: 'Camera',
    btnCamTitle: 'Show / hide camera preview',
    btnCleanTitle: 'Clean view · visuals only (Esc or the ☰ button restores)',
    beatTitle: 'Beat',
    trackNone: 'No music · built-in groove',
    camOff: 'Camera not started',
    handsUnit: 'hands',
    scoreLabel: 'gifts caught',
    playPill: 'Tap to play music',
    cleanToast: 'Clean view · tap the corner icon to exit (Esc works too)',
    uncleanTitle: 'Exit clean view · show menu (Esc)',
    note: 'Allow camera access, then raise both hands',
    skip: 'Skip the rest · see the tree',
    'load.ready': 'Ready',
    'load.waking': 'Waking up the snow night…',
    'load.needles': 'Spreading the needles…',
    'load.stage': 'Building the stage…',
    'load.connect': 'Connecting the hand model…',
    'load.download': 'Downloading hand model {a} / {b} MB',
    'load.finish': 'Finishing up…',
    'load.webgl2': 'WebGL2 is not supported — please use Chrome or Edge',
    'gest.camWait': 'Waiting for the camera…',
    'gest.handsUp': 'Raise your hands to the camera',
    'gest.starting': 'Starting hand tracking…',
    'gest.asking': 'Asking for camera access…',
    'ready.ok': 'Ready',
    'ready.fail': 'Camera blocked · music mode',
    'ready.timeout': 'Ready · hand tracking will finish shortly',
    'audio.reading': 'Reading…',
    'audio.decoding': 'Decoding audio…',
    'audio.stream': 'streaming',
    'audio.beat': 'beat-driven groove',
    'audio.fail': 'Load failed · tap ? for supported formats',
    'audio.err.empty': 'This file is empty · try another one',
    'audio.err.unsupported': "The browser can't decode this format · try mp3 / m4a (DRM files won't work)",
    'audio.err.encoding': 'Audio encoding unsupported · try a standard mp3',
    'audio.err.generic': 'Audio load failed · try mp3 / m4a, tap ? for help',
    'cam.noHttps': 'Music mode · camera needs https or localhost',
    'cam.needHttps': 'Camera needs https · music mode',
    'cam.denied': 'Camera blocked · music mode',
    'camOff.needHttps': 'Camera needs https',
    'camOff.denied': 'Camera blocked',
    wechat: "File picking is blocked in WeChat · open in a browser",
    'tip.bow': 'Try it · Draw a bow: pull both hands apart, release to fire',
    'tip.spread': 'Try it · Open & close hands: scale the whole tree',
    'tip.slide': 'Try it · Fan sideways: wave left-right, the tree spins',
    'tip.heart': 'Try it · Make a heart: put fingertips together and hold',
    'tip.call': 'Try it · Call me: thumb + pinky out, release a lantern',
    'tip.like': 'Try it · Thumbs up: a shower of golden confetti',
    'tip.ok': 'Try it · OK sign: meteor shower + fireworks',
    'bowtip.shot': 'Arrow away · draw again',
    'bowtip.full': 'Fully drawn · release hands to fire',
    'bowtip.mid': 'Keep pulling · release to fire',
    'bowtip.low': 'Pull your hands further apart',
    'bowtip.start': 'Spread fingertips · half-clench one hand',
    rippleOff: 'Ripple effect is off (RIPPLE_ENABLED in main.js)',
    statusBoot: 'Loading model…',
    mpTitle: 'Enjoy some music?',
    mpDesc: 'Play a tune while the model and camera get ready.',
    mpYes: 'Play',
    mpNo: 'Not now',
    'hint.fist': 'Fist|tree gathers in, lights dim',
    'hint.bow': 'Draw bow|pull hands apart → release to fire',
    'hint.spread': 'Open / close|scale the whole tree',
    'hint.clap': 'Clap|snow burst + stars',
    'hint.slide': 'Side fan|palm sideways · fan left-right → tree spins',
    'hint.tray': 'Palm up|catch gifts on a tray',
    'hint.heart': 'Heart|half-heart each hand · join and hold',
    'hint.call': 'Call|thumb + pinky out · release a lantern',
    'hint.like': 'Like|thumb up · golden confetti',
    'hint.ok': 'OK sign|thumb+index ring · heart + meteors + fireworks',
  },

  th: {
    'trackTitle.stream': 'เพลงเริ่มต้น · สตรีม · จังหวะขับการหายใจ',
    'trackTitle.noSpec': 'เพลงเริ่มต้น · สตรีม · อ่านสเปกตรัมไม่ได้ ใช้จังหวะในตัว',
    'mp.cancel': 'ยกเลิก',
    'mp.connect': 'กำลังเชื่อมต่อ…',
    'mp.loading': 'กำลังโหลด {p}%',
    'mp.slow': 'เน็ตช้า กำลังเชื่อมต่อ…',
    'mp.retry': 'ลองอีกครั้ง',
    'track.connect': 'กำลังเชื่อมต่อเพลงเริ่มต้น…',
    'track.slow': 'เน็ตช้า กำลังโหลดเพลง…',
    'track.timeout': 'โหลดเพลงหมดเวลา · ลองใหม่ได้',
    'track.builtin': 'จังหวะในตัว · ใส่เพลงเพื่อเปลี่ยน',
    docTitle: 'Merry Christmas · ต้นคริสต์มาสอนุภาคท่าทาง',
    brandSub: 'ต้นคริสต์มาสอนุภาค · MediaPipe Hands × Three.js',
    btnMusic: 'ใส่เพลง',
    btnPlay: 'เล่น',
    btnPause: 'พัก',
    btnResume: 'เล่นต่อ',
    btnHints: 'วิธีเล่น',
    btnHintsTitle: 'แสดง / ซ่อนรายการท่าทาง',
    btnCam: 'กล้อง',
    btnCamTitle: 'แสดง / ซ่อนหน้าต่างกล้อง',
    btnCleanTitle: 'ซ่อน UI · เหลือแต่ภาพ (กด Esc หรือไอคอน ☰ เพื่อกลับ)',
    beatTitle: 'จังหวะ',
    trackNone: 'ยังไม่มีเพลง · จังหวะในตัว',
    camOff: 'กล้องยังไม่เปิด',
    handsUnit: 'มือ',
    scoreLabel: 'ของขวัญที่รับได้',
    playPill: 'แตะเพื่อเปิดเพลง',
    cleanToast: 'ซ่อน UI แล้ว · แตะไอคอนมุมล่างขวาเพื่อกลับ (กด Esc ก็ได้)',
    uncleanTitle: 'กลับจากโหมดซ่อน UI · แสดงเมนู (Esc)',
    note: 'อนุญาตกล้อง แล้วยกสองมือขึ้นเพื่อเริ่ม',
    skip: 'ไม่รอแล้ว · ดูต้นไม้ก่อน',
    'load.ready': 'พร้อมแล้ว',
    'load.waking': 'กำลังปลุกคืนที่หิมะตก…',
    'load.needles': 'กำลังกางกิ่งสน…',
    'load.stage': 'กำลังสร้างเวที…',
    'load.connect': 'กำลังเชื่อมต่อโมเดลจับมือ…',
    'load.download': 'กำลังดาวน์โหลดโมเดลมือ {a} / {b} MB',
    'load.finish': 'กำลังตกแต่งขั้นสุดท้าย…',
    'load.webgl2': 'เบราว์เซอร์นี้ไม่รองรับ WebGL2 · กรุณาใช้ Chrome หรือ Edge',
    'gest.camWait': 'กำลังรอกล้อง…',
    'gest.handsUp': 'ยกสองมือขึ้นตรงหน้ากล้อง',
    'gest.starting': 'กำลังเริ่มระบบจับท่าทาง…',
    'gest.asking': 'กำลังขอสิทธิ์เข้าถึงกล้อง…',
    'ready.ok': 'พร้อมแล้ว',
    'ready.fail': 'กล้องถูกปฏิเสธ · เข้าโหมดเพลง',
    'ready.timeout': 'พร้อมแล้ว · ระบบจับท่าทางกำลังจะพร้อม',
    'audio.reading': 'กำลังอ่าน…',
    'audio.decoding': 'กำลังถอดรหัสเสียง…',
    'audio.stream': 'เล่นแบบสตรีม',
    'audio.beat': 'จังหวะขับเคลื่อน',
    'audio.fail': 'โหลดไม่สำเร็จ · แตะ ? เพื่อดูฟอร์แมตที่รองรับ',
    'audio.err.empty': 'ไฟล์นี้ว่างเปล่า · ลองไฟล์อื่น',
    'audio.err.unsupported': 'เบราว์เซอร์ถอดรหัสฟอร์แมตนี้ไม่ได้ · ลอง mp3 / m4a (ไฟล์มี DRM ใช้ไม่ได้)',
    'audio.err.encoding': 'ไม่รองรับการเข้ารหัสเสียงนี้ · ลอง mp3 มาตรฐาน',
    'audio.err.generic': 'โหลดเพลงไม่สำเร็จ · ลอง mp3 / m4a แตะ ? เพื่อดูวิธีใช้',
    'cam.noHttps': 'โหมดเพลง · กล้องต้องใช้ https หรือ localhost',
    'cam.needHttps': 'กล้องต้องใช้ https · โหมดเพลง',
    'cam.denied': 'กล้องถูกปฏิเสธ · โหมดเพลง',
    'camOff.needHttps': 'ต้องใช้ https จึงจะใช้กล้องได้',
    'camOff.denied': 'กล้องถูกปฏิเสธ',
    wechat: 'เลือกไฟล์ใน WeChat ไม่ได้ · กรุณาเปิดด้วยเบราว์เซอร์',
    'tip.bow': 'ลองเลย · สองมือดึงธนู: ดึงออกจากกันแล้วปล่อยเพื่อยิง',
    'tip.spread': 'ลองเลย · สองมือกาง-หุบ: ซูมต้นไม้ทั้งต้น',
    'tip.slide': 'ลองเลย · โบกฝ่ามือข้าง: โบกซ้ายขวา ต้นไม้จะหมุน',
    'tip.heart': 'ลองเลย · สองมือทำหัวใจ: ประกบนิ้วเป็นรูปหัวใจแล้วค้างไว้',
    'tip.call': 'ลองเลย · ท่าโทรศัพท์: กางนิ้วโป้ง + นิ้วก้อย เพื่อปล่อยโคมลอย',
    'tip.like': 'ลองเลย · ถูกใจ: ชูนิ้วโป้ง ได้เศษทองร่วง',
    'tip.ok': 'ลองเลย · ท่า OK: ดาวตก + พลุ',
    'bowtip.shot': 'ธนูออกจากสายแล้ว · ดึงอีกครั้ง',
    'bowtip.full': 'ดึงเต็มแล้ว · ปล่อยมือเพื่อยิง',
    'bowtip.mid': 'ดึงต่อ · ปล่อยมือเพื่อยิงทันที',
    'bowtip.low': 'กางสองมืออีกนิด',
    'bowtip.start': 'กางปลายนิ้วสองมือ · มือหนึ่งกำครึ่ง',
    rippleOff: 'เอฟเฟกต์คลื่นน้ำปิดอยู่ (RIPPLE_ENABLED ใน main.js)',
    statusBoot: 'กำลังโหลดโมเดล…',
    mpTitle: 'เปิดเพลงไหม?',
    mpDesc: 'ระหว่างรอโมเดลกับกล้อง เปิดเพลงก่อนก็ได้',
    mpYes: 'เปิดเพลง',
    mpNo: 'ไว้ก่อน',
    'hint.fist': 'กำมือ|ต้นไม้หดตัว ไฟหรี่ลง',
    'hint.bow': 'ดึงธนู|ดึงสองมือออกจากกัน → ปล่อยเพื่อยิง',
    'hint.spread': 'กาง-หุบ|ซูมต้นไม้ทั้งต้น',
    'hint.clap': 'ปรบมือ|หิมะระเบิด + แสงดาว',
    'hint.slide': 'โบกฝ่ามือ|ฝ่ามือข้าง · โบกซ้ายขวา → ต้นไม้หมุน',
    'hint.tray': 'ฝ่ามือขึ้น|รับของขวัญบนฝ่ามือ',
    'hint.heart': 'ทำหัวใจ|ครึ่งหัวใจต่อมือ · ประกบแล้วค้าง',
    'hint.call': 'ท่าโทรศัพท์|นิ้วโป้ง + นิ้วก้อย · ปล่อยโคมลอย',
    'hint.like': 'ถูกใจ|ชูนิ้วโป้ง · เศษทองร่วง',
    'hint.ok': 'ท่า OK|นิ้วโป้ง+ชี้เป็นวง · หัวใจ + ดาวตก + พลุ',
  },
};

let lang = null;

function detect() {
  try {
    const saved = localStorage.getItem(STORE);
    if (saved && STR[saved]) return saved;
  } catch (e) { /* 隐私模式等：忽略 */ }
  const n = (navigator.language || 'en').toLowerCase();
  if (n.startsWith('zh')) return 'zh';
  if (n.startsWith('th')) return 'th';
  return 'en';
}

export function getLang() {
  if (!lang) lang = detect();
  return lang;
}

export function setLang(l) {
  if (!STR[l]) return;
  lang = l;
  try { localStorage.setItem(STORE, l); } catch (e) { /* 忽略 */ }
  document.documentElement.lang = l === 'zh' ? 'zh-CN' : l;
  applyStatic();
  document.dispatchEvent(new CustomEvent('langchange'));
}

/** 取文案。hint.* 返回「标题|说明」数组；其余返回字符串 */
export function t(key) {
  const l = getLang();
  const v = STR[l][key] ?? STR.en[key] ?? STR.zh[key] ?? key;
  return v;
}

/** hint.* 是「标题|说明」一行写的，这里拆开 */
export function tHint(key) {
  const [title, desc] = t(key).split('|');
  return { title, desc };
}

/** 模板占位 {a} {b} */
export function tf(key, vars) {
  return t(key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

/** 刷一遍 HTML 里所有静态文案（启动时和每次切语言都调） */
export function applyStatic(root = document) {
  document.title = t('docTitle');
  root.querySelectorAll('[data-i18n]').forEach((elN) => {
    const k = elN.dataset.i18n;
    if (k.startsWith('hint.')) {
      const { title, desc } = tHint(k);
      const b = elN.querySelector('b');
      const s = elN.querySelector('span');
      if (b) b.textContent = title;
      if (s) s.textContent = desc;
      return;
    }
    elN.textContent = t(k);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((elN) => {
    elN.title = t(elN.getAttribute('data-i18n-title'));
  });
}

export const LANGS = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
  { id: 'th', label: 'ไทย' },
];
