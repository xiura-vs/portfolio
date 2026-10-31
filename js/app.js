(() => {
    'use strict';

    document.getElementById('year').textContent = new Date().getFullYear();

    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const state = { intro: 0 };               // 0 → 1 once the loader finishes (orb pop-in)
    window.FX = { pulse: () => { } };          // filled in below; handy for Step 4

    /* ==========================================================
       1. 3D SETUP (wrapped so the page still works without WebGL)
       ========================================================== */
    try {
        const { MathUtils } = THREE;
        const ADD = THREE.AdditiveBlending;

        const COL = {
            cyan: new THREE.Color(0x00f0ff),
            magenta: new THREE.Color(0xff2e97),
            lime: new THREE.Color(0xb6ff3b),
            violet: new THREE.Color(0x8b5cf6),
            white: new THREE.Color(0xffffff)
        };

        /* ---------- Layer factory: renderer + scene + camera ---------- */
        function createLayer(canvas) {
            const renderer = new THREE.WebGLRenderer({
                canvas, antialias: true, alpha: true, powerPreference: 'high-performance'
            });
            renderer.setPixelRatio(Math.min(window.devicePixelRatio, isTouch ? 1.5 : 2));
            renderer.setSize(window.innerWidth, window.innerHeight, false);
            renderer.setClearColor(0x000000, 0);

            const scene = new THREE.Scene();
            const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
            camera.position.set(0, 0, 10);
            camera.updateProjectionMatrix();
            camera.updateMatrixWorld();
            return { renderer, scene, camera };
        }

        // Background layer (behind UI) uses the existing canvas from Step 1
        const bg = createLayer(document.getElementById('bg-canvas'));

        // Cursor layer (above UI) is created here
        const cursorCanvas = document.createElement('canvas');
        cursorCanvas.id = 'cursor-canvas';
        cursorCanvas.setAttribute('aria-hidden', 'true');
        Object.assign(cursorCanvas.style, {
            position: 'fixed', inset: '0', width: '100%', height: '100%',
            zIndex: '90', pointerEvents: 'none'
        });
        document.body.appendChild(cursorCanvas);
        const cur = createLayer(cursorCanvas);

        /* ---------- Shared soft-glow texture (no postprocessing needed) ---------- */
        function makeGlowTexture() {
            const c = document.createElement('canvas');
            c.width = c.height = 128;
            const g = c.getContext('2d');
            const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
            grad.addColorStop(0.0, 'rgba(255,255,255,1)');
            grad.addColorStop(0.2, 'rgba(255,255,255,0.55)');
            grad.addColorStop(0.5, 'rgba(255,255,255,0.12)');
            grad.addColorStop(1.0, 'rgba(255,255,255,0)');
            g.fillStyle = grad;
            g.fillRect(0, 0, 128, 128);
            return new THREE.CanvasTexture(c);
        }
        const glowTex = makeGlowTexture();

        /* ==========================================================
           2. BACKGROUND: floating node network
           ========================================================== */
        const field = new THREE.Group();
        bg.scene.add(field);

        const NODES = isTouch ? 130 : 260;   // lighter on phones
        const nodePos = new Float32Array(NODES * 3);
        const nodeCol = new Float32Array(NODES * 3);
        const tmpC = new THREE.Color();

        for (let i = 0; i < NODES; i++) {
            nodePos[i * 3] = (Math.random() - 0.5) * 36;   // x
            nodePos[i * 3 + 1] = (Math.random() - 0.5) * 28;   // y
            nodePos[i * 3 + 2] = Math.random() * 18 - 14;      // z (-14 → 4)
            tmpC.copy(COL.cyan).lerp(COL.violet, Math.random()).multiplyScalar(0.35 + Math.random() * 0.65);
            nodeCol.set([tmpC.r, tmpC.g, tmpC.b], i * 3);
        }

        const nodeGeo = new THREE.BufferGeometry();
        nodeGeo.setAttribute('position', new THREE.BufferAttribute(nodePos, 3));
        nodeGeo.setAttribute('color', new THREE.BufferAttribute(nodeCol, 3));
        const nodes = new THREE.Points(nodeGeo, new THREE.PointsMaterial({
            size: 0.2, map: glowTex, vertexColors: true, transparent: true,
            depthWrite: false, blending: ADD, sizeAttenuation: true
        }));
        field.add(nodes);

        // Static faint connections between nearby nodes
        const segs = [];
        outer:
        for (let i = 0; i < NODES; i++) {
            for (let j = i + 1; j < NODES; j++) {
                const dx = nodePos[i * 3] - nodePos[j * 3];
                const dy = nodePos[i * 3 + 1] - nodePos[j * 3 + 1];
                const dz = nodePos[i * 3 + 2] - nodePos[j * 3 + 2];
                if (dx * dx + dy * dy + dz * dz < 3.4 * 3.4) {
                    segs.push(nodePos[i * 3], nodePos[i * 3 + 1], nodePos[i * 3 + 2],
                        nodePos[j * 3], nodePos[j * 3 + 1], nodePos[j * 3 + 2]);
                    if (segs.length > 600 * 6) break outer;
                }
            }
        }
        const netGeo = new THREE.BufferGeometry();
        netGeo.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
        field.add(new THREE.LineSegments(netGeo, new THREE.LineBasicMaterial({
            color: 0x00f0ff, transparent: true, opacity: 0.07, depthWrite: false, blending: ADD
        })));

        // Dynamic "link" lines: orb → nearest nodes
        const K = 5;                              // max links
        const LINK_RADIUS2 = 4.5 * 4.5;
        const linkPos = new Float32Array(K * 2 * 3);
        const linkGeo = new THREE.BufferGeometry();
        linkGeo.setAttribute('position', new THREE.BufferAttribute(linkPos, 3));
        linkGeo.setDrawRange(0, 0);
        const linkMat = new THREE.LineBasicMaterial({
            color: 0x00f0ff, transparent: true, opacity: 0.55, depthWrite: false, blending: ADD
        });
        const links = new THREE.LineSegments(linkGeo, linkMat);
        links.frustumCulled = false;
        field.add(links);

        const nearI = new Int16Array(K);
        const nearD = new Float32Array(K);

        /* ==========================================================
           3. CURSOR ORB
           ========================================================== */
        const orb = new THREE.Group();            // moves to cursor
        const orbBody = new THREE.Group();        // tilts / scales
        orb.add(orbBody);
        cur.scene.add(orb);

        const core = new THREE.Mesh(
            new THREE.IcosahedronGeometry(0.22, 1),
            new THREE.MeshBasicMaterial({ color: COL.cyan, wireframe: true })
        );
        const inner = new THREE.Mesh(
            new THREE.SphereGeometry(0.1, 16, 16),
            new THREE.MeshBasicMaterial({ color: COL.white })
        );
        const shell = new THREE.Mesh(
            new THREE.IcosahedronGeometry(0.34, 0),
            new THREE.MeshBasicMaterial({ color: COL.violet, wireframe: true, transparent: true, opacity: 0.55 })
        );
        const ring1 = new THREE.Mesh(
            new THREE.TorusGeometry(0.5, 0.006, 8, 80),
            new THREE.MeshBasicMaterial({ color: COL.cyan, transparent: true, opacity: 0.9 })
        );
        ring1.rotation.x = 1.2;
        const ring2 = new THREE.Mesh(
            new THREE.TorusGeometry(0.62, 0.005, 8, 80),
            new THREE.MeshBasicMaterial({ color: COL.violet, transparent: true, opacity: 0.7 })
        );
        ring2.rotation.x = -0.6;

        // Orbiting satellites
        const pivot = new THREE.Group();
        const satMat = new THREE.MeshBasicMaterial({ color: COL.cyan });
        for (let i = 0; i < 3; i++) {
            const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.045), satMat);
            const a = (i / 3) * Math.PI * 2;
            s.position.set(Math.cos(a) * 0.8, Math.sin(a * 2) * 0.15, Math.sin(a) * 0.8);
            pivot.add(s);
        }

        // Glow halo
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({
            map: glowTex, color: COL.cyan, transparent: true, opacity: 0.85,
            depthWrite: false, blending: ADD
        }));
        halo.scale.setScalar(2.4);

        orbBody.add(core, inner, shell, ring1, ring2, pivot, halo);

        // Motion trail (fading particles)
        const TRAIL = 60;
        const trailPos = new Float32Array(TRAIL * 3);
        const trailCol = new Float32Array(TRAIL * 3);
        const trailGeo = new THREE.BufferGeometry();
        trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
        trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 3));
        const trail = new THREE.Points(trailGeo, new THREE.PointsMaterial({
            size: 0.2, map: glowTex, vertexColors: true, transparent: true,
            depthWrite: false, blending: ADD, sizeAttenuation: true
        }));
        trail.frustumCulled = false;
        cur.scene.add(trail);

        /* ---------- Cursor → world position (plane z = 0) ---------- */
        const mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2, nx: 0, ny: 0 };
        const ndc = new THREE.Vector3();
        const dir = new THREE.Vector3();
        const target = new THREE.Vector3();

        function screenToWorld(px, py, out) {
            ndc.set((px / window.innerWidth) * 2 - 1, -(py / window.innerHeight) * 2 + 1, 0.5)
                .unproject(cur.camera);
            dir.copy(ndc).sub(cur.camera.position).normalize();
            const dist = -cur.camera.position.z / dir.z;
            return out.copy(cur.camera.position).add(dir.multiplyScalar(dist));
        }

        /* ---------- Interaction state ---------- */
        let firstMove = true;
        let lastInput = 0;
        let hovering = false;
        let pressed = false;
        let present = 1;            // 0 when pointer leaves window
        let spinBoost = 0;
        const HOVER_SEL = 'a, button, input, textarea, [data-cursor="hover"]';

        window.addEventListener('pointermove', (e) => {
            mouse.x = e.clientX;
            mouse.y = e.clientY;
            mouse.nx = (e.clientX / window.innerWidth) * 2 - 1;
            mouse.ny = (e.clientY / window.innerHeight) * 2 - 1;
            lastInput = performance.now();
            if (firstMove) {
                screenToWorld(mouse.x, mouse.y, orb.position);   // snap, don't fly in from center
                firstMove = false;
            }
        }, { passive: true });

        document.addEventListener('pointerover', (e) => {
            if (e.target.closest && e.target.closest(HOVER_SEL)) hovering = true;
        });
        document.addEventListener('pointerout', (e) => {
            const from = e.target.closest && e.target.closest(HOVER_SEL);
            const to = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(HOVER_SEL);
            if (from && !to) hovering = false;
        });

        document.documentElement.addEventListener('mouseleave', () => { present = 0; });
        document.documentElement.addEventListener('mouseenter', () => { present = 1; });

        /* ---------- Click shockwave ---------- */
        function shockwave(color) {
            const m = new THREE.Mesh(
                new THREE.RingGeometry(0.9, 1, 64),
                new THREE.MeshBasicMaterial({
                    color: color.clone(), transparent: true, opacity: 0.9,
                    side: THREE.DoubleSide, depthWrite: false, blending: ADD
                })
            );
            m.position.copy(orb.position);
            m.scale.setScalar(0.2);
            cur.scene.add(m);
            gsap.to(m.scale, { x: 2.4, y: 2.4, z: 2.4, duration: 0.7, ease: 'power2.out' });
            gsap.to(m.material, {
                opacity: 0, duration: 0.7, ease: 'power2.out',
                onComplete: () => { cur.scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
            });
        }

        window.addEventListener('pointerdown', () => {
            pressed = true; spinBoost = 14; shockwave(curColor);
        });
        window.addEventListener('pointerup', (e) => { pressed = false; if (e.pointerType === 'touch') hovering = false; });
        window.FX.pulse = () => { spinBoost = 14; shockwave(curColor); };

        /* ---------- Animation loop ---------- */
        const curColor = COL.cyan.clone();
        const goal = new THREE.Color();
        const prev = new THREE.Vector3();
        const vel = new THREE.Vector3();
        const orbLocal = new THREE.Vector3();
        let scaleCur = 1, trailStrength = 0, scrollSmooth = 0, parX = 0, parY = 0;
        const clock = new THREE.Clock();

        function tick() {
            requestAnimationFrame(tick);
            const dt = Math.min(clock.getDelta(), 0.05) || 0.016;
            const t = clock.elapsedTime;
            const k = 1 - Math.exp(-dt * 10);       // frame-rate independent smoothing

            // Touch devices: wander on a lissajous path when idle
            if (isTouch && performance.now() - lastInput > 3000) {
                mouse.x = window.innerWidth * (0.5 + 0.32 * Math.sin(t * 0.5));
                mouse.y = window.innerHeight * (0.5 + 0.28 * Math.sin(t * 0.37 + 1.0));
            }

            // Follow cursor
            screenToWorld(mouse.x, mouse.y, target);
            prev.copy(orb.position);
            orb.position.lerp(target, k);
            vel.copy(orb.position).sub(prev).divideScalar(dt);
            const speed = vel.length();

            // Colour mood: cyan idle → magenta on hover → lime on press
            goal.copy(pressed ? COL.lime : hovering ? COL.magenta : COL.cyan);
            curColor.lerp(goal, 1 - Math.exp(-dt * 8));
            core.material.color.copy(curColor);
            ring1.material.color.copy(curColor);
            satMat.color.copy(curColor);
            halo.material.color.copy(curColor);
            inner.material.color.copy(COL.white).lerp(curColor, 0.35);

            // Scale: bigger on hover, squeezed on press
            const scaleGoal = (pressed ? 0.7 : hovering ? 1.8 : 1) * present;
            scaleCur += (scaleGoal - scaleCur) * (1 - Math.exp(-dt * 12));
            orbBody.scale.setScalar(Math.max(scaleCur * state.intro, 0.0001));

            // Spin + tilt from velocity
            spinBoost *= Math.exp(-dt * 3);
            const spin = 1 + Math.min(speed * 0.08, 4) + spinBoost;
            core.rotation.x += dt * 0.9 * spin;
            core.rotation.y += dt * 1.3 * spin;
            shell.rotation.x -= dt * 0.6 * spin;
            shell.rotation.y += dt * 0.8 * spin;
            ring1.rotation.z += dt * 1.2 * spin;
            ring2.rotation.y += dt * 1.7 * spin;
            pivot.rotation.y += dt * 1.5 * spin;
            pivot.rotation.z = Math.sin(t * 0.7) * 0.4;
            orbBody.rotation.z = MathUtils.lerp(orbBody.rotation.z, MathUtils.clamp(-vel.x * 0.03, -0.6, 0.6), k);
            orbBody.rotation.x = MathUtils.lerp(orbBody.rotation.x, MathUtils.clamp(vel.y * 0.03, -0.6, 0.6), k);

            // Pulse
            inner.scale.setScalar(1 + 0.15 * Math.sin(t * 4));
            halo.scale.setScalar(2.4 * (1 + 0.08 * Math.sin(t * 3)) + Math.min(speed * 0.01, 0.6));

            // Trail
            trailPos.copyWithin(3, 0, (TRAIL - 1) * 3);
            trailPos[0] = orb.position.x; trailPos[1] = orb.position.y; trailPos[2] = orb.position.z;
            trailStrength += (MathUtils.clamp(speed * 0.12, 0, 1) - trailStrength) * (1 - Math.exp(-dt * 6));
            for (let i = 0; i < TRAIL; i++) {
                const f = Math.pow(1 - i / TRAIL, 2) * 0.8 * trailStrength * present * state.intro;
                trailCol[i * 3] = curColor.r * f;
                trailCol[i * 3 + 1] = curColor.g * f;
                trailCol[i * 3 + 2] = curColor.b * f;
            }
            trailGeo.attributes.position.needsUpdate = true;
            trailGeo.attributes.color.needsUpdate = true;

            // Background parallax (mouse + scroll)
            scrollSmooth += (window.scrollY - scrollSmooth) * (1 - Math.exp(-dt * 4));
            parX += (mouse.nx - parX) * (1 - Math.exp(-dt * 3));
            parY += (mouse.ny - parY) * (1 - Math.exp(-dt * 3));
            const drift = reduceMotion ? 0 : t * 0.02;
            field.rotation.y = drift + parX * 0.12 + scrollSmooth * 0.0003;
            field.rotation.x = parY * 0.08;
            field.position.y = scrollSmooth * 0.0012;

            // Orb → nearest-node links
            field.updateMatrixWorld(true);
            orbLocal.copy(orb.position);
            field.worldToLocal(orbLocal);
            let count = 0;
            for (let i = 0; i < NODES; i++) {
                const dx = nodePos[i * 3] - orbLocal.x;
                const dy = nodePos[i * 3 + 1] - orbLocal.y;
                const dz = nodePos[i * 3 + 2] - orbLocal.z;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 > LINK_RADIUS2) continue;
                if (count >= K && d2 >= nearD[K - 1]) continue;
                let j = count < K ? count : K - 1;
                while (j > 0 && nearD[j - 1] > d2) { nearD[j] = nearD[j - 1]; nearI[j] = nearI[j - 1]; j--; }
                nearD[j] = d2; nearI[j] = i;
                if (count < K) count++;
            }
            for (let n = 0; n < count; n++) {
                const idx = nearI[n];
                linkPos.set([orbLocal.x, orbLocal.y, orbLocal.z,
                nodePos[idx * 3], nodePos[idx * 3 + 1], nodePos[idx * 3 + 2]], n * 6);
            }
            linkGeo.setDrawRange(0, present > 0.5 ? count * 2 : 0);
            linkGeo.attributes.position.needsUpdate = true;
            linkMat.color.copy(curColor);

            bg.renderer.render(bg.scene, bg.camera);
            cur.renderer.render(cur.scene, cur.camera);
        }
        tick();

        /* ---------- Resize ---------- */
        let lastW = window.innerWidth;
        window.addEventListener('resize', () => {
            if (isTouch && window.innerWidth === lastW) return;   // URL bar show/hide
            lastW = window.innerWidth;
            [bg, cur].forEach(({ renderer, camera }) => {
                renderer.setPixelRatio(Math.min(window.devicePixelRatio, isTouch ? 1.5 : 2));
                renderer.setSize(window.innerWidth, window.innerHeight, false);
                camera.aspect = window.innerWidth / window.innerHeight;
                camera.updateProjectionMatrix();
                camera.updateMatrixWorld();
            });
        });

        // Hide native cursor (desktop only) now that the orb is alive
        if (!isTouch) document.body.classList.add('has-3d-cursor');

    } catch (err) {
        console.warn('WebGL init failed, continuing without 3D:', err);
        state.intro = 1;
    }

    /* ==========================================================
       4. LOADER + HERO INTRO (GSAP)
       ========================================================== */
    const loader = document.getElementById('loader');
    const bar = document.getElementById('loader-bar');
    const txt = document.getElementById('loader-text');

    gsap.set('.hero-tag, .hero-title > span, .hero-sub, .hero-cta > a', { opacity: 0, y: 30 });
    gsap.set('#nav', { opacity: 0, y: -20 });

    const prog = { v: 0 };
    gsap.to(prog, {
        v: 100, duration: 1.8, ease: 'power2.inOut',
        onUpdate: () => {
            bar.style.width = prog.v + '%';
            txt.textContent = Math.round(prog.v) + '%';
        },
        onComplete: reveal
    });

    function reveal() {
        const tl = gsap.timeline();
        tl.to(loader, {
            opacity: 0, duration: 0.6, ease: 'power1.out',
            onComplete: () => { loader.style.display = 'none'; }
        })
            .to(state, { intro: 1, duration: 1.2, ease: 'elastic.out(1, 0.6)' }, '-=0.3')
            .to('#nav', { opacity: 1, y: 0, duration: 0.8, ease: 'power3.out' }, '-=1')
            .to('.hero-tag', { opacity: 1, y: 0, duration: 0.7, ease: 'power3.out' }, '-=0.8')
            .to('.hero-title > span', { opacity: 1, y: 0, duration: 0.9, stagger: 0.15, ease: 'power3.out' }, '-=0.5')
            .to('.hero-sub', { opacity: 1, y: 0, duration: 0.8, ease: 'power3.out' }, '-=0.5')
            .to('.hero-cta > a', { opacity: 1, y: 0, duration: 0.7, stagger: 0.1, ease: 'power3.out' }, '-=0.5');
    }
})();

