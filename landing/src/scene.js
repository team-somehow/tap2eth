import * as THREE from 'three';

/**
 * Mounts the whole Tap2ETH 3D story on a fixed canvas.
 * The page's [data-station] elements drive it: scroll position picks and blends stations.
 * Returns a cleanup function.
 */
export function initScene({ canvas, heroStage, labelsEl, onReady = () => {} }) {



  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 300);
  const TAU = Math.PI * 2;
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  /* ---------- studio environment (custom softboxes for nice reflections) ---------- */
  {
    const env = new THREE.Scene();
    env.add(new THREE.Mesh(new THREE.BoxGeometry(40, 30, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.06, 0.06, 0.065), side: THREE.BackSide })));
    const panel = (w, h, pos, c) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
      m.position.set(...pos); m.lookAt(0, 0, 0); env.add(m);
    };
    panel(16, 3, [0, 11, 6], new THREE.Color(7, 7, 6.6));
    panel(3, 16, [-12, 2, 7], new THREE.Color(4, 3.8, 3.4));
    panel(3, 16, [13, 1, -5], new THREE.Color(2.2, 2.6, 3.4));
    panel(26, 8, [0, -10, 2], new THREE.Color(0.32, 0.3, 0.27));
    panel(5, 5, [4, 3, 14], new THREE.Color(1.2, 1.2, 1.15));
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(env, 0.035).texture;
    pm.dispose();
    env.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
  }
  const key = new THREE.DirectionalLight(0xfff4e6, 1.6); key.position.set(-4, 9, 8); scene.add(key);
  const rim = new THREE.DirectionalLight(0xbcd2ff, 1.4); rim.position.set(7, 3, -8); scene.add(rim);
  const fieldLight = new THREE.PointLight(0xffe600, 0, 14, 2); fieldLight.position.set(0, -1.2, 0); scene.add(fieldLight);

  /* ---------- canvas texture helpers ---------- */
  function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }
  function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function tex(c, srgb = true) { const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy(); return t; }
  const F_DISP = '"Bricolage Grotesque", "Avenir Next", system-ui, sans-serif';
  const F_MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';
  const F_BODY = '"Instrument Sans", "Helvetica Neue", Arial, sans-serif';

  /* ---------- geometry helpers ---------- */
  function rrShape(w, h, r, cx = 0, cy = 0, Path = THREE.Shape) {
    const s = new Path(); const x = cx - w / 2, y = cy - h / 2;
    s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
    s.lineTo(x + w, y + h - r); s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
    s.lineTo(x + r, y + h); s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
    s.lineTo(x, y + r); s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
    return s;
  }
  function remapUV(geo, w, h) {
    const p = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + w / 2) / w, (p.getY(i) + h / 2) / h);
    uv.needsUpdate = true; return geo;
  }
  function slab(shape, depth, bevel = 0) {
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 24 });
    g.translate(0, 0, -depth / 2); return g;
  }
  // superellipse spiral (rounded-rectangle coil)
  function spiral(hw, hh, inset0, pitch, turns, z, start = Math.PI, n = 10) {
    const pts = []; const steps = Math.round(turns * 260);
    for (let i = 0; i <= steps; i++) {
      const u = i / steps * turns, t = start + u * TAU, d = inset0 + pitch * u;
      const c = Math.cos(t), s = Math.sin(t);
      pts.push(new THREE.Vector3(Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * (hw - d), Math.sign(s) * Math.pow(Math.abs(s), 2 / n) * (hh - d), z));
    }
    return pts;
  }

  /* ---------- shared shader materials ---------- */
  const flowVS = `varying vec2 vUv; varying float vY; void main(){ vUv = uv; vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
  function flowMat({ color = [1, 0.9, 0], dashes = 6, speed = 0.55, base = 0.16, below = false, additive = true }) {
    return new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uI: { value: 0 }, uMod: { value: 0 }, uColor: { value: new THREE.Vector3(...color) } },
      vertexShader: flowVS,
      fragmentShader: `uniform float uTime,uI,uMod; uniform vec3 uColor; varying vec2 vUv; varying float vY;
        void main(){
          float d = fract(vUv.x*${dashes.toFixed(1)} - uTime*${speed.toFixed(2)});
          float pulse = smoothstep(0.0,0.06,d)*smoothstep(0.32,0.08,d);
          float ends = smoothstep(0.0,0.05,vUv.x)*smoothstep(1.0,0.93,vUv.x);
          float bl = ${below ? 'smoothstep(-0.45,0.25,vY)' : '1.0'};
          float m = 1.0 - uMod*0.6*step(0.55, fract(uTime*3.1));
          float a = uI*(${base.toFixed(2)} + pulse)*ends*bl*m;
          gl_FragColor = vec4(uColor*(1.0+pulse*0.5), clamp(a,0.0,1.0));
        }`,
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
  }
  const flowMats = [];

  /* ---------- textures ---------- */
  const W = 8.56, Hc = 5.398, CR = 0.318;
  const CHIP = { x: -2.66, y: 0.3, w: 1.18, h: 0.94 };

  function cardFrontTex() {
    const [c, x] = makeCanvas(2048, 1292); const s = 2048 / W;
    const g = x.createLinearGradient(0, 0, 2048, 1292);
    g.addColorStop(0, '#22345f'); g.addColorStop(0.55, '#14213D'); g.addColorStop(1, '#0d1730');
    x.fillStyle = g; x.fillRect(0, 0, 2048, 1292);
    // radio rings from the contactless mark
    const cx = (-1.35 + W / 2) * s, cy = (Hc / 2 - CHIP.y) * s;
    x.strokeStyle = 'rgba(255,255,255,0.055)'; x.lineWidth = 3;
    for (let r = 120; r < 2600; r += 46) { x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.stroke(); }
    const sheen = x.createRadialGradient(1700, 80, 50, 1700, 80, 1300);
    sheen.addColorStop(0, 'rgba(255,255,255,0.13)'); sheen.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = sheen; x.fillRect(0, 0, 2048, 1292);
    // print noise
    const img = x.getImageData(0, 0, 2048, 1292), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 9; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    x.putImageData(img, 0, 0);
    // contactless mark
    x.strokeStyle = 'rgba(243,240,232,0.92)'; x.lineCap = 'round'; x.lineWidth = 15;
    for (let k = 0; k < 4; k++) { x.beginPath(); x.arc(cx - 70, cy, 40 + k * 34, -0.62, 0.62); x.stroke(); }
    x.fillStyle = '#F3F0E8';
    x.font = `800 92px ${F_DISP}`; x.fillText('YOUR BANK', 150, 230);
    x.font = `600 40px ${F_MONO}`; x.fillStyle = 'rgba(243,240,232,0.7)'; x.fillText('DEBIT', 1760, 220);
    x.font = `600 104px ${F_MONO}`;
    x.fillStyle = 'rgba(0,0,0,0.45)'; x.fillText('••••  ••••  ••••  4821', 154, 922);
    x.fillStyle = '#E8E3D6'; x.fillText('••••  ••••  ••••  4821', 150, 916);
    x.font = `600 40px ${F_MONO}`; x.fillStyle = 'rgba(243,240,232,0.65)'; x.fillText('VALID THRU', 900, 1040);
    x.font = `600 62px ${F_MONO}`; x.fillStyle = '#E8E3D6'; x.fillText('09/29', 1180, 1046);
    x.fillText('YOUR NAME', 150, 1160);
    // network placeholder: two stacked yellow bars, not a real network mark
    x.font = `800 italic 96px ${F_DISP}`; x.fillStyle = '#FFE600'; x.textAlign = 'right'; x.fillText('tap.', 1900, 1170); x.textAlign = 'left';
    return tex(c);
  }
  function cardBackTex() {
    const [c, x] = makeCanvas(2048, 1292);
    const g = x.createLinearGradient(0, 0, 2048, 1292); g.addColorStop(0, '#1b2b52'); g.addColorStop(1, '#0f1a33');
    x.fillStyle = g; x.fillRect(0, 0, 2048, 1292);
    const m = x.createLinearGradient(0, 150, 0, 420); m.addColorStop(0, '#151515'); m.addColorStop(0.5, '#262626'); m.addColorStop(1, '#0d0d0d');
    x.fillStyle = m; x.fillRect(0, 150, 2048, 270);
    x.fillStyle = 'rgba(243,240,232,0.6)'; x.font = `600 30px ${F_MONO}`; x.fillText('AUTHORISED SIGNATURE · NOT VALID UNLESS SIGNED', 150, 520);
    x.fillStyle = '#EDE8DA'; x.fillRect(150, 545, 1250, 190);
    x.strokeStyle = 'rgba(20,33,61,0.18)'; x.lineWidth = 6;
    for (let i = -200; i < 1300; i += 26) { x.beginPath(); x.moveTo(150 + i, 545); x.lineTo(150 + i + 190, 735); x.stroke(); }
    x.fillStyle = '#fff'; x.fillRect(1420, 570, 260, 140); x.fillStyle = '#14213D'; x.font = `700 70px ${F_MONO}`; x.fillText('•••', 1470, 665);
    x.fillStyle = 'rgba(243,240,232,0.7)'; x.font = `500 34px ${F_BODY}`;
    x.fillText('This card is issued by Your Bank and remains its property.', 150, 900);
    x.fillText('Inside the chip: a private key that never leaves it.', 150, 955);
    x.fillStyle = 'rgba(243,240,232,0.85)'; x.font = `800 64px ${F_DISP}`; x.fillText('YOUR BANK', 150, 1150);
    return tex(c);
  }
  function chipTex() {
    const [c, x] = makeCanvas(512, 408);
    const g = x.createLinearGradient(0, 0, 512, 408); g.addColorStop(0, '#f2dc9b'); g.addColorStop(0.45, '#d4ae5a'); g.addColorStop(1, '#a8812f');
    x.fillStyle = g; x.fillRect(0, 0, 512, 408);
    x.strokeStyle = '#5a4415'; x.lineWidth = 9; x.lineCap = 'round';
    const L = 512 * 0.34, R = 512 * 0.66;
    x.beginPath(); x.moveTo(L, -10); x.lineTo(L, 418); x.moveTo(R, -10); x.lineTo(R, 418); x.stroke();
    for (const yy of [0.26, 0.5, 0.74]) { x.beginPath(); x.moveTo(-10, yy * 408); x.lineTo(L, yy * 408); x.moveTo(R, yy * 408); x.lineTo(522, yy * 408); x.stroke(); }
    rr(x, L + 34, 96, R - L - 68, 216, 40); x.stroke();
    return tex(c);
  }
  function dieTex() {
    const [c, x] = makeCanvas(512, 512);
    x.fillStyle = '#17131f'; x.fillRect(0, 0, 512, 512);
    const pal = ['#3b2a63', '#2a4b5c', '#5b3d6e', '#1f5a4a', '#6b5a2a', '#24345e'];
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    // memory banks
    for (const [bx, by, bw, bh] of [[40, 40, 190, 150], [282, 40, 190, 150], [40, 322, 190, 150]]) {
      x.fillStyle = '#2b2350'; x.fillRect(bx, by, bw, bh);
      x.strokeStyle = 'rgba(160,200,255,0.25)'; x.lineWidth = 1;
      for (let yy = by; yy < by + bh; yy += 4) { x.beginPath(); x.moveTo(bx, yy); x.lineTo(bx + bw, yy); x.stroke(); }
    }
    // logic noise
    for (let i = 0; i < 900; i++) { x.fillStyle = pal[Math.floor(rnd() * pal.length)]; const xx = 30 + rnd() * 452, yy = 200 + rnd() * 110; x.fillRect(xx, yy, 2 + rnd() * 10, 2 + rnd() * 8); }
    for (let i = 0; i < 500; i++) { x.fillStyle = pal[Math.floor(rnd() * pal.length)]; x.fillRect(282 + rnd() * 190, 322 + rnd() * 150, 2 + rnd() * 9, 2 + rnd() * 7); }
    // secure core
    x.fillStyle = '#3a3208'; x.fillRect(206, 206, 100, 100);
    x.strokeStyle = '#FFE600'; x.lineWidth = 4; x.strokeRect(206, 206, 100, 100);
    // pads
    x.fillStyle = '#d9b867';
    for (let i = 0; i < 14; i++) { const p = 24 + i * 33; x.fillRect(p, 6, 14, 14); x.fillRect(p, 492, 14, 14); x.fillRect(6, p, 14, 14); x.fillRect(492, p, 14, 14); }
    return tex(c);
  }
  function readerTex() {
    const [c, x] = makeCanvas(2048, 1434); const s = 2048 / 10;
    x.clearRect(0, 0, 2048, 1434);
    x.strokeStyle = 'rgba(243,240,232,0.8)'; x.fillStyle = 'rgba(243,240,232,0.85)'; x.lineWidth = 4;
    x.font = `700 46px ${F_MONO}`; x.fillText('TAP2ETH READER', 80, 110);
    x.font = `600 34px ${F_MONO}`; x.fillText('ANT · 13.56 MHz · ISO/IEC 14443', 80, 1360);
    x.textAlign = 'right'; x.fillText('WS1850S · I2C 0x28', 1968, 110); x.textAlign = 'left';
    rr(x, 860, 520, 330, 390, 18); x.stroke();
    x.font = `600 28px ${F_MONO}`; x.fillText('U1', 870, 505); x.fillText('J1', 1250, 505);
    for (let i = 0; i < 6; i++) { x.strokeRect(1250, 560 + i * 52, 70, 34); }
    // centre contactless mark
    x.strokeStyle = 'rgba(255,230,0,0.9)'; x.lineWidth = 12; x.lineCap = 'round';
    for (let k = 0; k < 4; k++) { x.beginPath(); x.arc(560, 717, 30 + k * 34, -0.6, 0.6); x.stroke(); }
    return tex(c);
  }
  function glowTex() {
    const [c, x] = makeCanvas(128, 128); const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 128, 128); return tex(c);
  }
  function shadowTex() {
    const [c, x] = makeCanvas(256, 128); const g = x.createRadialGradient(128, 64, 0, 128, 64, 128);
    g.addColorStop(0, 'rgba(10,10,10,0.55)'); g.addColorStop(0.5, 'rgba(10,10,10,0.22)'); g.addColorStop(1, 'rgba(10,10,10,0)');
    x.fillStyle = g; x.fillRect(0, 0, 256, 128); return tex(c);
  }
  function glyphTex() {
    const [c, x] = makeCanvas(1024, 64); x.fillStyle = '#fff'; x.font = `700 50px ${F_MONO}`; x.textAlign = 'center'; x.textBaseline = 'middle';
    '0123456789ABCDEF'.split('').forEach((g, i) => x.fillText(g, i * 64 + 32, 34)); return tex(c, false);
  }
  function phoneTex(paid) {
    const Wp = 720, Hp = 1550; const [c, x] = makeCanvas(Wp, Hp);
    x.fillStyle = '#F3F0E8'; x.fillRect(0, 0, Wp, Hp);
    x.fillStyle = '#0A0A0A'; x.font = `600 30px ${F_BODY}`; x.fillText('9:41', 56, 70);
    x.fillRect(600, 50, 56, 26);
    x.font = `800 46px ${F_DISP}`; x.fillText('Tap2ETH', 56, 170);
    rr(x, 470, 128, 194, 52, 26); x.lineWidth = 4; x.stroke(); x.font = `600 22px ${F_MONO}`; x.fillText('WHITECHAIN', 494, 162);
    const box = (y, h, fill) => { rr(x, 56 + 6, y + 6, Wp - 112, h, 22); x.fillStyle = '#0A0A0A'; x.fill(); rr(x, 56, y, Wp - 112, h, 22); x.fillStyle = fill; x.fill(); x.lineWidth = 5; x.strokeStyle = '#0A0A0A'; x.stroke(); };
    if (!paid) {
      x.fillStyle = '#4A4A4A'; x.font = `600 24px ${F_MONO}`; x.fillText('PAYMENT REQUEST', 56, 270);
      x.fillStyle = '#0A0A0A'; x.font = `800 58px ${F_DISP}`; x.fillText('Team Somehow', 56, 345); x.fillText('Café', 56, 410);
      box(460, 220, '#FFE600');
      x.fillStyle = '#0A0A0A'; x.font = `800 128px ${F_DISP}`; x.fillText('2.00', 96, 615); x.font = `700 36px ${F_MONO}`; x.fillText('USDT', 430, 612);
      const rows = [['Card', '•••• 4821 tapped ✓'], ['Network', 'Whitechain Sepolia'], ['Expires', 'in 2 min'], ['Nonce', '17']];
      rows.forEach(([k, v], i) => { const y = 770 + i * 74; x.fillStyle = '#4A4A4A'; x.font = `500 30px ${F_BODY}`; x.fillText(k, 64, y); x.fillStyle = '#0A0A0A'; x.font = `700 30px ${F_BODY}`; x.textAlign = 'right'; x.fillText(v, Wp - 64, y); x.textAlign = 'left'; x.fillStyle = '#DCD8CC'; x.fillRect(64, y + 26, Wp - 128, 3); });
      // fingerprint
      const fx = Wp / 2, fy = 1260;
      x.beginPath(); x.arc(fx, fy, 112, 0, TAU); x.fillStyle = '#0A0A0A'; x.fill();
      x.strokeStyle = '#FFE600'; x.lineWidth = 7; x.lineCap = 'round';
      for (let k = 0; k < 5; k++) { x.beginPath(); x.ellipse(fx, fy + 10, 16 + k * 14, 26 + k * 15, 0, Math.PI * 1.08, Math.PI * 1.92 + (k % 2) * 0.6); x.stroke(); }
      x.fillStyle = '#0A0A0A'; x.font = `600 30px ${F_BODY}`; x.textAlign = 'center'; x.fillText('Confirm with your fingerprint', fx, 1440); x.textAlign = 'left';
    } else {
      x.fillStyle = '#0E7A3E'; x.beginPath(); x.arc(Wp / 2, 520, 150, 0, TAU); x.fill();
      x.strokeStyle = '#fff'; x.lineWidth = 26; x.lineCap = 'round'; x.lineJoin = 'round'; x.beginPath(); x.moveTo(Wp / 2 - 66, 525); x.lineTo(Wp / 2 - 12, 580); x.lineTo(Wp / 2 + 76, 470); x.stroke();
      x.fillStyle = '#0A0A0A'; x.textAlign = 'center'; x.font = `800 84px ${F_DISP}`; x.fillText('Paid', Wp / 2, 800);
      x.font = `600 38px ${F_BODY}`; x.fillStyle = '#4A4A4A'; x.fillText('2.00 USDT to Team Somehow Café', Wp / 2, 870);
      box(960, 230, '#FFFFFF'); x.textAlign = 'left';
      x.fillStyle = '#4A4A4A'; x.font = `500 30px ${F_BODY}`; x.fillText('Approved with', 96, 1040); x.fillText('Gas paid by', 96, 1130);
      x.fillStyle = '#0A0A0A'; x.font = `700 30px ${F_BODY}`; x.textAlign = 'right'; x.fillText('Card + fingerprint', Wp - 96, 1040); x.fillText('Relayer', Wp - 96, 1130); x.textAlign = 'left';
    }
    return tex(c);
  }

  /* ---------- build: card ---------- */
  const world = new THREE.Group(); scene.add(world);
  const pbr = []; // materials whose env intensity follows the chapter
  const cardRig = new THREE.Group(); world.add(cardRig);
  cardRig.rotation.order = 'YXZ';
  const card = new THREE.Group(); cardRig.add(card);

  const outline = rrShape(W, Hc, CR);
  const withHole = rrShape(W, Hc, CR); withHole.holes.push(rrShape(CHIP.w + 0.02, CHIP.h + 0.02, 0.13, CHIP.x, CHIP.y, THREE.Path));
  const TF = 0.022, TCORE = 0.046;
  function physical(o) { const m = new THREE.MeshPhysicalMaterial(o); pbr.push(m); return m; }

  const navyEdge = physical({ transparent: true, color: 0x14213D, roughness: 0.45, clearcoat: 0.6 });
  const frontPrintMat = physical({ transparent: true, roughness: 0.45, clearcoat: 0.7, clearcoatRoughness: 0.18, metalness: 0.0 });
  const backPrintMat = physical({ transparent: true, roughness: 0.42, clearcoat: 0.8, clearcoatRoughness: 0.2 });
  const coreMat = physical({ transparent: true, color: 0xF4F1EA, roughness: 0.55, transmission: 0 });
  const hiddenMat = new THREE.MeshBasicMaterial({ visible: false });

  const front = new THREE.Group(); card.add(front);
  front.add(new THREE.Mesh(slab(withHole, TF), [hiddenMat, navyEdge]));
  const frontPrint = new THREE.Mesh(remapUV(new THREE.ShapeGeometry(withHole, 32), W, Hc), frontPrintMat);
  frontPrint.position.z = TF / 2 + 0.0006; front.add(frontPrint);
  const frontUnder = new THREE.Mesh(new THREE.ShapeGeometry(withHole, 32), navyEdge); frontUnder.rotation.y = Math.PI; frontUnder.position.z = -TF / 2 - 0.0004; front.add(frontUnder);

  const back = new THREE.Group(); card.add(back);
  back.add(new THREE.Mesh(slab(outline, TF), [hiddenMat, navyEdge]));
  const backPrint = new THREE.Mesh(remapUV(new THREE.ShapeGeometry(outline, 32), W, Hc), backPrintMat);
  backPrint.rotation.y = Math.PI; backPrint.position.z = -TF / 2 - 0.0006; back.add(backPrint);
  const backTop = new THREE.Mesh(new THREE.ShapeGeometry(outline, 32), navyEdge); backTop.position.z = TF / 2 + 0.0004; back.add(backTop);

  const core = new THREE.Group(); card.add(core);
  core.add(new THREE.Mesh(slab(outline, TCORE), coreMat));

  // card antenna coil (on top of the core)
  const coilZ = TCORE / 2 + 0.014;
  const coilPts = spiral(W / 2, Hc / 2, 0.26, 0.075, 4, coilZ, Math.PI + 0.06);
  const first = coilPts[0], last = coilPts[coilPts.length - 1];
  const leadA = [new THREE.Vector3(CHIP.x - CHIP.w / 2 + 0.12, CHIP.y + 0.18, coilZ), new THREE.Vector3(first.x + 0.3, CHIP.y + 0.18, coilZ + 0.02)];
  const leadB = [new THREE.Vector3(last.x, last.y - 0.02, coilZ + 0.03), new THREE.Vector3(CHIP.x - CHIP.w / 2 + 0.12, CHIP.y - 0.2, coilZ)];
  const coilCurve = new THREE.CatmullRomCurve3([...leadA.reverse(), ...coilPts, ...leadB], false, 'catmullrom', 0.1);
  const coilGeo = new THREE.TubeGeometry(coilCurve, 2400, 0.017, 6, false);
  const copperMat = physical({ transparent: true, color: 0xc9824a, metalness: 1, roughness: 0.3 });
  const coil = new THREE.Mesh(coilGeo, copperMat); core.add(coil);
  const coilGlowMat = flowMat({ color: [1, 0.78, 0.25], dashes: 40, speed: 0.5, base: 0.28 }); flowMats.push(coilGlowMat);
  const coilGlow = new THREE.Mesh(new THREE.TubeGeometry(coilCurve, 2400, 0.03, 6, false), coilGlowMat); core.add(coilGlow);

  // chip module (lives with the core, plate flush with the card face when closed)
  const chip = new THREE.Group(); chip.position.set(CHIP.x, CHIP.y, 0); core.add(chip);
  const plateGroup = new THREE.Group(); chip.add(plateGroup);
  const chipShape = rrShape(CHIP.w, CHIP.h, 0.12);
  const goldSide = physical({ color: 0xd4ae5a, metalness: 1, roughness: 0.3 });
  const goldTop = physical({ map: chipTex(), metalness: 1, roughness: 0.26 });
  const plate = new THREE.Mesh(slab(chipShape, 0.012), [hiddenMat, goldSide]); plate.position.z = 0.04; plateGroup.add(plate);
  const plateTop = new THREE.Mesh(remapUV(new THREE.ShapeGeometry(chipShape, 16), CHIP.w, CHIP.h), goldTop); plateTop.position.z = 0.0465; plateGroup.add(plateTop);
  const substrate = new THREE.Mesh(slab(chipShape, 0.014), physical({ color: 0x1d2a20, roughness: 0.6 })); substrate.position.z = 0.027; plateGroup.add(substrate);
  const dieGroup = new THREE.Group(); chip.add(dieGroup);
  const dieSide = physical({ color: 0x222228, roughness: 0.4 });
  const die = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.46, 0.03), [dieSide, dieSide, dieSide, dieSide, physical({ map: dieTex(), roughness: 0.25, metalness: 0.35, iridescence: 1, iridescenceIOR: 1.6 }), dieSide]);
  die.position.z = 0.0; dieGroup.add(die);
  // bond wires (rebuilt when the chip opens)
  const bondMat = physical({ color: 0xe6c870, metalness: 1, roughness: 0.25 });
  const bondPads = [[-0.2, 0.2], [-0.2, 0], [-0.2, -0.2], [0.2, 0.2], [0.2, 0], [0.2, -0.2], [0, 0.21], [0, -0.21]];
  const bondEnds = [[-0.42, 0.33], [-0.42, 0], [-0.42, -0.33], [0.42, 0.33], [0.42, 0], [0.42, -0.33], [0, 0.38], [0, -0.38]];
  const bonds = new THREE.Group(); chip.add(bonds);
  let lastOpen = -1;
  function buildBonds(open) {
    bonds.children.forEach(m => m.geometry.dispose()); bonds.clear();
    const dz = dieGroup.position.z + 0.016 * dieGroup.scale.z, s = dieGroup.scale.x, pz = plateGroup.position.z + 0.02;
    bondPads.forEach(([px, py], i) => {
      const a = new THREE.Vector3(px * s, py * s, dz), b = new THREE.Vector3(bondEnds[i][0], bondEnds[i][1], 0.02).applyMatrix4(plateGroup.matrix);
      const mid = a.clone().lerp(b, 0.5); mid.z = Math.max(a.z, b.z) + 0.06 + open * 0.05;
      bonds.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a, mid, b), 16, 0.0045, 4), bondMat));
    });
  }
  // the key: glow + rings at the die centre
  const glowMap = glowTex();
  const keyGroup = new THREE.Group(); keyGroup.position.z = 0.03; dieGroup.add(keyGroup);
  const keyCore = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.1), new THREE.MeshBasicMaterial({ color: 0xFFE600, transparent: true, toneMapped: false }));
  keyGroup.add(keyCore);
  const keyGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, color: 0xFFE600, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
  keyGlow.scale.set(1.3, 1.3, 1); keyGroup.add(keyGlow);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xFFE600, transparent: true, toneMapped: false, opacity: 0 });
  const ring1 = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.004, 6, 96), ringMat); keyGroup.add(ring1);
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.003, 6, 96), ringMat); ring2.rotation.x = 1.1; keyGroup.add(ring2);
  const chipGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, color: 0xffd36b, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
  chipGlow.scale.set(2.2, 2.2, 1); chipGlow.position.z = 0.05; chip.add(chipGlow);

  // glyph streams: challenge in, signature out (chip-local space)
  let glyphMap = glyphTex();
  function glyphStream(text, curve, lanes, perLane, size, color) {
    const n = lanes * perLane, g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const gl = new Float32Array(n), al = new Float32Array(n);
    for (let i = 0; i < n; i++) gl[i] = parseInt(text[i % text.length], 16);
    g.setAttribute('glyph', new THREE.BufferAttribute(gl, 1)); g.setAttribute('alpha', new THREE.BufferAttribute(al, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uAtlas: { value: glyphMap }, uSize: { value: size }, uScale: { value: 800 }, uI: { value: 0 }, uColor: { value: new THREE.Vector3(...color) } },
      vertexShader: `attribute float glyph; attribute float alpha; varying float vG; varying float vA; uniform float uSize, uScale;
        void main(){ vG = glyph; vA = alpha; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = uSize*uScale/-mv.z; gl_Position = projectionMatrix*mv; }`,
      fragmentShader: `uniform sampler2D uAtlas; uniform float uI; uniform vec3 uColor; varying float vG; varying float vA;
        void main(){ vec2 uv = vec2((vG + gl_PointCoord.x)/16.0, 1.0 - gl_PointCoord.y); float a = texture2D(uAtlas, uv).a*vA*uI; if(a<0.01) discard; gl_FragColor = vec4(uColor*a, a); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(g, mat); pts.frustumCulled = false;
    pts.userData = { curve, lanes, perLane, n };
    return pts;
  }
  const challengeCurve = new THREE.CatmullRomCurve3([new THREE.Vector3(-3.6, 0.9, 1.4), new THREE.Vector3(-2.0, 0.55, 0.9), new THREE.Vector3(-0.8, 0.2, 0.45), new THREE.Vector3(0, 0, 0.06)]);
  const sigCurve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0.06), new THREE.Vector3(0.9, -0.15, 0.5), new THREE.Vector3(2.2, 0.1, 1.1), new THREE.Vector3(3.8, 0.8, 1.6)]);
  const challenge = glyphStream('7F3A9C21', challengeCurve, 1, 16, 0.085, [1, 0.9, 0]);
  const SIG = '3B9E51C40D77A2E9165FC803B4E1F07A9D2C6B58E04F13A7C9D2B6E8015F4A3C7E92D1B0C6A5F3E8D47B1029C3E5F7A1B9D4C2E6F80A13579BDF2468ACE0F1E2D3C4B5A69788796A5B4C3D2E1F0';
  const signature = glyphStream(SIG, sigCurve, 4, 46, 0.06, [0.98, 0.96, 0.9]);
  chip.add(challenge, signature);

  /* ---------- build: reader (NFC antenna PCB) ---------- */
  const reader = new THREE.Group(); world.add(reader);
  const boardShape = rrShape(10, 7, 0.45);
  const boardGeo = slab(boardShape, 0.16); boardGeo.rotateX(-Math.PI / 2);
  const board = new THREE.Mesh(boardGeo, [physical({ color: 0x0d1410, roughness: 0.42, clearcoat: 0.7, clearcoatRoughness: 0.3 }), physical({ color: 0xbfa66a, roughness: 0.7 })]);
  reader.add(board);
  const silk = new THREE.Mesh(new THREE.PlaneGeometry(10, 7), new THREE.MeshBasicMaterial({ map: readerTex(), transparent: true, depthWrite: false }));
  silk.rotation.x = -Math.PI / 2; silk.position.y = 0.083; reader.add(silk);
  const rcPts = spiral(4.7, 3.2, 0.12, 0.17, 4, 0, Math.PI * 0.75, 12).map(p => new THREE.Vector3(p.x, 0.09, -p.y));
  const rcCurve = new THREE.CatmullRomCurve3(rcPts);
  const rcGeo = new THREE.TubeGeometry(rcCurve, 1600, 0.05, 4, false); rcGeo.scale(1, 0.35, 1); rcGeo.translate(0, 0.06, 0);
  reader.add(new THREE.Mesh(rcGeo, physical({ color: 0xd08c4c, metalness: 1, roughness: 0.32 })));
  const rcGlowMat = flowMat({ color: [1, 0.85, 0.2], dashes: 30, speed: 0.8, base: 0.3 }); flowMats.push(rcGlowMat);
  const rcGlowGeo = new THREE.TubeGeometry(rcCurve, 1600, 0.07, 4, false); rcGlowGeo.scale(1, 0.4, 1); rcGlowGeo.translate(0, 0.06, 0);
  reader.add(new THREE.Mesh(rcGlowGeo, rcGlowMat));
  const ic = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.1, 1.0), physical({ color: 0x111111, roughness: 0.5 })); ic.position.set(0.25, 0.13, -0.2); reader.add(ic);
  const conn = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 1.6), physical({ color: 0xeeeeea, roughness: 0.6 })); conn.position.set(1.4, 0.3, -0.2); reader.add(conn);
  for (let i = 0; i < 5; i++) { const cap = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.1, 0.12), physical({ color: 0x9a7b4f, roughness: 0.6 })); cap.position.set(-0.6, 0.12, -0.9 + i * 0.35); reader.add(cap); }
  // field lines (magnetic dipole lines from the reader coil)
  const fieldMat = flowMat({ color: [1, 0.9, 0], dashes: 5, speed: 0.45, base: 0.14, below: true }); flowMats.push(fieldMat);
  const fieldGroup = new THREE.Group(); reader.add(fieldGroup);
  for (const L of [2.6, 3.9, 5.4]) {
    for (let k = 0; k < 8; k++) {
      const phi = k / 8 * TAU + L * 0.3, th0 = Math.asin(Math.sqrt(0.55 / L)), pts = [];
      for (let i = 0; i <= 80; i++) {
        const th = lerp(th0, Math.PI * 0.8, i / 80), r = L * Math.sin(th) ** 2;
        pts.push(new THREE.Vector3(r * Math.sin(th) * Math.cos(phi) * 1.25, 0.1 + r * Math.cos(th), r * Math.sin(th) * Math.sin(phi) * 0.9));
      }
      fieldGroup.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 90, 0.013, 5), fieldMat));
    }
  }
  const readerGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, color: 0xFFE600, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
  readerGlow.scale.set(9, 9, 1); readerGlow.position.y = 0.3; reader.add(readerGlow);
  // data packets between chip and reader (world space)
  const packets = new THREE.InstancedMesh(new THREE.BoxGeometry(0.11, 0.11, 0.11), new THREE.MeshBasicMaterial({ color: 0xFFE600, toneMapped: false, transparent: true }), 18);
  packets.frustumCulled = false; world.add(packets);

  /* ---------- build: phone ---------- */
  const phone = new THREE.Group(); world.add(phone);
  phone.position.set(4.1, -0.3, 0.2); phone.rotation.set(-0.05, -0.38, 0.02);
  const phoneBody = new THREE.Mesh(slab(rrShape(7.1, 14.7, 1.15), 0.6, 0.12), physical({ color: 0x24262b, metalness: 0.7, roughness: 0.32, clearcoat: 1 }));
  phone.add(phoneBody);
  const glass = new THREE.Mesh(new THREE.ShapeGeometry(rrShape(6.95, 14.55, 1.05), 24), physical({ color: 0x050505, roughness: 0.08, clearcoat: 1 }));
  glass.position.z = 0.43; phone.add(glass);
  let screenApprove = phoneTex(false), screenPaid = phoneTex(true);
  const screenMat = new THREE.MeshBasicMaterial({ map: screenApprove, toneMapped: false, transparent: true });
  const screen = new THREE.Mesh(remapUV(new THREE.ShapeGeometry(rrShape(6.6, 14.2, 0.85), 24), 6.6, 14.2), screenMat);
  // Separate the display from the glass so distant views do not flicker.
  screen.position.z = 0.48; phone.add(screen);
  const fpGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, color: 0xFFE600, transparent: true, depthWrite: false, opacity: 0 }));
  fpGlow.position.set(0, -4.3, 0.5); fpGlow.scale.set(3.6, 3.6, 1); phone.add(fpGlow);
  const FP_LOCAL = new THREE.Vector3(0, -4.3, 0.5);

  /* ---------- build: wallet contract cube + beams ---------- */
  const contract = new THREE.Group(); world.add(contract); contract.position.set(0.4, 5.6, -1.6);
  const cubeGeo = slab(rrShape(2.5, 2.5, 0.35), 2.2, 0.15);
  contract.add(new THREE.Mesh(cubeGeo, new THREE.MeshStandardMaterial({ color: 0xFFE600, roughness: 0.6 })));
  const hull = new THREE.Mesh(cubeGeo, new THREE.MeshBasicMaterial({ color: 0x0A0A0A, side: THREE.BackSide })); hull.scale.setScalar(1.07); contract.add(hull);
  function contractTex() {
    const [c, x] = makeCanvas(512, 512); x.fillStyle = '#0A0A0A'; x.font = `800 64px ${F_DISP}`; x.textAlign = 'center';
    x.fillText('Tap2Eth', 256, 150); x.fillText('Wallet', 256, 214);
    x.lineWidth = 34; x.lineCap = 'round'; x.lineJoin = 'round'; x.strokeStyle = '#0A0A0A'; x.beginPath(); x.moveTo(160, 330); x.lineTo(230, 400); x.lineTo(360, 270); x.stroke();
    return tex(c);
  }
  const contractFace = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 2.3), new THREE.MeshBasicMaterial({ map: contractTex(), transparent: true }));
  contractFace.position.z = 1.26; contract.add(contractFace);
  const beamMat = flowMat({ color: [0.04, 0.04, 0.04], dashes: 9, speed: 0.9, base: 0.25, additive: false }); flowMats.push(beamMat);
  const beamGroup = new THREE.Group(); world.add(beamGroup);

  /* ---------- blob shadow ---------- */
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTex(), transparent: true, depthWrite: false, opacity: 0 }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = -4.3; world.add(shadow);

  /* ---------- stations ---------- */
  const DEF = {
    tx: 0, ty: 0, tz: 0, yaw: 0, pitch: 0.05, dist: 19,
    cx: 0, cy: 0, cz: 0, crx: 0, cry: 0, crz: 0,
    idle: 0, heroFrame: 0, explode: 0, xray: 0, coil: 0, power: 0, data: 0, chipOpen: 0, key: 0, streams: 0, verify: 0, cardFade: 1,
    reader: 0, field: 0, phone: 0, contract: 0, beams: 0, paid: 0, shadow: 0, env: 1, vis: 1, msy: 0.2,
    lab_reader: 0, lab_layers: 0, lab_chip: 0, lab_key: 0, lab_stream: 0, lab_pay: 0, lab_contract: 0,
  };
  const CHIP_WORLD_FLAT = { x: CHIP.x, y: 0.5 + 0.05, z: -CHIP.y };
  const S = {};
  S.hero = { cy: 0.15, crx: -0.16, cry: -0.52, crz: 0.07, idle: 1, heroFrame: 1, shadow: 1, msy: 0.28 };
  S.statement = { cy: 0.4, cx: 0.6, crx: -0.42, cry: -0.95, crz: 0.32, dist: 25, idle: 0.6, shadow: 0.5, msy: 0.3 };
  S.tap1 = { ty: -0.9, yaw: 0.62, pitch: 0.6, dist: 19, cy: 0.5, crx: -Math.PI / 2, reader: 1, field: 1, env: 0.55, lab_reader: 1, coil: 0.15 };
  S.tap2 = { ty: -0.3, yaw: 0.88, pitch: 0.5, dist: 18.5, cy: 0.5, crx: -Math.PI / 2, explode: 1, xray: 0.55, coil: 1, power: 1, reader: 1, field: 0.6, env: 0.6, lab_layers: 1 };
  S.tap3 = { ty: -0.6, yaw: 0.3, pitch: 0.36, dist: 18, cy: 0.5, crx: -Math.PI / 2, explode: 0.35, xray: 0.5, coil: 0.8, power: 1, data: 1, reader: 1, field: 0.85, env: 0.6 };
  S.secret1 = { tx: CHIP_WORLD_FLAT.x, ty: CHIP_WORLD_FLAT.y, tz: CHIP_WORLD_FLAT.z, yaw: 0.5, pitch: 0.92, dist: 5.4, cy: 0.5, crx: -Math.PI / 2, explode: 1, xray: 0.9, cardFade: 0.25, coil: 0.3, power: 1, chipOpen: 1, key: 1, reader: 0.35, env: 0.7, lab_chip: 1, lab_key: 1, msy: 0.22 };
  S.secret2 = { ...S.secret1, yaw: 0.15, pitch: 1.0, dist: 8.4, streams: 1, chipOpen: 0.85, lab_chip: 0, lab_key: 0.0, lab_stream: 1, reader: 0 };
  S.secret3 = { cy: 0.2, crx: -0.12, cry: -0.4, crz: 0.05, dist: 19, verify: 1, power: 0.5, env: 0.8, idle: 0.3 };
  S.pay1 = { tx: 0.6, ty: 0, dist: 27, cx: -2.2, cy: 0.7, cz: 0.6, crx: -0.1, cry: 0.42, crz: 0.1, phone: 1, shadow: 0.7, lab_pay: 1, idle: 0.2 };
  S.pay2 = { ...S.pay1, ty: 1.6, dist: 30, pitch: 0.12, contract: 1, beams: 1, paid: 1, lab_pay: 0, lab_contract: 1 };
  S.outro = { ...S.hero, msy: 0.24 };
  S.gone1 = { ...S.pay2, vis: 0, lab_contract: 0 };
  S.gone2 = { ...S.outro, vis: 0, shadow: 0 };
  for (const k in S) S[k] = { ...DEF, ...S[k] };
  const KEYS = Object.keys(DEF);

  // beams from where card and phone sit at pay2
  {
    const dummy = new THREE.Object3D(); dummy.rotation.order = 'YXZ';
    const p = S.pay2; dummy.position.set(p.cx, p.cy, p.cz); dummy.rotation.set(p.crx, p.cry, p.crz); dummy.updateMatrixWorld();
    const a = new THREE.Vector3(CHIP.x, CHIP.y, 0.05).applyMatrix4(dummy.matrixWorld);
    phone.updateMatrixWorld(); const b = FP_LOCAL.clone().applyMatrix4(phone.matrixWorld);
    const c = contract.position.clone().add(new THREE.Vector3(0, -1.2, 1.1));
    for (const s of [a, b]) {
      const mid = s.clone().lerp(c, 0.5); mid.y += 2.2; mid.z += 1.5;
      beamGroup.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(s, mid, c), 80, 0.05, 6), beamMat));
    }
  }

  /* ---------- labels ---------- */
  const labelDefs = [
    { text: 'Reader antenna · 13.56 MHz', obj: reader, at: [4.2, 0.1, 2.6], dx: 40, dy: 70, p: 'lab_reader', tone: 'night' },
    { text: 'Magnetic field', obj: reader, at: [-2.2, 3.4, 0.4], dx: -70, dy: -60, p: 'lab_reader', tone: 'night', minor: true },
    { text: 'Printed face', obj: front, at: [3.9, 2.3, 0], dx: 60, dy: -50, p: 'lab_layers', tone: 'night', minor: true },
    { text: 'Copper antenna · 4 turns', obj: core, at: [4.04, -1.4, coilZ], dx: 70, dy: 20, p: 'lab_layers', tone: 'night' },
    { text: 'Chip module', obj: chip, at: [0, 0, 0.05], dx: -80, dy: -70, p: 'lab_layers', tone: 'night' },
    { text: 'Back · magnetic stripe', obj: back, at: [3.9, -2.4, 0], dx: 60, dy: 40, p: 'lab_layers', tone: 'night', minor: true },
    { text: 'Gold contacts C1–C8', obj: plateGroup, at: [0.55, 0.42, 0.05], dx: 80, dy: -60, p: 'lab_chip', tone: 'night' },
    { text: 'Silicon die · secure element', obj: dieGroup, at: [0.23, -0.23, 0.02], dx: 90, dy: 60, p: 'lab_chip', tone: 'night' },
    { text: 'RSA private key · never leaves', obj: keyGroup, at: [0, 0, 0], dx: -110, dy: -90, p: 'lab_key', tone: 'night' },
    { text: 'Challenge · 4 bytes in', obj: chip, at: [-2.6, 0.6, 1.05], dx: -20, dy: -60, p: 'lab_stream', tone: 'night' },
    { text: 'Signature · 128 bytes out', obj: chip, at: [2.8, 0.35, 1.3], dx: 20, dy: 60, p: 'lab_stream', tone: 'night' },
    { text: 'Card signs 4 bytes of H', obj: chip, at: [0, 0, 0.05], dx: -60, dy: 90, p: 'lab_pay', tone: 'paper' },
    { text: 'Phone signs all 32 bytes', obj: phone, at: [0, -4.3, 0.5], dx: 70, dy: 80, p: 'lab_pay', tone: 'paper' },
    { text: 'Wallet contract checks both', obj: contract, at: [1.3, 1.2, 1.1], dx: 70, dy: -50, p: 'lab_contract', tone: 'paper' },
  ];
  const labels = labelDefs.map(d => {
    const el = document.createElement('div'); el.className = 'tag' + (d.minor ? ' minor' : ''); el.dataset.tone = d.tone;
    el.innerHTML = `<span class="tag-line"></span><span class="tag-dot"></span><span class="tag-text">${d.text}</span>`;
    labelsEl.appendChild(el);
    const line = el.querySelector('.tag-line'), txt = el.querySelector('.tag-text');
    const len = Math.hypot(d.dx, d.dy), ang = Math.atan2(d.dy, d.dx);
    line.style.width = len + 'px'; line.style.transform = `rotate(${ang}rad)`;
    txt.style.left = d.dx + 'px'; txt.style.top = d.dy + 'px';
    txt.style.transform = `translate(${d.dx < 0 ? '-100%' : '0'}, -50%)`;
    return { ...d, el, textEl: txt, lineEl: line, width: 0, height: 0, v: new THREE.Vector3() };
  });

  /* ---------- scroll → station mapping ---------- */
  let anchors = [], heroBounds = null;
  function measure() {
    const maxScroll = document.documentElement.scrollHeight - innerHeight;
    const heroRect = heroStage.getBoundingClientRect();
    heroBounds = heroRect.width > 0 && heroRect.height > 0
      ? { left: heroRect.left, top: heroRect.top + scrollY, width: heroRect.width, height: heroRect.height }
      : null;
    for (const L of labels) {
      L.width = L.textEl.offsetWidth;
      L.height = L.textEl.offsetHeight;
    }
    anchors = [...document.querySelectorAll('[data-station]')].map(el => {
      const r = el.getBoundingClientRect(), top = r.top + scrollY;
      let a = el.dataset.anchor === 'start' ? 0 : el.dataset.anchor === 'top' ? top - innerHeight * 0.55 : top + r.height / 2 - innerHeight / 2;
      return { s: S[el.dataset.station], a: clamp(a, 0, maxScroll) };
    });
    for (let i = 1; i < anchors.length; i++) if (anchors[i].a <= anchors[i - 1].a) anchors[i].a = anchors[i - 1].a + 1;
  }
  const target = { ...DEF }, cur = { ...S.hero };
  function computeTarget() {
    const y = scrollY;
    let i = 0; while (i < anchors.length - 1 && y >= anchors[i + 1].a) i++;
    const A = anchors[i], B = anchors[Math.min(i + 1, anchors.length - 1)];
    const t = A === B ? 0 : smooth(0.08, 0.92, (y - A.a) / (B.a - A.a));
    for (const k of KEYS) target[k] = lerp(A.s[k], B.s[k], t);
  }

  /* ---------- interaction (hero drag + pointer tilt) ---------- */
  let dragYaw = 0, dragVel = 0, dragging = false, lastX = 0, tiltX = 0, tiltY = 0, ptrX = 0, ptrY = 0;
  const onDown = e => { dragging = true; lastX = e.clientX; heroStage.setPointerCapture(e.pointerId); };
  const onMove = e => { if (!dragging) return; const dx = e.clientX - lastX; lastX = e.clientX; dragYaw += dx * 0.012; dragVel = dx * 0.012; };
  const endDrag = () => { dragging = false; };
  const heroHandlers = [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', endDrag], ['pointercancel', endDrag]];
  heroHandlers.forEach(([t, f]) => heroStage.addEventListener(t, f));
  const onPtr = e => { ptrX = e.clientX / innerWidth - 0.5; ptrY = e.clientY / innerHeight - 0.5; };
  addEventListener('pointermove', onPtr, { passive: true });

  /* ---------- resize ---------- */
  let vw = 0, vh = 0, mobile = false;
  function resize() {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    if (w === vw && h === vh) return;
    vw = w; vh = h; mobile = vw < 900;
    renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.75 : 2));
    renderer.setSize(vw, vh, false);
    camera.aspect = vw / vh; camera.updateProjectionMatrix();
    const scale = renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    challenge.material.uniforms.uScale.value = scale; signature.material.uniforms.uScale.value = scale;
    measure();
  }
  addEventListener('resize', resize);
  const ro = new ResizeObserver(() => measure());
  ro.observe(document.body);
  ro.observe(heroStage);

  /* ---------- apply state ---------- */
  const tmpV = new THREE.Vector3(), camPos = new THREE.Vector3(), camTgt = new THREE.Vector3();
  function setOpacity(mat, o) { mat.opacity = o; mat.depthWrite = o > 0.97; }
  function apply(c, time) {
    world.position.y = (1 - c.vis) * 18;
    const visible = c.vis > 0.01;
    world.visible = visible;

    // Story framing keeps the object beside the text, or above it on a phone.
    // In the hero, frame the card inside its actual layout slot instead of a
    // viewport guess. This also makes the visual-first mobile layout stay clear
    // of the navigation. The station value blends both framings during scroll.
    const areaAspect = mobile ? vw / (vh * 0.56) : (vw * 0.6) / vh;
    const fit = Math.max(1, (mobile ? 1.6 : 0.95) / areaAspect);
    // Keep the mobile story inside the upper half of the viewport, clear of
    // the copy below it. Hero size continues to come from its own layout slot.
    const storyDist = c.dist * fit * (mobile ? 1.36 : 1);
    const heroFrame = heroBounds ? c.heroFrame : 0;
    const halfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const heroDist = heroBounds ? Math.max(
      W * vh / (2 * halfFov * heroBounds.width * 0.88),
      (Hc + 0.65) * vh / (2 * halfFov * heroBounds.height * 0.8),
    ) : storyDist;
    camTgt.set(c.tx, c.ty, c.tz);
    camTgt.lerp(tmpV.set(c.cx, c.cy, c.cz), heroFrame);
    const d = lerp(storyDist, heroDist, heroFrame);
    camPos.set(Math.sin(c.yaw) * Math.cos(c.pitch), Math.sin(c.pitch), Math.cos(c.yaw) * Math.cos(c.pitch)).multiplyScalar(d).add(camTgt);
    camera.position.copy(camPos); camera.up.set(0, 1, 0); camera.lookAt(camTgt);
    const sx = mobile ? 0 : 0.2, sy = mobile ? clamp(c.msy + 0.04, 0.24, 0.28) : 0;
    const heroOffsetX = heroBounds ? vw / 2 - (heroBounds.left + heroBounds.width / 2) : 0;
    const heroOffsetY = heroBounds ? vh / 2 - (heroBounds.top - scrollY + heroBounds.height / 2) : 0;
    camera.setViewOffset(vw, vh,
      lerp(-sx * vw, heroOffsetX, heroFrame),
      lerp(sy * vh, heroOffsetY, heroFrame), vw, vh);

    // card pose + hero idle motion
    const idle = reduced ? 0 : c.idle;
    if (!dragging) { dragVel *= 0.94; dragYaw += dragVel; const home = Math.round(dragYaw / TAU) * TAU; if (Math.abs(dragVel) < 0.004) dragYaw = lerp(dragYaw, home, 0.03); }
    tiltX = lerp(tiltX, ptrY * 0.25, 0.05); tiltY = lerp(tiltY, ptrX * 0.35, 0.05);
    cardRig.position.set(c.cx, c.cy + Math.sin(time * 1.1) * 0.12 * idle, c.cz);
    cardRig.rotation.set(c.crx + tiltX * c.idle + Math.sin(time * 0.7) * 0.03 * idle, c.cry + (dragYaw + tiltY) * c.idle + Math.sin(time * 0.45) * 0.08 * idle, c.crz);

    // layers
    front.position.z = (TCORE / 2 + TF / 2) + c.explode * 1.6;
    back.position.z = -(TCORE / 2 + TF / 2) - c.explode * 1.6;
    const fade = c.cardFade;
    setOpacity(frontPrintMat, (1 - c.xray * 0.86) * fade);
    setOpacity(navyEdge, (1 - c.xray * 0.8) * fade);
    setOpacity(backPrintMat, (1 - c.xray * 0.75) * fade);
    setOpacity(coreMat, (1 - c.xray * 0.55) * (0.4 + 0.6 * fade));
    setOpacity(copperMat, Math.min(1, 0.35 + fade));
    coilGlowMat.uniforms.uI.value = c.coil * (0.5 + 0.5 * fade);
    coilGlow.visible = coil.visible = c.xray > 0.02 || c.explode > 0.02;

    // chip
    // the contact plate swings open like a lid so the die underneath shows
    plateGroup.position.set(c.chipOpen * 1.05, c.chipOpen * 0.1, c.chipOpen * 0.75);
    plateGroup.rotation.set(c.chipOpen * 0.15, -c.chipOpen * 0.95, 0);
    dieGroup.position.z = c.chipOpen * 0.18;
    dieGroup.scale.setScalar(1 + c.chipOpen * 0.55);
    if (Math.abs(c.chipOpen - lastOpen) > 0.002) { plateGroup.updateMatrix(); buildBonds(c.chipOpen); lastOpen = c.chipOpen; }
    const breathe = 0.75 + 0.25 * Math.sin(time * 2.4);
    keyGlow.material.opacity = c.key * breathe * 0.9;
    keyCore.material.opacity = Math.max(c.key, 0.0);
    keyCore.visible = c.key > 0.02;
    ringMat.opacity = c.key * 0.8;
    ring1.rotation.z = time * 0.8; ring2.rotation.y = time * 0.6; ring2.rotation.z = -time * 0.3;
    chipGlow.material.opacity = c.power * 0.45 * (0.7 + 0.3 * Math.sin(time * 5));

    // streams
    for (const [pts, speed] of [[challenge, 0.22], [signature, 0.12]]) {
      const { curve, lanes, perLane } = pts.userData, pos = pts.geometry.attributes.position, al = pts.geometry.attributes.alpha;
      pts.material.uniforms.uI.value = c.streams; pts.visible = c.streams > 0.01;
      if (!pts.visible) continue;
      for (let l = 0; l < lanes; l++) for (let i = 0; i < perLane; i++) {
        const idx = l * perLane + i, s = ((i / perLane) + time * speed) % 1;
        curve.getPointAt(s, tmpV);
        tmpV.y += (l - (lanes - 1) / 2) * 0.17; tmpV.z += (l - (lanes - 1) / 2) * 0.05;
        pos.setXYZ(idx, tmpV.x, tmpV.y, tmpV.z); al.setX(idx, Math.sin(s * Math.PI));
      }
      pos.needsUpdate = true; al.needsUpdate = true;
    }

    // reader + field
    reader.position.y = -2.45 - (1 - c.reader) * 9;
    reader.visible = c.reader > 0.01;
    fieldMat.uniforms.uI.value = c.field; fieldMat.uniforms.uMod.value = c.data;
    rcGlowMat.uniforms.uI.value = Math.max(c.field, c.reader * 0.3);
    readerGlow.material.opacity = c.field * 0.18;
    fieldLight.intensity = c.field * 25; fieldLight.position.y = reader.position.y + 1.2;

    // packets (load modulation)
    packets.visible = c.data > 0.02;
    if (packets.visible) {
      chip.getWorldPosition(tmpV);
      const top = tmpV.clone(), bottom = new THREE.Vector3(tmpV.x, reader.position.y + 0.2, tmpV.z);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      for (let i = 0; i < 18; i++) {
        const up = i % 2 === 0, ph = ((i / 18) + time * 0.35) % 1, p = up ? ph : 1 - ph;
        const pos = bottom.clone().lerp(top, p); pos.x += up ? -0.35 : 0.35;
        sc.setScalar(Math.sin(ph * Math.PI) * c.data);
        m.compose(pos.sub(world.position), q, sc); packets.setMatrixAt(i, m);
      }
      packets.instanceMatrix.needsUpdate = true;
    }

    // phone / contract / beams
    phone.visible = c.phone > 0.01; phone.scale.setScalar(0.62 * c.phone);
    screenMat.map = c.paid > 0.5 ? screenPaid : screenApprove;
    fpGlow.material.opacity = c.phone * (1 - c.paid) * (0.35 + 0.25 * Math.sin(time * 3));
    contract.visible = c.contract > 0.01; contract.scale.setScalar(Math.max(0.001, c.contract));
    contract.rotation.y = Math.sin(time * 0.6) * 0.25 - 0.3; contract.position.y = 5.6 + Math.sin(time * 1.2) * 0.12;
    beamGroup.visible = c.beams > 0.01; beamMat.uniforms.uI.value = c.beams;

    // shadow under the hero card
    shadow.material.opacity = c.shadow * 0.9 * (1 - c.heroFrame * (mobile ? 0.65 : 0));
    const spread = Math.abs(Math.cos(cardRig.rotation.y)) * W * 0.9 + 1.4;
    shadow.scale.set(spread, 2.2, 1); shadow.position.x = c.cx; shadow.position.z = c.cz;

    // env + lights by chapter
    for (const m of pbr) m.envMapIntensity = c.env;
  frontPrintMat.envMapIntensity = backPrintMat.envMapIntensity = navyEdge.envMapIntensity = c.env * 0.45;
    key.intensity = 0.6 + c.env * 1.0;
    if (c.verify > 0.01) chipGlow.material.opacity = Math.max(chipGlow.material.opacity, c.verify * 0.3);
  }

  /* ---------- labels projection ---------- */
  function placeLabels(c) {
    for (const L of labels) {
      const o = c[L.p] * (c.vis > 0.5 ? 1 : 0);
      if (o < 0.02 || (mobile && L.minor)) { if (L.el.style.opacity !== '0') L.el.style.opacity = '0'; continue; }
      L.v.set(...L.at); L.obj.localToWorld(L.v); L.v.project(camera);
      if (L.v.z > 1) { L.el.style.opacity = '0'; continue; }
      const x = (L.v.x + 1) / 2 * vw, y = (1 - L.v.y) / 2 * vh;
      const margin = mobile ? 14 : 20;
      const bottom = mobile ? vh * 0.48 : vh - margin;
      if (x < margin / 2 || x > vw - margin / 2 || y < margin / 2 || y > bottom) {
        L.el.style.opacity = '0'; continue;
      }
      // Prefer the authored side, flip when it runs off-screen, then clamp.
      // Only the caption moves: its leader remains attached to the 3D point.
      let left = x + L.dx - (L.dx < 0 ? L.width : 0);
      if (left < margin) left = x + Math.abs(L.dx);
      if (left + L.width > vw - margin) left = x - Math.abs(L.dx) - L.width;
      left = clamp(left, margin, Math.max(margin, vw - margin - L.width));
      const captionY = clamp(y + L.dy, margin + L.height / 2, bottom - L.height / 2);
      const dx = (left > x ? left : left + L.width) - x, dy = captionY - y;
      L.textEl.style.left = `${(left - x).toFixed(1)}px`;
      L.textEl.style.top = `${dy.toFixed(1)}px`;
      L.textEl.style.transform = 'translateY(-50%)';
      L.lineEl.style.width = `${Math.hypot(dx, dy).toFixed(1)}px`;
      L.lineEl.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
      L.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      L.el.style.opacity = o.toFixed(3);
    }
  }

  /* ---------- loop ---------- */
  const clock = new THREE.Clock(); let time = 0; let wasHidden = false;
  resize();
  computeTarget(); Object.assign(cur, target);
  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    time += reduced ? 0 : dt;
    computeTarget();
    const k = reduced ? 1 : 1 - Math.exp(-4.2 * dt);
    for (const key of KEYS) cur[key] += (target[key] - cur[key]) * k;
    for (const m of flowMats) m.uniforms.uTime.value = time;
    apply(cur, time);
    placeLabels(cur);
    if (cur.vis < 0.01) { if (!wasHidden) { renderer.clear(); wasHidden = true; } return; }
    wasHidden = false;
    renderer.render(scene, camera);
  }
  // debug/screenshot helper: jump straight to the scroll target without easing
  window.__tap2ethSnap = () => { computeTarget(); Object.assign(cur, target); };
  let disposed = false;
  const start = () => { if (!disposed) renderer.setAnimationLoop(frame); };
  // draw textures with the real fonts when they're ready
  Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 1500))]).then(() => {
    if (disposed) return;
    frontPrintMat.map = cardFrontTex(); backPrintMat.map = cardBackTex();
    frontPrintMat.needsUpdate = backPrintMat.needsUpdate = true;
    // these were drawn before the web fonts arrived; redraw them with the real faces
    const swap = (old, fresh) => { old.dispose(); return fresh; };
    silk.material.map = swap(silk.material.map, readerTex());
    screenApprove = swap(screenApprove, phoneTex(false)); screenPaid = swap(screenPaid, phoneTex(true));
    contractFace.material.map = swap(contractFace.material.map, contractTex());
    const atlas = swap(glyphMap, glyphTex());
    challenge.material.uniforms.uAtlas.value = signature.material.uniforms.uAtlas.value = atlas;
    measure();
    start();
    requestAnimationFrame(() => { if (!disposed) onReady(); });
  });
  return () => {
    disposed = true;
    renderer.setAnimationLoop(null);
    removeEventListener('resize', resize);
    removeEventListener('pointermove', onPtr);
    heroHandlers.forEach(([t, f]) => heroStage.removeEventListener(t, f));
    ro.disconnect();
    labelsEl.innerHTML = '';
    const textures = new Set([scene.environment, screenApprove, screenPaid, glowMap]);
    scene.traverse(o => {
      o.geometry?.dispose();
      [].concat(o.material || []).forEach(m => {
        Object.values(m).forEach(v => v?.isTexture && textures.add(v));
        if (m.uniforms) Object.values(m.uniforms).forEach(u => u.value?.isTexture && textures.add(u.value));
        m.dispose();
      });
    });
    textures.forEach(t => t?.dispose());
    renderer.dispose();
  };

}
