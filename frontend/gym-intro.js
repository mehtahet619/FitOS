(() => {
  const screen = document.getElementById("screen-intro");
  const canvas = document.getElementById("intro-canvas");
  const fallbackCanvas = document.getElementById("intro-fallback-canvas");
  const fallbackLogo = document.querySelector(".intro-logo");
  const message = document.getElementById("intro-message");
  let readyResolve;
  let finishResolve;
  let finishStartedAt = 0;
  let finishStartPhase = 0;
  let finishReachedAt = 0;
  let raf = 0;
  let renderer;
  let staticScene = false;
  let failedScene = false;
  let startAt = 0;
  let fallbackMode = false;
  let fallbackStartAt = 0;
  let fallbackFinishResolve;
  let fallbackFinishAt = 0;
  let fallbackFinishPhase = 0;
  let fallbackFinishReachedAt = 0;
  let fallbackRaf = 0;

  window.FitOSIntroReady = new Promise((resolve) => { readyResolve = resolve; });
  window.FitOSIntroFinishWhenReady = () => {
    if (fallbackMode) return finishFallback();
    if (staticScene || failedScene) return Promise.resolve();
    if (finishResolve) return new Promise((resolve) => {
      const prior = finishResolve;
      finishResolve = () => { prior(); resolve(); };
    });
    return new Promise((resolve) => {
      finishResolve = resolve;
      finishStartedAt = 0;
    });
  };

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const smallScreen = matchMedia("(max-width: 680px)").matches;
  const DURATION = 11.2;
  const HOLD = 1.5;
  const CYCLE = DURATION + HOLD;
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const smooth = (v) => { const t = clamp(v); return t * t * (3 - 2 * t); };
  const between = (t, a, b) => smooth((t - a) / (b - a));
  const phaseAt = (now) => startAt ? ((now - startAt) / 1000) % CYCLE : 0;

  function finishFallback() {
    if (reducedMotion) return Promise.resolve();
    if (fallbackFinishResolve) return new Promise((resolve) => {
      const previous = fallbackFinishResolve;
      fallbackFinishResolve = () => { previous(); resolve(); };
    });
    return new Promise((resolve) => { fallbackFinishResolve = resolve; });
  }

  const failSoft = () => {
    failedScene = true;
    screen.classList.remove("intro-screen--3d-ready");
    screen.classList.add("intro-screen--fallback");
    fallbackLogo.hidden = false;
    startCanvasFallback();
    if (finishResolve) { finishResolve(); finishResolve = null; }
  };

  function startCanvasFallback() {
    const ctx = fallbackCanvas?.getContext("2d", { alpha: true });
    if (!ctx) {
      message.classList.add("is-visible");
      readyResolve?.(false);
      return;
    }
    fallbackMode = true;
    fallbackStartAt = performance.now();
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, smallScreen ? 1.25 : 1.5);
      fallbackCanvas.width = Math.round(innerWidth * dpr);
      fallbackCanvas.height = Math.round(innerHeight * dpr);
      fallbackCanvas.style.width = `${innerWidth}px`;
      fallbackCanvas.style.height = `${innerHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    addEventListener("resize", resize, { passive: true });
    let frame = 0;
    const render = (now) => {
      fallbackRaf = requestAnimationFrame(render);
      if (document.hidden || !screen.classList.contains("active")) return;
      let t = ((now - fallbackStartAt) / 1000) % CYCLE;
      if (fallbackFinishResolve) {
        if (!fallbackFinishAt && now >= fallbackStartAt + 2000) {
          fallbackFinishAt = now;
          fallbackFinishPhase = t;
        }
        if (fallbackFinishAt) {
          const progress = clamp((now - fallbackFinishAt) / 2200);
          if (progress >= 1) {
            t = 10.8;
            if (!fallbackFinishReachedAt) fallbackFinishReachedAt = now;
            if (now - fallbackFinishReachedAt > 850) {
              const complete = fallbackFinishResolve;
              fallbackFinishResolve = null;
              complete?.();
            }
          } else t = fallbackFinishPhase + (10.8 - fallbackFinishPhase) * smooth(progress);
        }
      }
      drawFallbackFrame(ctx, innerWidth, innerHeight, t, now);
      fallbackCanvas.dataset.frame = String(++frame);
    };
    if (reducedMotion) {
      drawFallbackFrame(ctx, innerWidth, innerHeight, 10.8, performance.now());
      screen.classList.add("intro-screen--fallback-grown");
      message.classList.add("is-visible");
      readyResolve?.(true);
    } else {
      readyResolve?.(true);
      fallbackRaf = requestAnimationFrame(render);
    }
  }

  function drawFallbackFrame(ctx, width, height, time, now) {
    ctx.clearRect(0, 0, width, height);
    const seed = smooth((time - 2.05) / .95);
    const descent = smooth((time - 3.0) / 1.05);
    const germination = smooth((time - 5.75) / .8);
    const growth = smooth((time - 6.0) / 4.1);
    const baseY = height * .73;
    const centerX = width * .5;
    const scale = Math.min(width, height);
    const showTree = time >= 6;
    screen.classList.toggle("intro-screen--fallback-grown", time > 2.35);

    const soil = ctx.createLinearGradient(0, baseY - 12, 0, height);
    soil.addColorStop(0, "#392718"); soil.addColorStop(.3, "#20170f"); soil.addColorStop(1, "#090b09");
    ctx.beginPath(); ctx.moveTo(0, baseY + 14);
    ctx.quadraticCurveTo(width * .19, baseY - 22, centerX - scale * .18, baseY - 10);
    ctx.quadraticCurveTo(centerX, baseY - scale * .055, centerX + scale * .18, baseY - 9);
    ctx.quadraticCurveTo(width * .81, baseY - 25, width, baseY + 10);
    ctx.lineTo(width, height); ctx.lineTo(0, height); ctx.closePath();
    ctx.fillStyle = soil; ctx.fill();
    ctx.strokeStyle = "rgba(158, 106, 52, .35)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(centerX - scale * .17, baseY - 9); ctx.quadraticCurveTo(centerX, baseY - scale * .055, centerX + scale * .18, baseY - 9); ctx.stroke();

    const rootGlow = smooth((time - 5.8) / 1.3);
    ctx.save(); ctx.globalAlpha = .13 + rootGlow * .35; ctx.shadowColor = "#50d990"; ctx.shadowBlur = 14;
    ctx.strokeStyle = "#b17a3d"; ctx.lineWidth = 2;
    for (let i = 0; i < 9; i++) {
      const side = i % 2 ? 1 : -1; const spread = scale * (.04 + Math.floor(i / 2) * .035);
      ctx.beginPath(); ctx.moveTo(centerX, baseY - 5); ctx.quadraticCurveTo(centerX + side * spread * .45, baseY + 15, centerX + side * spread, baseY + scale * (.075 + (i % 3) * .018)); ctx.stroke();
    }
    ctx.restore();

    if (time > 4.35 && time < 5.65) {
      for (let i = 0; i < 7; i++) {
        const local = (time - 4.35 - i * .13) / .72;
        if (local < 0 || local > 1) continue;
        const x = centerX + (i - 3) * scale * .025;
        const y = height * .31 + local * (baseY - height * .31);
        const radius = scale * .004;
        const drop = ctx.createRadialGradient(x - radius * .3, y - radius * .4, radius * .1, x, y, radius * 1.4);
        drop.addColorStop(0, "#f0fff6"); drop.addColorStop(.35, "#a3e9d2"); drop.addColorStop(1, "rgba(57, 154, 128, .2)");
        ctx.fillStyle = drop; ctx.beginPath(); ctx.ellipse(x, y, radius * .72, radius * 1.35, -.18, 0, Math.PI * 2); ctx.fill();
      }
    }

    if (!showTree) {
      const fall = smooth((time - 2.75) / 1.2);
      const seedY = height * (.35 + .38 * fall);
      const radius = scale * (.018 + seed * .006);
      if (seed < .94) {
        const seedGradient = ctx.createLinearGradient(centerX - radius, seedY - radius, centerX + radius, seedY + radius);
        seedGradient.addColorStop(0, "#b5e96a"); seedGradient.addColorStop(.35, "#438e37"); seedGradient.addColorStop(1, "#123a2d");
        ctx.save(); ctx.translate(centerX, seedY); ctx.rotate(-.48 + fall * .7); ctx.shadowColor = "rgba(62, 227, 147, .4)"; ctx.shadowBlur = 18;
        ctx.fillStyle = seedGradient; ctx.beginPath(); ctx.ellipse(0, 0, radius * .72, radius * 1.35, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
      if (germination > 0) {
        ctx.strokeStyle = "#65c96a"; ctx.lineWidth = Math.max(2, scale * .008); ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(centerX, baseY - 8); ctx.quadraticCurveTo(centerX - scale * .012, baseY - scale * .05, centerX + scale * .005, baseY - scale * (.13 * germination)); ctx.stroke();
        drawFallbackLeaf(ctx, centerX - scale * .015, baseY - scale * .08 * germination, -.55, scale * .045 * germination, "#75d45d");
        drawFallbackLeaf(ctx, centerX + scale * .008, baseY - scale * .12 * germination, .7, scale * .04 * germination, "#a0de51");
      }
    } else {
      const treeHeight = scale * .53 * growth;
      const topY = baseY - treeHeight;
      const trunkGradient = ctx.createLinearGradient(centerX - scale * .024, baseY, centerX + scale * .025, topY);
      trunkGradient.addColorStop(0, "#36231a"); trunkGradient.addColorStop(.45, "#805331"); trunkGradient.addColorStop(1, "#423020");
      ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = trunkGradient; ctx.lineWidth = Math.max(5, scale * .025 * growth);
      ctx.beginPath(); ctx.moveTo(centerX, baseY); ctx.bezierCurveTo(centerX - scale * .025, baseY - treeHeight * .38, centerX + scale * .02, baseY - treeHeight * .7, centerX, topY); ctx.stroke();
      const branchEnds = [
        [centerX - scale * .18, topY + treeHeight * .36, -1], [centerX + scale * .19, topY + treeHeight * .4, 1],
        [centerX - scale * .14, topY + treeHeight * .65, -1], [centerX + scale * .15, topY + treeHeight * .68, 1],
        [centerX - scale * .08, topY + treeHeight * .88, -1], [centerX + scale * .085, topY + treeHeight * .9, 1]
      ];
      branchEnds.forEach(([x, y, side], i) => {
        const portion = smooth((growth - .15 - i * .035) / .5);
        if (!portion) return;
        ctx.globalAlpha = portion; ctx.lineWidth = Math.max(2, scale * (.011 - i * .0007) * portion);
        ctx.beginPath(); ctx.moveTo(centerX + side * scale * .005, baseY - treeHeight * (.28 + (i % 3) * .19));
        ctx.quadraticCurveTo(centerX + (x - centerX) * .38, y + treeHeight * .22, centerX + (x - centerX) * portion, y); ctx.stroke();
      });
      ctx.globalAlpha = 1;
      const canopyCenterY = topY + treeHeight * .08;
      const leafCount = smallScreen ? 52 : 86;
      for (let i = 0; i < leafCount; i++) {
        const angle = i * 2.399963;
        const radius = Math.sqrt((i + .5) / leafCount);
        const leafX = centerX + Math.cos(angle) * scale * .19 * radius;
        const leafY = canopyCenterY + Math.sin(angle) * scale * .145 * radius;
        const appear = smooth((growth - .25 - radius * .32 - (i % 5) * .012) / .4);
        if (!appear) continue;
        const color = ["#276e3c", "#39984a", "#70b947", "#95c94c", "#1d6749"][i % 5];
        drawFallbackLeaf(ctx, leafX, leafY, angle + Math.sin(i) * .5, scale * .027 * appear, color);
      }
    }

    if (!reducedMotion) {
      ctx.save(); ctx.globalAlpha = .32;
      for (let i = 0; i < 17; i++) {
        const x = (i * 97.3 + Math.sin(now * .00018 + i) * 16) % width;
        const y = (i * 53.7 + Math.cos(now * .00014 + i * 2) * 11) % (height * .78);
        ctx.fillStyle = i % 3 ? "#b8d7a0" : "#e0c17c"; ctx.beginPath(); ctx.arc(x, y, i % 4 === 0 ? 1.7 : 1, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
    message.classList.toggle("is-visible", time > 10.15);
  }

  function drawFallbackLeaf(ctx, x, y, angle, size, color) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
    const fill = ctx.createLinearGradient(-size, size, size, -size);
    fill.addColorStop(0, "#15785a"); fill.addColorStop(.45, color); fill.addColorStop(1, "#c3df5a");
    ctx.fillStyle = fill; ctx.beginPath(); ctx.moveTo(0, size);
    ctx.bezierCurveTo(-size * .18, size * .1, -size * .88, -size * .58, 0, -size);
    ctx.bezierCurveTo(size * .85, -size * .5, size * .18, size * .1, 0, size); ctx.fill();
    ctx.strokeStyle = "rgba(208, 239, 142, .58)"; ctx.lineWidth = Math.max(1, size * .035);
    ctx.beginPath(); ctx.moveTo(0, size * .76); ctx.quadraticCurveTo(size * .08, 0, 0, -size * .75); ctx.stroke(); ctx.restore();
  }

  async function start() {
    try {
      const THREE = await import("https://cdn.jsdelivr.net/npm/three@0.182.0/build/three.module.js");
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 80);
      camera.position.set(0, 0, 16);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, smallScreen ? 1.35 : 1.8);
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: !smallScreen, powerPreference: "low-power" });
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(innerWidth, innerHeight, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.08;
      let shaderFailed = false;
      renderer.debug.onShaderError = () => { shaderFailed = true; };

      scene.add(new THREE.AmbientLight(0x9bc7a9, 1.45));
      const key = new THREE.DirectionalLight(0xf5d59b, 3.1); key.position.set(-4, 6, 7); scene.add(key);
      const rim = new THREE.PointLight(0x22e8a3, 18, 14, 1.5); rim.position.set(3, 1, 4); scene.add(rim);
      const groundGlow = new THREE.PointLight(0x25d68d, 0, 6, 1.8); groundGlow.position.set(0, -2.2, 2); scene.add(groundGlow);

      const background = new THREE.TextureLoader().load("assets/gym-intro.webp", (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(26, 17), new THREE.MeshBasicMaterial({ map: tex, color: 0x53665d, transparent: true, opacity: 0.32 }));
        plane.position.set(0, 0, -9); scene.add(plane);
      }, undefined, () => console.warn("Gym background image unavailable; using the charcoal scene background."));
      background.colorSpace = THREE.SRGBColorSpace;

      const { texture: logoTexture, geometry: logoGeometry } = await makeLogoAsset(THREE);
      const logoMaterial = new THREE.ShaderMaterial({
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        uniforms: { uLogo: { value: logoTexture }, uMorph: { value: 0 }, uOpacity: { value: 1 } },
        vertexShader: `varying vec2 vUv; varying vec3 vPos; uniform float uMorph;
          void main(){ vUv=uv; vec3 leaf=position; float split=.17+.54*uv.x; float leafSide=smoothstep(split-.035,split+.035,uv.y)*2.-1.;
          vec3 seed=vec3(position.x*.42,position.y*.42-leafSide*.18,leafSide*.13+abs(position.x)*.035);
          seed.z+=sin(uMorph*3.14159265)*leafSide*.085; vec3 p=mix(leaf,seed,uMorph);
          p.z+=sin(uMorph*3.14159265)*leafSide*.055; vPos=p; gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.); }`,
        fragmentShader: `uniform sampler2D uLogo; uniform float uMorph; uniform float uOpacity; varying vec2 vUv; varying vec3 vPos;
          void main(){ vec4 logo=texture2D(uLogo,vUv); float mask=logo.a; vec3 n=normalize(vPos+vec3(.0001)); vec3 lightDir=normalize(vec3(-.45,.72,1.));
          float diffuse=max(dot(n,lightDir),0.); float spec=pow(max(dot(reflect(-lightDir,n),vec3(0.,0.,1.)),0.),28.);
          vec3 seed=logo.rgb*(.82+diffuse*.3)+spec*.28+pow(1.-abs(n.z),3.)*vec3(.025,.13,.075);
          vec3 color=mix(logo.rgb,seed,uMorph); float alpha=mask*uOpacity; if(alpha<.01) discard; gl_FragColor=vec4(color,alpha); }`
      });
      const logo = new THREE.Mesh(logoGeometry, logoMaterial);
      logo.position.set(0, 0.25, 2); scene.add(logo);

      const soilShape = new THREE.Shape();
      soilShape.moveTo(-6, -3.45); soilShape.lineTo(-6, -2.5); soilShape.quadraticCurveTo(-3.2, -2.16, -1.8, -2.38);
      soilShape.quadraticCurveTo(0, -2.05, 1.6, -2.34); soilShape.quadraticCurveTo(4, -2.08, 6, -2.48); soilShape.lineTo(6, -3.45); soilShape.closePath();
      const soil = new THREE.Mesh(new THREE.ExtrudeGeometry(soilShape, { depth: .35, bevelEnabled: true, bevelSegments: 3, steps: 1, bevelSize: .13, bevelThickness: .14 }), new THREE.MeshStandardMaterial({ color: 0x21180f, roughness: .94 }));
      soil.position.z = 1; soil.scale.set(1, .001, 1); scene.add(soil);

      const crackMaterial = new THREE.MeshStandardMaterial({ color: 0x20371c, roughness: .5, side: THREE.DoubleSide });
      const shellLeft = new THREE.Mesh(new THREE.SphereGeometry(.22, 18, 12, 0, Math.PI), crackMaterial);
      const shellRight = new THREE.Mesh(new THREE.SphereGeometry(.22, 18, 12, Math.PI, Math.PI), crackMaterial);
      [shellLeft, shellRight].forEach((s) => { s.scale.set(.72, 1.4, .7); s.position.set(0, -2.04, 2); s.visible = false; scene.add(s); });

      const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x5b3821, roughness: .73 });
      const trunk = makeTube(THREE, [[0,0,1.7],[.02,.8,1.7],[-.04,1.7,1.7],[.08,2.52,1.7],[0,3.44,1.7]], .13, trunkMaterial);
      trunk.scale.y = .001; trunk.position.y=-2.32; scene.add(trunk);
      const branches = [];
      const branchSpecs = [
        [[0,-.42,1.7],[-.42,.1,1.68],[-1.02,.45,1.65],[-1.55,.62,1.62]],
        [[0,-.05,1.7],[.5,.43,1.68],[1.12,.72,1.65],[1.58,.92,1.62]],
        [[.02,.45,1.7],[-.36,.93,1.68],[-.78,1.31,1.65],[-1.03,1.56,1.62]],
        [[.03,.78,1.7],[.43,1.15,1.68],[.86,1.42,1.65],[1.08,1.68,1.62]],
        [[.02,1.04,1.7],[.03,1.46,1.68],[.17,1.78,1.65],[.28,2.02,1.62]],
      ];
      branchSpecs.forEach((points, i) => {
        const [anchorX,anchorY,anchorZ]=points[0];
        const localPoints=points.map(([x,y,z])=>[x-anchorX,y-anchorY,z-anchorZ]);
        const branch=makeTube(THREE,localPoints,.075-i*.006,trunkMaterial);
        branch.scale.set(.001,.001,.001); branch.position.set(anchorX,anchorY,anchorZ); scene.add(branch); branches.push(branch);
      });

      const leaves = [];
      const leafGeo = createLeafGeometry(THREE);
      const leafColors = [0x1d7c43,0x2ea657,0x5abd42,0x8ac84b,0x19734c];
      for (let i=0;i<(smallScreen?58:104);i++) {
        const theta = i*2.399963; const radius = Math.sqrt((i+.5)/(smallScreen?58:104));
        const x = Math.cos(theta)*radius*1.75; const y = 1.15 + Math.sin(theta)*radius*1.02;
        const m = new THREE.MeshStandardMaterial({ color: leafColors[i%leafColors.length], roughness:.38, metalness:.02, side:THREE.DoubleSide, emissive:0x052510, emissiveIntensity:.2 });
        const leaf = new THREE.Mesh(leafGeo,m); leaf.position.set(x,y,1.68 + (1-radius)*.32); leaf.rotation.set((Math.random()-.5)*.7,theta,(Math.random()-.5)*.9); leaf.scale.set(.001,.001,.001); scene.add(leaf); leaves.push({mesh:leaf, delay:6.9+radius*2.1+(i%5)*.045});
      }

      const roots = [];
      for(let i=0;i<13;i++){
        const side=i%2?1:-1, d=(Math.floor(i/2)+1)/7;
        const points=[[0,0,1.75],[side*.17,-.18,1.8],[side*(.28+d*.95),-.37,1.8],[side*(.38+d*1.55),-.59,1.8]];
        const root=makeTube(THREE,points,.022+(i%3)*.006,new THREE.MeshStandardMaterial({color:0x9a672e,roughness:.65,emissive:0x98641b,emissiveIntensity:0})); root.scale.set(.001,.001,.001); root.position.y=-2.35; scene.add(root); roots.push(root);
      }

      const drops=[];
      const dropMat=new THREE.MeshPhysicalMaterial({color:0x9eeed3,roughness:.08,metalness:.1,clearcoat:1,clearcoatRoughness:.04});
      for(let i=0;i<8;i++){const d=new THREE.Mesh(new THREE.SphereGeometry(.035,10,8),dropMat);d.position.set(-.8+i*.23,1.6,2.2);d.visible=false;scene.add(d);drops.push(d);}
      const particles=[]; const particleGeo=new THREE.SphereGeometry(.018,6,5);
      for(let i=0;i<(smallScreen?20:34);i++){const p=new THREE.Mesh(particleGeo,new THREE.MeshBasicMaterial({color:i%3?0x9ccf88:0xf0cc79,transparent:true,opacity:.38}));p.userData={x:(Math.random()-.5)*8,y:-1.8+Math.random()*4.5,z:2.7+Math.random()*1.2,s:Math.random()*1.7+.5};scene.add(p);particles.push(p);}
      const impactParticles=[];
      for(let i=0;i<6;i++){
        const material=new THREE.MeshStandardMaterial({color:i%2?0x704a2d:0x9b6938,roughness:.95,transparent:true,opacity:0});
        const particle=new THREE.Mesh(new THREE.SphereGeometry(.018+(i%3)*.006,8,6),material);
        scene.add(particle); impactParticles.push({mesh:particle,side:i%2?1:-1,spread:.12+Math.floor(i/2)*.08,lift:.08+(i%3)*.035});
      }

      const resize=()=>{const w=innerWidth,h=innerHeight; renderer.setSize(w,h,false); camera.aspect=w/h; camera.position.z=w/h<.72?19:16; camera.updateProjectionMatrix();};
      addEventListener("resize",resize,{passive:true}); resize();
      const startTime=performance.now();
      startAt=startTime;
      const draw=(now)=>{
        raf=requestAnimationFrame(draw);
        if(document.hidden || !screen.classList.contains("active")) return;
        let phase=phaseAt(now);
        if(finishResolve){
          if(!finishStartedAt && phase>=4.05){finishStartedAt=now;finishStartPhase=Math.min(phase,10.8);}
          if(finishStartedAt){
            const progress=clamp((now-finishStartedAt)/1800);
            if(progress>=1){phase=10.8;message.classList.add("is-visible");if(!finishReachedAt)finishReachedAt=now;if(now-finishReachedAt>850){finishResolve();finishResolve=null;}}
            else phase=finishStartPhase+(DURATION-finishStartPhase)*smooth(progress);
          }
        }
        const t=phase;
        const motionProgress=clamp(t/4.43);
        const morph=between(motionProgress,1.7/4.43,2.65/4.43);
        const descent=between(motionProgress,2.85/4.43,4.05/4.43);
        const seedY=.22-2.26*descent;
        const sharedRotationY=1.1*smooth(motionProgress);
        logoMaterial.uniforms.uMorph.value=morph;
        logoMaterial.uniforms.uOpacity.value=1-between(t,5.38,5.72);
        const impactProgress=clamp((t-4.05)/.38);
        const impactPulse=(t>=4.05&&t<4.43)?Math.sin(Math.PI*impactProgress)*.028:0;
        logo.position.set(0,seedY+impactPulse,2);
        logo.scale.set(1,1-.055*Math.sin(Math.PI*impactProgress),1);
        logo.rotation.set(0,sharedRotationY,0);
        soil.scale.y=.001+between(t,2.72,4.1)*.999;
        soil.position.y=-3.45+3.45*soil.scale.y;
        const crack=between(t,5.4,5.95);
        shellLeft.visible=crack>.01&&t<6.6; shellRight.visible=shellLeft.visible;
        shellLeft.position.set(-.08*crack,-2.04-.15*crack,2); shellRight.position.set(.08*crack,-2.04-.15*crack,2);
        const germ=between(t,5.9,6.55); const growth=between(t,6.0,10.1);
        trunk.scale.y=.001+growth; trunk.position.y=-2.32*growth;
        branches.forEach((b,i)=>{const q=between(t,7.15+i*.28,8.05+i*.34);b.scale.set(q,q,q);});
        leaves.forEach(({mesh,delay})=>{const q=between(t,delay,delay+.8)*growth;mesh.scale.set(.22*q,.42*q,.11*q);});
        roots.forEach((r,i)=>{const q=between(t,6.05+i*.045,7.9+i*.035);r.scale.set(q,q,q);r.material.emissiveIntensity=.05+between(t,9.1,10.6)*.8;});
        groundGlow.intensity=12*between(t,5.9,6.8)+7*between(t,9.2,10.8);
        soil.material.color.setRGB(.13-.055*between(t,4.5,5.6),.085-.04*between(t,4.5,5.6),.05-.024*between(t,4.5,5.6));
        drops.forEach((d,i)=>{const local=(t-4.45-i*.12);d.visible=local>0&&local<.68;d.position.y=1.5-2.9*clamp(local/.68);});
        impactParticles.forEach(({mesh,side,spread,lift})=>{
          mesh.visible=t>=4.02&&t<4.44;
          const q=clamp((t-4.02)/.42);
          mesh.position.set(side*spread*q,-2.08+4*lift*q*(1-q),2.25);
          mesh.material.opacity=1-q;
        });
        particles.forEach((p)=>{p.position.y=p.userData.y+Math.sin(now*.00065*p.userData.s+p.userData.x)*.13;p.position.x=p.userData.x+Math.sin(now*.0003*p.userData.s)*.08;});
        const reveal=between(t,9.8,10.8); message.classList.toggle("is-visible",reveal>.96);
        camera.position.x=Math.sin(now*.00015)*.12; camera.position.y=Math.cos(now*.00019)*.05- .22*descent; camera.lookAt(0,-.12-.38*descent,0);
        rim.intensity=18+Math.sin(now*.001)*1.4; key.intensity=3.1+between(t,9.1,10.8)*1.15;
        try {
          renderer.render(scene,camera);
          if(shaderFailed) throw new Error("Intro shader compilation failed.");
          if(!screen.classList.contains("intro-screen--3d-ready")){
            screen.classList.add("intro-screen--3d-ready");
            fallbackLogo.hidden=true;
            readyResolve?.(true);
          }
        } catch (error) {
          cancelAnimationFrame(raf);
          console.warn("Intro WebGL render failed; continuing with the static intro.");
          failSoft();
        }
      };
      if(reducedMotion){
        staticScene=true; logo.visible=false; soil.scale.y=1; trunk.scale.y=1; roots.forEach(r=>r.scale.set(1,1,1));
        branches.forEach(b=>b.scale.set(1,1,1)); leaves.forEach(({mesh})=>mesh.scale.set(.22,.42,.11)); message.classList.add("is-visible");
        renderer.render(scene,camera);
        screen.classList.add("intro-screen--3d-ready"); fallbackLogo.hidden=true; readyResolve?.(true);
      } else { draw(startTime); }
    } catch (error) {
      console.warn("Intro animation unavailable; continuing with the static intro.", error?.message || error);
      failSoft();
    }
  }

  function makeTube(THREE,points,radius,material){
    const curve=new THREE.CatmullRomCurve3(points.map(([x,y,z])=>new THREE.Vector3(x,y,z)));
    return new THREE.Mesh(new THREE.TubeGeometry(curve,20,radius,7,false),material);
  }
  function createLeafGeometry(THREE){
    const verts=[],uv=[],indices=[];const rows=10,cols=5;
    for(let i=0;i<=rows;i++){const v=i/rows;const width=Math.sin(Math.PI*v)*.5;
      for(let j=0;j<=cols;j++){const u=j/cols-.5;verts.push(u*width*2,v-.5,Math.sin(v*Math.PI)*.04*(1-Math.abs(u)*2));uv.push(j/cols,v);}
    }
    for(let i=0;i<rows;i++)for(let j=0;j<cols;j++){const a=i*(cols+1)+j,b=a+cols+1;indices.push(a,b,a+1,b,b+1,a+1);}
    const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(verts,3));g.setAttribute("uv",new THREE.Float32BufferAttribute(uv,2));g.setIndex(indices);g.computeVertexNormals();return g;
  }
  async function makeLogoAsset(THREE){
    const image=new Image();image.src="assets/site-logo.png";await image.decode();
    const source=document.createElement("canvas");source.width=source.height=256;const ctx=source.getContext("2d",{willReadFrequently:true});ctx.drawImage(image,0,0,256,256);
    const img=ctx.getImageData(0,0,256,256),d=img.data;let minX=256,minY=256,maxX=0,maxY=0;
    for(let y=0;y<256;y++)for(let x=0;x<256;x++){const i=(y*256+x)*4;const brightness=(d[i]+d[i+1]+d[i+2])/3;if(brightness<42){d[i+3]=0;}else{d[i+3]=Math.min(255,Math.max(0,(brightness-30)*9));minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}}
    ctx.putImageData(img,0,0);const crop=document.createElement("canvas");crop.width=crop.height=256;crop.getContext("2d").drawImage(source,minX,minY,maxX-minX+1,maxY-minY+1,22,22,212,212);
    const texture=new THREE.CanvasTexture(crop);texture.colorSpace=THREE.SRGBColorSpace;texture.needsUpdate=true;
    const cropContext=crop.getContext("2d",{willReadFrequently:true});
    // The PNG has a black RGB backdrop, so derive real mesh geometry from its green silhouette mask.
    const silhouette=traceLogoSilhouette(cropContext.getImageData(0,0,256,256));
    if(silhouette.length<3)throw new Error("The FitOS logo silhouette could not be extracted.");
    const lowX=Math.min(...silhouette.map(p=>p.x)),highX=Math.max(...silhouette.map(p=>p.x));
    const lowY=Math.min(...silhouette.map(p=>p.y)),highY=Math.max(...silhouette.map(p=>p.y));
    const centerX=(lowX+highX)/2,centerY=(lowY+highY)/2,scale=2.45/Math.max(highX-lowX,highY-lowY);
    const shape=new THREE.Shape();
    silhouette.forEach((point,index)=>{
      const x=(point.x-centerX)*scale,y=(centerY-point.y)*scale;
      if(index===0)shape.moveTo(x,y);else shape.lineTo(x,y);
    });
    shape.closePath();
    let geometry=new THREE.ExtrudeGeometry(shape,{depth:.08,bevelEnabled:true,bevelSegments:1,steps:1,bevelSize:.018,bevelThickness:.018});
    geometry.translate(0,0,-.04);
    const positions=geometry.attributes.position,uvs=new Float32Array(positions.count*2);
    for(let i=0;i<positions.count;i++){
      const px=positions.getX(i)/scale+centerX,py=centerY-positions.getY(i)/scale;
      uvs[i*2]=px/256;uvs[i*2+1]=1-py/256;
    }
    geometry.setAttribute("uv",new THREE.BufferAttribute(uvs,2));
    geometry=subdivideGeometry(THREE,geometry,3);
    return {texture,geometry};
  }

  function traceLogoSilhouette(imageData){
    const {data,width,height}=imageData,filled=(x,y)=>x>=0&&x<width&&y>=0&&y<height&&data[(y*width+x)*4+3]>40;
    const edges=[],starts=new Map(),key=(p)=>`${p.x},${p.y}`;
    const add=(a,b)=>{const index=edges.length;edges.push({a,b,used:false});const k=key(a);if(!starts.has(k))starts.set(k,[]);starts.get(k).push(index);};
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(filled(x,y)){
      if(!filled(x,y-1))add({x,y},{x:x+1,y});
      if(!filled(x+1,y))add({x:x+1,y},{x:x+1,y:y+1});
      if(!filled(x,y+1))add({x:x+1,y:y+1},{x,y:y+1});
      if(!filled(x-1,y))add({x,y:y+1},{x,y});
    }
    let largest=[],largestArea=0;
    for(let start=0;start<edges.length;start++){
      if(edges[start].used)continue;
      const points=[];let edgeIndex=start,guard=0;const origin=key(edges[start].a);
      while(edgeIndex!==undefined&&!edges[edgeIndex].used&&guard++<=edges.length){
        const edge=edges[edgeIndex];edge.used=true;points.push(edge.a);
        if(key(edge.b)===origin)break;
        const candidates=(starts.get(key(edge.b))||[]).filter(i=>!edges[i].used);
        if(!candidates.length){edgeIndex=undefined;break;}
        const incoming=(Math.atan2(edge.b.y-edge.a.y,edge.b.x-edge.a.x)+Math.PI*2)%(Math.PI*2);
        const direction=(angle)=>Math.round(angle/(Math.PI/2))%4;
        const inDirection=direction(incoming),priority=[1,0,3,2];
        candidates.sort((a,b)=>{
          const angle=(i)=>direction((Math.atan2(edges[i].b.y-edges[i].a.y,edges[i].b.x-edges[i].a.x)+Math.PI*2)%(Math.PI*2));
          const turn=(i)=>(angle(i)-inDirection+4)%4;return priority.indexOf(turn(a))-priority.indexOf(turn(b));
        });
        edgeIndex=candidates[0];
      }
      if(points.length<3)continue;
      const simplified=simplifyLogoContour(points,1.8);let area=0;
      for(let i=0;i<simplified.length;i++){const a=simplified[i],b=simplified[(i+1)%simplified.length];area+=a.x*b.y-b.x*a.y;}
      if(Math.abs(area)>largestArea){largestArea=Math.abs(area);largest=simplified;}
    }
    return largest;
  }

  function simplifyLogoContour(points,tolerance){
    const out=[points[0]];let last=points[0];
    for(let i=1;i<points.length;i++){
      const p=points[i],dx=p.x-last.x,dy=p.y-last.y;
      if(dx*dx+dy*dy>=tolerance*tolerance){out.push(p);last=p;}
    }
    if(out.length>3){const first=out[0],end=out[out.length-1];if((first.x-end.x)**2+(first.y-end.y)**2<tolerance*tolerance)out.pop();}
    return out;
  }

  function subdivideGeometry(THREE,geometry,levels){
    const source=geometry;
    const positions=Array.from(source.attributes.position.array),uvs=Array.from(source.attributes.uv.array);
    let indices=source.index?Array.from(source.index.array):Array.from({length:source.attributes.position.count},(_,i)=>i);
    for(let level=0;level<levels;level++){
      const midpoints=new Map(),next=[];
      const midpoint=(a,b)=>{
        const first=Math.min(a,b),second=Math.max(a,b),key=`${first}:${second}`;
        if(midpoints.has(key))return midpoints.get(key);
        const index=positions.length/3;
        for(let axis=0;axis<3;axis++)positions.push((positions[a*3+axis]+positions[b*3+axis])*.5);
        for(let axis=0;axis<2;axis++)uvs.push((uvs[a*2+axis]+uvs[b*2+axis])*.5);
        midpoints.set(key,index);return index;
      };
      for(let i=0;i<indices.length;i+=3){
        const a=indices[i],b=indices[i+1],c=indices[i+2],ab=midpoint(a,b),bc=midpoint(b,c),ca=midpoint(c,a);
        next.push(a,ab,ca,ab,b,bc,ca,bc,c,ab,bc,ca);
      }
      indices=next;
    }
    const result=new THREE.BufferGeometry();
    result.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));
    result.setAttribute("uv",new THREE.Float32BufferAttribute(uvs,2));
    result.setIndex(indices);result.computeVertexNormals();source.dispose();if(source!==geometry)geometry.dispose();return result;
  }
  start();
  addEventListener("pagehide",()=>{cancelAnimationFrame(raf);renderer?.dispose();},{once:true});
})();
