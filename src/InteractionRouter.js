import { GESTURE_SWITCH } from './gestureConfig.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * 侧掌扇风 → 整棵树绕自身中轴左右旋转（漩涡感）。
 * 旋转量按角度累积，不是位移：停下来时靠摩擦慢慢停，不会弹回原位。
 * 全是「防抖」参数：手抖、摄像头逐帧噪声都不能让树乱晃。
 */
const SPIN = {
  dead: 0.08,        // 速度死区（屏宽/秒），低于它直接当手静止
  smooth: 0.28,      // 手掌速度低通系数，越小越稳；0.28 一帧就能跟上大半
  rate: 6.2,         // 屏宽/秒 → 角速度 rad/s
  maxRate: 5.2,      // 角速度上限（约 300°/s），再快就晕
  accel: 9.5,        // 角速度跟随目标的速度（越小越黏、越稳）
  friction: 0.85,    // 手松开后的惯性衰减（越小转得越久）
  stopEps: 0.03,     // 低于这个角速度直接停住，防止永远缓慢自转
  jump: 4.0,         // 单帧速度超过它＝手被重新识别/换手，不是真挥动，丢弃
  backGain: 0.55,    // 回程（与掌心朝向相反）的力度折扣
  sideGate: 0.06,    // 掌面侧立权重门槛，低于它不认这次挥动
  gateHold: 0.40,    // 已经转起来时门槛打折：追踪抖一下掉到门线下不会立刻停
  idleRate: 0.20,    // 没人操作时的自转速度（rad/s，约 31 秒一圈）
};

/**
 * 手势 / 音乐的合并层。
 * 手势管“形态与空间”，音乐管“亮度与能量”，冲突参数相加后 clamp。
 */
export class InteractionRouter {
  constructor() {
    this.scale = 1;
    this.scaleVel = 0;
    this.explode = 0;
    this.swirl = 0;
    this.collapse = 0;
    this.storm = 0;
    this.seq = 1;
    this.clapFlash = 0;
    this.love = 0;
    this.heartFlash = 0;
    this.callFlash = 0;
    this.likeFlash = 0;
    this.okFlash = 0;

    // 侧掌扇风 → 绕中轴旋转
    this.spin = 0;         // 累积角度（弧度，取模 2π）
    this.spinVel = 0;      // 角速度 rad/s
    this.handVX = 0;       // 手掌水平速度（已低通）
    this.lastPalmX = null;
    this.sideIdle = 0;     // 距离上次有效扇动过了多久
    this.wind = 0;         // 0..1 风强度（驱动雪/涡流）

    this.trayWorld = { x: 0, y: 6.0, z: 2.7, active: false };
    this.bowW = 0;         // 0..1 拉弓权重（拉弓时要把「双手开合缩放」让出去）
    this.active = new Set();
  }

  onEvent(type, payload) {
    if (type === 'burst') {
      this.explode = Math.max(this.explode, payload.strength || 0.75);
      this.storm = Math.max(this.storm, 0.45);
    } else if (type === 'clap') {
      this.explode = 1.0;
      this.storm = 1.0;
      this.clapFlash = 1.0;
    } else if (type === 'trayOn') {
      this.trayWorld.active = true;
    } else if (type === 'trayOff') {
      this.trayWorld.active = false;
    } else if (type === 'heart') {
      // 比心成型的一瞬间给一记辉光脉冲，心形「啪」地亮起来
      this.heartFlash = 1;
      this.storm = Math.max(this.storm, 0.28);
    } else if (type === 'call') {
      // 打电话：只让 HUD 那条提示亮一下，画面交给弹幕自己演
      this.callFlash = 1;
    } else if (type === 'like') {
      // 点赞同理：粒子图案自己演，这里只负责 HUD 高亮
      this.likeFlash = 1;
    } else if (type === 'ok') {
      // OK 那段有 8 秒多，HUD 那条提示跟着亮得久一点，别一秒就灭
      this.okFlash = 1;
    }
  }

