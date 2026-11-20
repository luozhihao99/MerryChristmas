import * as THREE from 'three';

/**
 * 粒子文字 / 图案背后的一层「软暗角」。
 *
 * 为什么需要它：
 *   树是满屏的暖黄光点，加法混合的文字压在上面永远糊 —— 只靠调亮文字会先把
 *   文字自己烧成一团白，只靠把树压暗又会像突然关灯。这两种做法都是在全局
 *   抢亮度，而真正缺的是**局部的对比度**。
 *   所以这里给文字垫一块边缘完全羽化的暗色，只压文字脚下那一小块，
 *   树的其他地方照常亮着。
 *
 * 用平面 + 径向渐变做，比画一张贴图省事：宽高随时能跟着横竖屏布局变。
 */

const vert = /* glsl */`
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const frag = /* glsl */`
uniform float uOpacity;
varying vec2 vUv;

void main(){
  // 中心满、边缘归零：边缘不归零的话能看到一块方形暗斑
  float r = length((vUv - 0.5) * 2.0);
  float a = uOpacity * (1.0 - smoothstep(0.10, 0.88, r));
  if (a < 0.004) discard;
  gl_FragColor = vec4(0.012, 0.020, 0.030, a);
}
`;

export class SoftVeil {
  /**
   * @param {THREE.Scene} scene
   * @param {{width:number,height:number,z:number,x?:number,y?:number,max?:number}} opt
   *        width/height 是实际要盖住的区域，内部会放大一圈留给羽化
   */
  constructor(scene, { width, height, z, x = 0, y = 0, max = 0.62 }) {
    this.max = max;
    this.pad = 1.42;                 // 羽化要地方，平面比内容大一圈
    const geo = new THREE.PlaneGeometry(width * this.pad, height * this.pad);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 } },
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      // 普通混合（不是加法）：它要靠「压掉后面的亮度」起作用
      blending: THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.position.set(x, y, z);
    this.mesh.renderOrder = 7;       // 在粒子（8）之前画
    this.mesh.visible = false;
    scene.add(this.mesh);

    this.baseW = width * this.pad;
    this.baseH = height * this.pad;
  }

  /** 横竖屏切换时按新的内容尺寸重算平面大小 */
  resize(width, height) {
    this.mesh.scale.set((width * this.pad) / this.baseW, (height * this.pad) / this.baseH, 1);
  }

  /** k：0~1 的出场强度，内部再乘各自的上限 */
  setOpacity(k) {
    const a = Math.max(0, Math.min(1, k)) * this.max;
    this.mat.uniforms.uOpacity.value = a;
    this.mesh.visible = a > 0.004;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.mesh.parent && this.mesh.parent.remove(this.mesh);
  }
}
