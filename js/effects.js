// 落下の演出：周囲を流れる細かい粒子（風の筋）と、周辺視野を暗くするビネット。
// どちらも頂点シェーダーだけで動かすので、毎フレームのCPU処理はユニフォーム更新のみ。
import * as THREE from '../vendor/three.module.min.js';

const P_RANGE = 140; // 粒子が巡回する高さの幅[m]（プレイヤー中心）

export class Streaks {
  constructor(scene, count = 700) {
    const pos = new Float32Array(count * 2 * 3);
    const end = new Float32Array(count * 2);
    const rnd = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      // プレイヤーの周り（半径 3〜45m）に散らす。真上・真下の視界は塞がない
      const a = Math.random() * Math.PI * 2;
      const r = 3 + Math.pow(Math.random(), 0.7) * 42;
      const x = Math.cos(a) * r, z = Math.sin(a) * r, y = Math.random() * P_RANGE;
      const k = Math.random();
      for (let e = 0; e < 2; e++) {
        pos.set([x, y, z], (i * 2 + e) * 3);
        end[i * 2 + e] = e;
        rnd[i * 2 + e] = k;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    g.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScroll: { value: 0 }, uLen: { value: 0.05 }, uAlpha: { value: 0 }, uRange: { value: P_RANGE } },
      vertexShader: /* glsl */ `
        attribute float aEnd;
        attribute float aRnd;
        uniform float uScroll;
        uniform float uLen;
        uniform float uRange;
        varying float vA;
        void main() {
          float y = mod(position.y + uScroll, uRange) - uRange * 0.5;
          y -= aEnd * uLen * (0.6 + 0.8 * aRnd); // 尾は下側（流れてきた方向）
          vec3 wp = vec3(position.x, y, position.z);
          float edge = 1.0 - smoothstep(uRange * 0.3, uRange * 0.5, abs(y));
          float d = length(wp - cameraPosition);
          vA = edge * (1.0 - aEnd * 0.85) * smoothstep(1.5, 4.0, d) * (1.0 - smoothstep(25.0, 48.0, d));
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform float uAlpha;
        varying float vA;
        void main() { gl_FragColor = vec4(vec3(0.92, 0.94, 1.0), vA * uAlpha); }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.LineSegments(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    scene.add(this.mesh);
  }

  // speed: 現在の落下速度[m/s]
  update(fall, speed) {
    this.mat.uniforms.uScroll.value = fall % P_RANGE;
    this.mat.uniforms.uLen.value = Math.min(0.05 + speed * 0.07, 2.6);
    this.mat.uniforms.uAlpha.value = 0.12 + Math.min(speed / 30, 1) * 0.38;
  }
}

// ビネット：各目のビュー空間に直接置く板。頭の動きに1フレームも遅れない。
export class Vignette {
  constructor(scene) {
    const g = new THREE.PlaneGeometry(2, 2);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uStrength: { value: 0 }, uInner: { value: 0.62 }, uOuter: { value: 1.05 } },
      vertexShader: /* glsl */ `
        varying vec2 vP;
        void main() {
          vP = position.xy * 4.0; // ビュー空間で z=-1 の板。±4 → 約76°まで覆う
          gl_Position = projectionMatrix * vec4(vP, -1.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform float uStrength;
        uniform float uInner;
        uniform float uOuter;
        varying vec2 vP;
        void main() {
          float ang = atan(length(vP)); // 視線中心からの角度[rad]
          float a = smoothstep(uInner, uOuter, ang) * uStrength;
          gl_FragColor = vec4(0.02, 0.02, 0.05, a);
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 100;
    scene.add(this.mesh);
    this.level = 0;
  }

  // enabled: 設定ON/OFF、speedFrac: 0..1。速いほど少しだけ強く・狭く
  update(enabled, speedFrac, dt) {
    const target = enabled ? 0.55 + 0.4 * speedFrac : 0;
    this.level += (target - this.level) * Math.min(1, dt * 2.5);
    this.mat.uniforms.uStrength.value = this.level;
    this.mat.uniforms.uInner.value = 0.68 - 0.12 * speedFrac; // 約39°→32°
    this.mesh.visible = this.level > 0.005;
  }
}