(() => {
    'use strict';
    gsap.registerPlugin(ScrollTrigger);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ---------- Mobile menu ---------- */
    const btn = document.getElementById('menu-btn');
    const menu = document.getElementById('mobile-menu');
    const setMenu = (open) => {
        btn.setAttribute('aria-expanded', String(open));
        menu.classList.toggle('hidden', !open);
    };
    btn.addEventListener('click', () => setMenu(btn.getAttribute('aria-expanded') !== 'true'));
    menu.querySelectorAll('a').forEach(a => a.addEventListener('click', () => setMenu(false)));
    window.addEventListener('resize', () => { if (window.innerWidth >= 768) setMenu(false); });

    /* ---------- Hero typing effect ---------- */
    const roles = ['IoT Engineer', 'Embedded Systems Developer', 'Hardware-to-Cloud Builder', 'Full-Stack Tinkerer'];
    const typed = document.getElementById('typed');
    if (reduce) {
        typed.textContent = roles[0];
    } else {
        let r = 0, c = 0, deleting = false;
        (function type() {
            const word = roles[r];
            typed.textContent = word.slice(0, c);
            if (!deleting && c === word.length) { deleting = true; return setTimeout(type, 1500); }
            if (deleting && c === 0) { deleting = false; r = (r + 1) % roles.length; return setTimeout(type, 400); }
            c += deleting ? -1 : 1;
            setTimeout(type, deleting ? 35 : 70);
        })();
    }

    /* ---------- Tech stack (edit this data freely) ---------- */
    const STACK = [
        { title: 'Embedded & Hardware', icon: '⚡', items: ['ESP32', 'Sensor Fusion', 'Industrial Gateways', 'C / C++'] },
        { title: 'Connectivity', icon: '📡', items: ['MQTT', 'REST APIs', 'Modbus RTU', 'Real-time Telemetry'] },
        { title: 'Backend', icon: '🗄️', items: ['C / C++', 'SQL', 'MongoDB', 'Python', 'Java'] },
        { title: 'Frontend', icon: '🖥️', items: ['React', 'JavaScript', 'Tailwind CSS', 'Three.js', 'GSAP'] },
    ];
    const stackEl = document.getElementById('stack-content');
    stackEl.innerHTML = STACK.map(g => `
      <div class="glass reveal stack-card">
        <div class="flex items-center gap-4 mb-5">
          <span class="stack-icon" aria-hidden="true">${g.icon}</span>
          <h3 class="stack-title font-display font-semibold text-white">${g.title}</h3>
        </div>
        <div class="flex flex-wrap gap-2.5">
          ${g.items.map(it => `<span class="chip">${it}</span>`).join('')}
        </div>
      </div>`).join('');


    /* ---------- Stat counters ---------- */
    document.querySelectorAll('[data-count]').forEach(el => {
        const end = +el.dataset.count, suffix = el.dataset.suffix || '';
        if (reduce) { el.textContent = end + suffix; return; }
        const o = { v: 0 };
        ScrollTrigger.create({
            trigger: el, start: 'top 92%', once: true,
            onEnter: () => gsap.to(o, {
                v: end, duration: 1.4, ease: 'power2.out',
                onUpdate: () => { el.textContent = Math.round(o.v) + suffix; }
            })
        });
    });

    window.addEventListener('load', () => ScrollTrigger.refresh());
})();

