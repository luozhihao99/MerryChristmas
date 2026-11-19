# Merry Christmas · 手势粒子圣诞树

MediaPipe Hands + Three.js 的手势交互圣诞粒子树，带 MP3 音乐驱动的呼吸动画。

三条主线：**粒子树负责逼真度，手势负责形态与互动，音乐负责亮度与能量。**

## 快速开始

必须通过 http 访问（摄像头权限与 ES Module 都需要），双击 `start.bat` 即可，
它会启动本地服务并打开浏览器。

手动启动：

```bash
python -m http.server 8123 --bind 127.0.0.1
# 然后打开 http://127.0.0.1:8123/index.html
```

首次打开会请求摄像头权限，允许后把手举到镜头前即可。

## 手势

| 手势 | 效果 |
| --- | --- |
| 握拳 | 树体向中轴收拢、彩灯转暗 |
| 握拳后张开 | 粒子炸散成雪，星星闪光 |
| 双手开合 | 缩放整棵树，彩灯随之依次点亮 |
| 拍手 | 爆雪 + 冲击波 + 星光脉冲 |
| 单手画圈 / 前后推拉 | 绕树干涡流；靠近镜头会把粒子吹散 |
| 掌心向上托举 | 生成承接区域，接住天上掉落的礼物并计数 |

## 音乐

点「放入音乐」选一个 MP3/音频文件即可。音频只驱动**亮度、Bloom、粒子脉动、
装饰球自发光、雪花扰动**，不改变形态——手势与音乐分别控形与控能，互不覆盖。

没有音乐时使用内置 96 BPM 律动，画面不会静止。

## 目录

```
index.html            页面与 HUD
styles.css            UI 样式
src/main.js           场景、循环、UI 装配
src/ParticleTree.js   粒子树 + 彩灯 + 装饰球 + 星 + 树体
src/SceneEffects.js   环境光贴图、地面、雪、Bloom、暗角颗粒
src/GestureController.js  MediaPipe 封装 → 手部状态与手势事件
src/AudioEngine.js    解码、播放、FFT 分频段
src/BeatDetector.js   鼓点检测（能量历史 + 自适应阈值）
src/BreathMapper.js   音频 → 亮度/辉光/暖色
src/InteractionRouter.js  手势与音乐的合并层
src/GiftRain.js       掉落礼物、接取判定、金色爆散
src/textures.js       程序化生成针叶/光点/星芒纹理
vendor/               本地化的 three.js 与 MediaPipe 运行时
assets/hand_landmarker.task  手势模型
```

## 调参

- 粒子数量与配色：`src/ParticleTree.js` 顶部常量与 `_buildNeedles()`
- 树形轮廓：`radiusAt(t, angle)`，控制锥度、分层幅度与不规则起伏
- 明暗与体积：针叶着色器里的 `lam` / `topLight` / `back`
- 手势灵敏度：`src/GestureController.js` 的开合阈值、拍手距离
- 缩放与回弹：`src/InteractionRouter.js` 的 `scaleVel` 弹簧参数
- 呼吸曲线：`src/BreathMapper.js` 的 `base / music / breath` 三项权重

## 注意

- 摄像头需要 `localhost` 或 https，直接双击 `index.html` 不行
- 亮度、Bloom、粒子尺寸都已 clamp，鼓点不会把画面冲爆
- 在 URL 后加 `?debug` 会暴露 `window.__app` 便于在控制台调试
