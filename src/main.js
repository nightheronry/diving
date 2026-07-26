import './style.css';
import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';

import { SpectralOceanSystem } from './ocean/ocean-system.js';
import { validateFragmentIFFT } from './ocean/fft-pipeline.js';
import {
  createStylizedOceanSkyMaterial,
  createStylizedOceanSurfaceMaterial,
  createStylizedSeaFloorMaterial,
  createStylizedUnderwaterCompositeMaterial,
  stylizedAboveBelowOceanAssetPaths,
  updateStylizedOceanMaterials,
} from './ocean/stylized-ocean-material.js';

import { compileCoralReef, createSeaweed, animateSeaweed } from './coral-system.js';
import { compileShark, SharkAnimator, SharkAI } from './shark-system.js';
import {
    createReefField,
    createReefTerrain,
    createSuspendedParticles,
    updateSuspendedParticles,
} from './reef-environment.js';

async function init() {
    const container = document.getElementById('canvas-container');

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    const maxPixelRatio = Math.min(window.devicePixelRatio, 1.75);
    renderer.setPixelRatio(maxPixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setClearColor(0x064289);
    container.appendChild(renderer.domElement);

    const fftValidation = validateFragmentIFFT(renderer);
    if (!fftValidation.pass) {
        console.error(`IFFT validation failed: impulse=${fftValidation.impulseError}, frequency=${fftValidation.frequencyError}`);
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.1, 10000);
    camera.position.set(0, -18, 76);

    const sunDirection = new THREE.Vector3(-0.14, 0.13, -0.98).normalize();
    const sceneTarget = new THREE.WebGLRenderTarget(window.innerWidth * maxPixelRatio, window.innerHeight * maxPixelRatio, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
    });
    sceneTarget.depthTexture = new THREE.DepthTexture(window.innerWidth * maxPixelRatio, window.innerHeight * maxPixelRatio);
    sceneTarget.depthTexture.type = THREE.UnsignedIntType;

    // ── Spectral Ocean FFT ──
    const options = {
        resolution: 256,
        patchLengths: [250, 64, 18],
        boundaryFactor: 6,
        gravity: 9.81,
        depth: 500,
        choppiness: 1.5,
        foamRecovery: 0.5,
        amplitude: 0.74,
        seed: 78243,
        local: {
            scale: 1,
            windSpeed: 15,
            directionDegrees: 63.435,
            fetchMeters: 90000,
            directionality: 1,
            swell: 0.24,
            peakEnhancement: 3.3,
            shortWaveFade: 0.018,
        },
        swell: {
            scale: 0.62,
            windSpeed: 4,
            directionDegrees: 63.435,
            fetchMeters: 280000,
            directionality: 1,
            swell: 1,
            peakEnhancement: 3.3,
            shortWaveFade: 0.012,
        },
    };
    const ocean = new SpectralOceanSystem(renderer, options);

    const textureLoader = new THREE.TextureLoader();
    async function loadEffectTexture(url, colorSpace = THREE.SRGBColorSpace) {
        const texture = await textureLoader.loadAsync(url);
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.colorSpace = colorSpace;
        texture.anisotropy = 8;
        return texture;
    }

    const [foamTexture, sandTexture] = await Promise.all([
        loadEffectTexture(stylizedAboveBelowOceanAssetPaths.foam, THREE.NoColorSpace),
        loadEffectTexture(stylizedAboveBelowOceanAssetPaths.sand),
    ]);

    // ── Sky ──
    const skyMaterial = createStylizedOceanSkyMaterial({ sunDirection });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 48, 24), skyMaterial);
    scene.add(sky);

    // ── Seafloor with caustics ──
    const seafloorMaterial = createStylizedSeaFloorMaterial({
        sandTexture,
        causticIntensity: 0.9,
    });
    const seafloor = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000, 1, 1), seafloorMaterial);
    seafloor.rotation.x = -Math.PI / 2;
    seafloor.position.y = -50;
    scene.add(seafloor);

    // ── Spectral Ocean Surface ──
    const oceanMaterial = createStylizedOceanSurfaceMaterial(ocean.cascades, {
        patchLengths: options.patchLengths,
        sunDirection,
        foamTexture,
    });
    const waterGeometry = new THREE.PlaneGeometry(2000, 2000, 256, 256);
    waterGeometry.rotateX(-Math.PI / 2);
    const water = new THREE.Mesh(waterGeometry, oceanMaterial);
    water.frustumCulled = false;
    scene.add(water);

    // ── Underwater Lighting ──
    const ambientLight = new THREE.HemisphereLight(0x9bd6e7, 0x102b31, 1.35);
    scene.add(ambientLight);

    // Directional caustic light from above
    const causticLight = new THREE.DirectionalLight(0xc7ecff, 3.2);
    causticLight.position.set(5, 50, 10);
    scene.add(causticLight);

    const reefField = createReefField({ seed: 42, radius: 80 });
    const reefTerrain = createReefTerrain({ field: reefField, seafloorY: -50 });
    scene.add(reefTerrain);

    // ── AAA Coral Reef (procedural growth hierarchy) ──
    console.time('[coral-reef] compile');
    const coralReef = compileCoralReef({
        seed: 42,
        clusterCount: 8,
        coralsPerCluster: 12,
        reefRadius: 80,
        seafloorY: -50,
        field: reefField,
    });
    scene.add(coralReef);
    console.timeEnd('[coral-reef] compile');

    // ── Seaweed ──
    const seaweed = createSeaweed({
        seed: 99,
        count: 30,
        reefRadius: 80,
        seafloorY: -50,
        field: reefField,
    });
    scene.add(seaweed);

    const suspendedParticles = createSuspendedParticles({
        seed: 622,
        count: 900,
        reefRadius: 100,
        seafloorY: -50,
    });
    scene.add(suspendedParticles);

    // ── AAA Procedural Shark ──
    console.time('[shark] compile');
    const sharkMesh = compileShark();
    sharkMesh.position.set(0, -25, 52);
    scene.add(sharkMesh);
    console.timeEnd('[shark] compile');

    const sharkAnimator = new SharkAnimator(sharkMesh);
    const sharkAI = new SharkAI(camera);

    // ── Underwater Composite (post-processing) ──
    const compositeMaterial = createStylizedUnderwaterCompositeMaterial({
        sceneColor: sceneTarget.texture,
        sceneDepth: sceneTarget.depthTexture,
        displacement: ocean.cascades[0].displacement,
        patchLength: options.patchLengths[0],
        scale: 1,
        waterClarity: 57,
    });
    const compositeScene = new THREE.Scene();
    const compositeCamera = new THREE.Camera();
    const composite = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), compositeMaterial);
    compositeScene.add(composite);

    // ── Controls ──
    const controls = new PointerLockControls(camera, document.body);
    const instructions = document.querySelector('.instructions');
    document.addEventListener('click', () => controls.lock());
    controls.addEventListener('lock', () => instructions.style.display = 'none');
    controls.addEventListener('unlock', () => instructions.style.display = 'block');

    const moveState = { forward: false, backward: false, left: false, right: false, up: false, down: false };
    const velocity = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const drag = 3.0;
    const speed = 25.0;

    document.addEventListener('keydown', (e) => {
        switch(e.code) {
            case 'KeyW': moveState.forward = true; break;
            case 'KeyA': moveState.left = true; break;
            case 'KeyS': moveState.backward = true; break;
            case 'KeyD': moveState.right = true; break;
            case 'Space': moveState.up = true; break;
            case 'ShiftLeft': moveState.down = true; break;
        }
    });
    document.addEventListener('keyup', (e) => {
        switch(e.code) {
            case 'KeyW': moveState.forward = false; break;
            case 'KeyA': moveState.left = false; break;
            case 'KeyS': moveState.backward = false; break;
            case 'KeyD': moveState.right = false; break;
            case 'Space': moveState.up = false; break;
            case 'ShiftLeft': moveState.down = false; break;
        }
    });

    // ── Animation Loop ──
    let lastTime = performance.now();

    function animate() {
        requestAnimationFrame(animate);

        const timeNow = performance.now();
        const delta = Math.min((timeNow - lastTime) / 1000, 0.1);
        lastTime = timeNow;
        const elapsed = timeNow / 1000;

        // Camera movement with water drag
        if (controls.isLocked) {
            velocity.x -= velocity.x * drag * delta;
            velocity.y -= velocity.y * drag * delta;
            velocity.z -= velocity.z * drag * delta;

            direction.z = Number(moveState.forward) - Number(moveState.backward);
            direction.x = Number(moveState.right) - Number(moveState.left);
            direction.normalize();

            if (moveState.forward || moveState.backward) velocity.z -= direction.z * speed * delta;
            if (moveState.left || moveState.right) velocity.x -= direction.x * speed * delta;
            if (moveState.up) velocity.y += speed * 0.5 * delta;
            if (moveState.down) velocity.y -= speed * 0.5 * delta;

            controls.moveRight(-velocity.x * delta);
            controls.moveForward(-velocity.z * delta);
            camera.position.y += velocity.y * delta;
        }

        // Snap environment to camera (infinite ocean)
        const snappedX = Math.round(camera.position.x / 16) * 16;
        const snappedZ = Math.round(camera.position.z / 16) * 16;
        water.position.x = snappedX;
        water.position.z = snappedZ;
        seafloor.position.x = camera.position.x;
        seafloor.position.z = camera.position.z;
        sky.position.x = camera.position.x;
        sky.position.z = camera.position.z;

        // Bounds
        if (camera.position.y < -49) camera.position.y = -49;
        if (camera.position.y > 200) camera.position.y = 200;

        // Shark AI + Animation
        const sharkWaypoint = sharkAI.update(elapsed);
        sharkAnimator.setTarget(sharkWaypoint);
        sharkAnimator.update(elapsed, delta);

        // Seaweed sway
        animateSeaweed(seaweed, elapsed);
        updateSuspendedParticles(suspendedParticles, elapsed);

        // Ocean FFT Update
        ocean.update(elapsed, Math.max(delta, 1 / 120));
        updateStylizedOceanMaterials({
            oceanMaterial,
            seafloorMaterial,
            compositeMaterial,
            cascades: ocean.cascades,
            elapsed,
            camera,
            debugMode: "final",
        });

        // Render pass 1: scene → render target (color + depth)
        renderer.setRenderTarget(sceneTarget);
        renderer.clear();
        renderer.render(scene, camera);

        // Render pass 2: composite → screen (underwater fog/absorption)
        renderer.setRenderTarget(null);
        renderer.render(compositeScene, compositeCamera);
    }

    animate();

    window.addEventListener('resize', () => {
        const w = window.innerWidth;
        const h = window.innerHeight;
        const pixelRatio = Math.min(window.devicePixelRatio, 1.75);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        sceneTarget.setSize(w * pixelRatio, h * pixelRatio);
    });
}

init();