(() => {
    'use strict';
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

    /* ---------- Project data (edit freely) ---------- */
    const PROJECTS = [
        {
            title: 'Smart Energy Management System',
            short: 'SEMS',
            desc: 'An industrial IoT platform integrating a Selec energy meter via Modbus RTU to monitor equipment power usage, featuring automated Twilio WhatsApp and phone alerts to warn clients of energy anomalies and prevent hardware damage.',
            tech: [ 'Industrial Gateways', 'Modbus RTU', 'React']
        },
        {
            title: 'PoA Blockchain Wallet',
            desc: 'A secure, end-to-end decentralized wallet powered by a custom Python-based Proof-of-Authority blockchain, featuring robust cryptographic state management and an intuitive React/TypeScript frontend.',
            tech: ['Python', 'Proof-of-Authority', 'Cryptography', 'React', 'TypeScript']
        },
        {
            title: 'Accident Detection & Alerting System',
            desc: 'An ESP8266-powered vehicle safety system utilizing sensor fusion (accelerometer, gyroscope, and gas sensors) to detect collisions and instantly dispatch location alerts to the nearest hospital for rapid emergency medical response.',
            tech: ['Sensor Fusion', 'Embedded C/C++', 'Twillio : Real-time Alerts']
        },
        {
            title: 'IoT Environmental Monitoring Platform',
            desc: 'A simulated multi-sensor network streaming data over MQTT into a Spring Boot and MongoDB backend with a live React dashboard, containerized with Docker Compose and deployed via a Jenkins CI/CD pipeline.',
            tech: ['MQTT', 'Spring Boot', 'MongoDB', 'React', 'Docker Compose', 'Jenkins']
        }
    ];

    const grid = document.getElementById('projects-grid');
    grid.innerHTML = PROJECTS.map((p, i) => `
      <article class="glass reveal project-card" data-cursor="hover">
        <div class="flex items-start justify-between gap-4 mb-5">
          <span class="project-num">${String(i + 1).padStart(2, '0')}</span>
          ${p.badge ? `<span class="project-badge">★ ${p.badge}</span>` : ''}
        </div>
        <h3 class="project-title">${p.title}</h3>
        <p class="project-desc">${p.desc}</p>
        <div class="mt-6 flex flex-wrap gap-2">
          ${p.tech.map(t => `<span class="chip">${t}</span>`).join('')}
        </div>
      </article>`).join('');

    /* ---------- Spotlight + 3D tilt (desktop only) ---------- */
    grid.querySelectorAll('.project-card').forEach(card => {
        card.addEventListener('pointermove', (e) => {
            const r = card.getBoundingClientRect();
            card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
            card.style.setProperty('--my', (e.clientY - r.top) + 'px');
        });

        if (!canHover || reduce) return;
        const rx = gsap.quickTo(card, 'rotationX', { duration: 0.5, ease: 'power3.out' });
        const ry = gsap.quickTo(card, 'rotationY', { duration: 0.5, ease: 'power3.out' });
        gsap.set(card, { transformPerspective: 900 });

        card.addEventListener('pointermove', (e) => {
            const r = card.getBoundingClientRect();
            const x = (e.clientX - r.left) / r.width - 0.5;
            const y = (e.clientY - r.top) / r.height - 0.5;
            ry(x * 8);
            rx(-y * 8);
        });
        card.addEventListener('pointerleave', () => { rx(0); ry(0); });
    });


    /* ---------- Copy email ---------- */
    const copyBtn = document.getElementById('copy-email');
    copyBtn.addEventListener('click', async () => {
        const original = copyBtn.textContent;
        try {
            await navigator.clipboard.writeText(copyBtn.dataset.email);
            copyBtn.textContent = 'Copied ✓';
        } catch {
            copyBtn.textContent = 'Press Ctrl+C';
        }
        if (window.FX) window.FX.pulse();
        setTimeout(() => { copyBtn.textContent = original; }, 1800);
    });

    window.addEventListener('load', () => ScrollTrigger.refresh());
})();

