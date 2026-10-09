// VR内の案内板。頭に固定せず、表示した瞬間の視線の先（水平方向）の空間に置く。
// 文字はCanvasで描いて板に貼る（描き直すのは内容が変わったときだけ）。
import * as THREE from '../vendor/three.module.min.js';

const W = 1024, H = 512;

export class Hud {
  constructor(scene) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false, opacity: 0 });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.55), this.mat);
    this.mesh.renderOrder = 200;
    this.mesh.visible = false;
    // 終了（グリップ長押し）の進み具合バー
    this.bar = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.025), new THREE.MeshBasicMaterial({ color: 0xffd9a8, transparent: true, depthTest: false, depthWrite: false }));
    this.bar.position.set(0, -0.23, 0.001);
    this.bar.renderOrder = 201;
    this.bar.visible = false;
    this.mesh.add(this.bar);
    scene.add(this.mesh);
    this.key = '';
    this.timer = 0;
    this.sticky = false;
    this.opacity = 0;
  }

  // lines: [大きい見出し, 小さい行...]。duration 秒で消える（sticky=true なら消えない）
  show(lines, head, { duration = 2.5, sticky = false, reposition = true } = {}) {
    const key = lines.join('\n');
    if (key !== this.key) { this.key = key; this._draw(lines); }
    if (reposition || !this.mesh.visible) this._place(head);
    this.timer = duration;
    this.sticky = sticky;
    this.mesh.visible = true;
  }

  hide() { this.sticky = false; this.timer = Math.min(this.timer, 0.0); }

  setProgress(p) {
    this.bar.visible = p > 0;
    this.bar.scale.x = Math.max(p, 0.001);
    this.bar.position.x = -0.45 * (1 - p);
  }

  _place(head) {
    // 視線の水平方向 1.6m 先、目の高さより少し下
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(head.quaternion);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
    fwd.normalize();
    this.mesh.position.copy(head.position).addScaledVector(fwd, 1.6);
    this.mesh.position.y -= 0.12;
    this.mesh.lookAt(head.position.x, this.mesh.position.y, head.position.z);
  }

  _draw(lines) {
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(12, 14, 28, 0.72)';
    roundRect(c, 8, 8, W - 16, H - 16, 40);
    c.fill();
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#ffffff';
    c.font = 'bold 84px "Noto Sans JP", "Noto Sans CJK JP", sans-serif';
    const rest = lines.slice(1);
    const top = rest.length ? 150 : H / 2;
    c.fillText(lines[0], W / 2, top);
    c.font = '44px "Noto Sans JP", "Noto Sans CJK JP", sans-serif';
    c.fillStyle = '#dfe4ff';
    rest.forEach((l, i) => c.fillText(l, W / 2, 270 + i * 64));
    this.tex.needsUpdate = true;
  }

  update(dt) {
    if (!this.mesh.visible) return;
    if (!this.sticky) this.timer -= dt;
    const target = this.sticky || this.timer > 0 ? 1 : 0;
    this.opacity += (target - this.opacity) * Math.min(1, dt * 6);
    this.mat.opacity = this.opacity;
    this.bar.material.opacity = this.opacity;
    if (target === 0 && this.opacity < 0.01) this.mesh.visible = false;
  }
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
