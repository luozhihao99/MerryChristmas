/**
 * 全局配置。
 *
 * 默认音乐是一首远端 mp3：进页面就后台取，取到后等第一次交互（点击 / 触摸）
 * 再开始播 —— 浏览器的自动播放策略不允许无交互出声。
 * 换成自己的曲子只改 DEFAULT_MUSIC 一行；留空字符串就回到内置律动。
 */
export const DEFAULT_MUSIC =
  'https://www.videotolink.io/api/r2/videotolink/audio/1795099812573-230ad02a-40b9-4eca-9a89-e65c134ef5b1.mp3';

/** 远端曲子的显示名（URL 里那串哈希没法看） */
export const DEFAULT_MUSIC_NAME = 'Christmas · 默认音乐';