(() => {
    'use strict';
    gsap.registerPlugin(ScrollTrigger);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const mobile = window.innerWidth < 768;
    const SIDE = mobile ? 0 : 70;      // sideways slide on desktop only
    const LIFT = mobile ? 50 : 0;      // use a lift on phones instead

    // Chips pop in one by one after their card appears
    function popChips(card) {
        const chips = card.querySelectorAll('.chip');
        gsap.to(chips, {
            opacity: 1, scale: 1, duration: 0.5, ease: 'back.out(2)',
            stagger: 0.06, delay: 0.35,
            clearProps: 'all'                      // restores normal hover behaviour
        });
    }

    // Hide now, reveal once when scrolled into view
    function reveal(selector, from, opts = {}) {
        const els = gsap.utils.toArray(selector);
        if (!els.length) return;
        const { stagger = 0.15, duration = 0.9, ease = 'power3.out', chips = false, start = 'top 88%' } = opts;

        gsap.set(els, { opacity: 0, ...from });
        if (chips) els.forEach(el => el.querySelectorAll('.chip').forEach(c => {
            c.style.transition = 'none';
            gsap.set(c, { opacity: 0, scale: 0.6 });
        }));

        ScrollTrigger.batch(els, {
            start, once: true,
            onEnter: (batch) => {
                gsap.to(batch, { opacity: 1, x: 0, y: 0, scale: 1, rotation: 0, duration, ease, stagger });
                if (chips) batch.forEach((el, i) => gsap.delayedCall(i * stagger, () => popChips(el)));
            }
        });
    }

    /* Section titles: slide in from the left */
    reveal('main section:not(#hero) h2', { x: -50 }, { duration: 0.8 });

    /* ABOUT: bio from the left, stat cards from the right */
    reveal('#about .grid > .glass', { x: -SIDE, y: LIFT }, { chips: true });
    reveal('#about .grid > div:not(.glass) > .glass', { x: SIDE, y: LIFT || 0 }, { stagger: 0.15 });

    /* STACK: rise + scale up, chips pop in */
    reveal('#stack-content .stack-card', { y: 60, scale: 0.94 }, { chips: true, stagger: 0.18 });

    /* PROJECTS: rise + scale up, chips pop in */
    reveal('#projects-grid .project-card', { y: 80, scale: 0.92 }, { chips: true, stagger: 0.18, duration: 1 });

    /* CONTACT: pitch from the left, socials from the right one by one */
    reveal('#contact-content > .glass', { x: -SIDE, y: LIFT });
    reveal('#contact-content > div:not(.glass) > .glass', { x: SIDE, y: LIFT || 30 }, { stagger: 0.15 });

    window.addEventListener('load', () => ScrollTrigger.refresh());
})();