  update(dt, t, gstate, music) {
    const hands = gstate.hands || [];
    const now = t * 1000;

    // ---- 比心意图先算：它要抢在缩放之前 ----
    // 双手比心时两只手指尖贴在一起，两手间距本来就小，会被「双手开合」当成缩小指令，
    // 结果比心刚亮起来树同时被抽小，视觉上完全看不出心形。这里让 love 先占位。
    const heartStrength = gstate.heart && gstate.heart.active ? gstate.heart.strength : 0;
    this.love = lerp(this.love, heartStrength, 1 - Math.exp(-dt * 6));

    // ---- 拉弓同理，而且更严重 ----
    // 拉弓的姿态本身就是「两手分开」，那个间距会被缩放判成「放大」，
    // 于是整棵树在描弓的过程中被推大 —— 弓还没成形，画面先跳了一下。
    // 所以拉弓期间缩放权重整体让出去。
    const bowOn = !!(gstate.bow && gstate.bow.active);
    this.bowW = lerp(this.bowW, bowOn ? 1 : 0, 1 - Math.exp(-dt * 7));
    const spreadW = 1 - clamp(Math.max(this.love * 2.4, this.bowW * 1.6), 0, 1);

    // ---- 双手缩放 ----
    let target = 1;
    if (gstate.spread != null) {
      target = clamp(0.62 + (gstate.spread - 0.16) * 2.6, 0.66, 1.78);
    }
    // 比心期间缩放权重让出去，树定在原地，心形才是主角
    target = 1 + (target - 1) * spreadW;
    this.scaleVel += (target - this.scale) * 70 * dt;
    this.scaleVel *= Math.exp(-dt * 7.5);
    this.scale += this.scaleVel * dt;
    this.scale = clamp(this.scale, 0.6, 1.85);

    // ---- 握拳收拢 ----（GESTURE_SWITCH.fist 关掉时整段失效，树不会再被压塌）
    const fist = GESTURE_SWITCH.fist && hands.some((h) => h.gesture === 'fist');
    this.collapse = lerp(this.collapse, fist ? 1 : 0, 1 - Math.exp(-dt * 7));

    // ---- 侧掌扇风：掌心朝左/右 + 左右扇动 → 整棵树绕中轴左右转 ----
    // 原来这里是「画圈 → 涡流 + 前后推拉」，画圈在摄像头里很难稳定复现，
    // 改成扇风后判据是三个物理量：
    //   ① 掌面侧立程度 sideW（掌心朝侧，而不是朝镜头）
    //   ② 手掌的水平速度 vx（先低通再判死区，摄像头逐帧抖动不算「在动」）
    //   ③ 移动方向与掌心朝向的配合度（反向＝回程，只给 45% 力）
    let sideW = 0;
    let vx = 0;
    if (hands.length === 1) {
      const h = hands[0];
      sideW = h.sideW || 0;

      if (this.lastPalmX === null) this.lastPalmX = h.palmMirrored.x;
      const raw = (h.palmMirrored.x - this.lastPalmX) / Math.max(dt, 0.008);
      this.lastPalmX = h.palmMirrored.x;
      // 手被重新识别、左右手标签互换、或手从画面一侧跳到另一侧时，
      // 单帧位移会大到不可能是真挥动（4 屏宽/秒已经快得离谱）。
      // 这种尖峰必须丢掉，否则树会突然反向狂转。
      if (Math.abs(raw) < SPIN.jump) {
        this.handVX += (raw - this.handVX) * SPIN.smooth;
      }
      // 软死区：只取超出死区的那部分速度，手静止时的残余噪声被整段减掉，
      // 树不会因为摄像头抖动而自己慢慢转；真挥动只损失一点点幅度。
      const over = Math.abs(this.handVX) - SPIN.dead;
      vx = over > 0 ? Math.sign(this.handVX) * over : 0;

      // 已经转起来时门槛打折：MediaPipe 偶尔一两帧把掌面判成正对镜头，
      // 不该让正在转的树立刻刹停 —— 手感上会变成「一抽一抽」
      const gate = SPIN.sideGate * (Math.abs(this.spinVel) > 0.2 ? SPIN.gateHold : 1);
      if (sideW > gate && vx !== 0) {
        const facing = (h.palmSide || 0) >= 0 ? 1 : -1;
        const towardFace = Math.sign(vx) === facing ? 1 : SPIN.backGain;
        const target = clamp(vx * sideW * towardFace * SPIN.rate, -SPIN.maxRate, SPIN.maxRate);
        // 角速度跟目标走，不直接赋值：中途手抖一下不会让转速突跳
        this.spinVel += (target - this.spinVel) * (1 - Math.exp(-dt * SPIN.accel));
        this.sideIdle = 0;
      } else {
        this.sideIdle += dt;
      }
    } else {
      this.lastPalmX = null;
      this.handVX *= Math.exp(-dt * 6);
      this.sideIdle += dt;
    }

    // 手松开：惯性继续转，靠摩擦慢慢停，不打回原位
    if (this.sideIdle > 0.06) this.spinVel *= Math.exp(-dt * SPIN.friction);
    if (Math.abs(this.spinVel) < SPIN.stopEps) this.spinVel = 0;

    // 空闲自转：没人操作时树也一直在慢慢转（约 31 秒一圈），
    // 否则正面一动不动，像一张静态图。用手扇风时叠加在上面，
    // 0.2 rad/s 相比手动的 2~5 rad/s 几乎看不出来，松手后自然回到慢转。
    this.spin += (this.spinVel + SPIN.idleRate) * dt;
    // 取模防止长时间累积后精度下降；树是绕轴对称的，视觉上完全看不出来
    if (this.spin > Math.PI * 2 || this.spin < -Math.PI * 2) this.spin %= Math.PI * 2;

    // 风感：扇得越快风越大，雪更密、粒子再叠一点自转（树整体转之外的涡流细节）
    const windTarget = Math.min(1, Math.abs(vx) * sideW * 1.8);
    this.wind += (windTarget - this.wind) * (1 - Math.exp(-dt * 9));

    const swirlTarget = clamp(this.spinVel * 0.30, -0.9, 0.9);
    this.swirl = lerp(this.swirl, swirlTarget, 1 - Math.exp(-dt * 4.0));

    // ---- 脉冲衰减 ----
    this.explode *= Math.exp(-dt * 1.35);
    this.storm *= Math.exp(-dt * 2.4);
    this.clapFlash *= Math.exp(-dt * 2.0);

    // ---- 比心：连续值，不用事件硬切（love 已在函数开头推进） ----
    this.heartFlash *= Math.exp(-dt * 1.8);
    if (this.heartFlash < 0.004) this.heartFlash = 0;
    this.callFlash *= Math.exp(-dt * 0.9);
    if (this.callFlash < 0.004) this.callFlash = 0;
    this.likeFlash *= Math.exp(-dt * 0.85);
    if (this.likeFlash < 0.004) this.likeFlash = 0;
    this.okFlash *= Math.exp(-dt * 0.42);
    if (this.okFlash < 0.004) this.okFlash = 0;

    if (this.explode < 0.002) this.explode = 0;
    if (this.storm < 0.002) this.storm = 0;

    // ---- 彩灯随缩放依次点亮 ----
    const seqTarget = clamp((this.scale - 0.70) / 0.85, 0, 1);
    this.seq = lerp(this.seq, seqTarget, 1 - Math.exp(-dt * 2.4));

    // ---- 托盘世界坐标 ----
    if (gstate.tray) {
      this.trayWorld.x = (gstate.tray.x - 0.5) * 13.0;
      this.trayWorld.y = (1 - gstate.tray.y) * 9.8;
      this.trayWorld.active = true;
    } else {
      this.trayWorld.active = false;
    }

    // ---- 合并 ----
    const dim = 1 - this.collapse * 0.58;
    const params = {
      brightness: clamp(music.brightness * dim + this.explode * 0.10 + this.love * 0.06, 0.24, 1.35),
      bloom: clamp(music.bloom * dim + this.explode * 0.30 + this.storm * 0.22
        + this.love * 0.18 + this.heartFlash * 0.26, 0.30, 2.05),
      warm: clamp(music.warm + this.explode * 0.15 + this.love * 0.22, 0, 1),
      high: music.high,
      beat: clamp(music.beat * (1 + this.explode * 0.35) + this.clapFlash * 0.4, 0, 1.4),
      explode: this.explode,
      swirl: this.swirl,
      collapse: this.collapse,
      scale: this.scale * (1 - this.collapse * 0.05),
      seq: clamp(this.seq * (1 - this.collapse * 0.85), 0, 1),
      storm: clamp(this.storm + this.wind * 0.45, 0, 1.4),
      spin: this.spin,
      spinVel: this.spinVel,
      wind: this.wind,
      love: this.love,
    };

    // ---- UI 高亮 ----
    const a = this.active;
    a.clear();
    if (this.collapse > 0.45) a.add('fist');
    if (this.explode > 0.35) a.add('open');
    if (hands.length >= 2 && this.love < 0.25 && this.bowW < 0.4) a.add('spread');
    if (this.bowW > 0.35) a.add('bow');
    if (this.clapFlash > 0.3) a.add('clap');
    if (Math.abs(this.spinVel) > 0.12 || this.wind > 0.18) a.add('slide');
    if (this.trayWorld.active) a.add('tray');
    if (this.love > 0.3) a.add('heart');
    if (this.callFlash > 0.15) a.add('call');
    if (this.likeFlash > 0.15) a.add('like');
    if (this.okFlash > 0.15) a.add('ok');

    return params;
  }
}