(() => {
    const btn = document.getElementById('copy-discord');
    const label = document.getElementById('discord-label');
    if (!btn) return;
    const original = label.textContent;
    btn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(btn.dataset.handle);
            label.textContent = 'Copied ✓ paste it in Discord';
        } catch {
            label.textContent = 'Discord: ' + btn.dataset.handle;
        }
        if (window.FX) window.FX.pulse();
        setTimeout(() => { label.textContent = original; }, 2000);
    });
})();

(() => {
    'use strict';
    const link = document.getElementById('bot');
    if (!link) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const $ = (id) => document.getElementById(id);

    const head = $('bot-head'), body = $('bot-body');
    const pupilL = $('bot-pupil-l'), pupilR = $('bot-pupil-r');
    const eyeL = $('bot-eye-l'), eyeR = $('bot-eye-r');
    const armR = $('bot-arm-r');
    const svg = $('bot-svg');

    gsap.set(head, { svgOrigin: '32 44' });          // head pivots at the neck
    gsap.set([eyeL], { svgOrigin: '25 27' });
    gsap.set([eyeR], { svgOrigin: '39 27' });
    gsap.set(armR, { svgOrigin: '47 49' });

    /* ---------- Smooth followers ---------- */
    const d = { duration: 0.35, ease: 'power3.out' };
    const headX = gsap.quickTo(head, 'x', d), headY = gsap.quickTo(head, 'y', d), headR = gsap.quickTo(head, 'rotation', d);
    const bodyX = gsap.quickTo(body, 'x', { duration: 0.6, ease: 'power3.out' });
    const plX = gsap.quickTo(pupilL, 'x', d), plY = gsap.quickTo(pupilL, 'y', d);
    const prX = gsap.quickTo(pupilR, 'x', d), prY = gsap.quickTo(pupilR, 'y', d);

    function lookAt(nx, ny) {                         // nx, ny in range -1..1
        const ex = nx * 2.3, ey = ny * 2.3;
        plX(ex); plY(ey); prX(ex); prY(ey);
        headX(nx * 2.2); headY(ny * 1.5); headR(nx * 9);
        bodyX(nx * 1.8);
    }

    /* ---------- Follow the cursor ---------- */
    let lastMove = performance.now();
    window.addEventListener('pointermove', (e) => {
        lastMove = performance.now();
        const r = svg.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        const dist = Math.hypot(dx, dy) || 1;
        const strength = Math.min(dist / 280, 1);       // far away = full look, close = subtle
        lookAt((dx / dist) * strength, (dy / dist) * strength);
    }, { passive: true });

    document.documentElement.addEventListener('mouseleave', () => lookAt(0, 0));

    if (reduce) return;                               // no idle/blink/wave animations

    /* ---------- Idle: look around when nothing is moving (also covers phones) ---------- */
    setInterval(() => {
        if (performance.now() - lastMove > 3000) {
            lookAt(gsap.utils.random(-0.9, 0.9), gsap.utils.random(-0.5, 0.7));
        }
    }, 2200);

    /* ---------- Random blinking ---------- */
    (function blink() {
        gsap.timeline({ onComplete: () => setTimeout(blink, gsap.utils.random(2000, 5000)) })
            .to([eyeL, eyeR], { scaleY: 0.08, duration: 0.07, ease: 'power1.in' })
            .to([eyeL, eyeR], { scaleY: 1, duration: 0.12, ease: 'power1.out' });
    })();

    /* ---------- Hover: hop + wave ---------- */
    let wave;
    link.addEventListener('pointerenter', () => {
        gsap.fromTo(svg, { y: 0 }, { y: -5, duration: 0.18, yoyo: true, repeat: 1, ease: 'power2.out', overwrite: 'auto' });
        wave && wave.kill();
        wave = gsap.timeline()
            .to(armR, { rotation: -150, duration: 0.25, ease: 'power2.out' })
            .to(armR, { rotation: -120, duration: 0.18, yoyo: true, repeat: 5, ease: 'sine.inOut' });
    });
    link.addEventListener('pointerleave', () => {
        wave && wave.kill();
        gsap.to(armR, { rotation: 0, duration: 0.3, ease: 'power2.out' });
    });

    /* ---------- Click: jump + shockwave (the link itself scrolls to #hero) ---------- */
    link.addEventListener('click', () => {
        gsap.fromTo(svg, { y: 0, scale: 1 },
            { y: -10, scale: 1.12, duration: 0.2, yoyo: true, repeat: 1, ease: 'power2.out', overwrite: 'auto' });
        if (window.FX) window.FX.pulse();
    });
})();