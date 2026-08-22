/**
 * Performance Benchmark Tests
 *
 * Measures GPU throughput for:
 * - Compute shader (simulation) at 512x512
 * - Render shaders (metaball and debug)
 * - Combined sim+render pipeline
 * - Texture upload/download bandwidth
 *
 * Use ?test=perf to run only these tests.
 */

import { GPU } from '../gpu/GPU.js';
import { PingPongBuffer } from '../gpu/PingPongBuffer.js';
import { DataTexture } from '../gpu/DataTexture.js';
import { SimulationPipeline } from '../ca/SimulationPipeline.js';
import { ComputePipeline } from '../gpu/ComputePipeline.js';
import { RenderPipeline } from '../gpu/RenderPipeline.js';
import { RingBuffer } from '../gpu/RingBuffer.js';
import { loadShader } from '../shaders/load.js';
import { runTest, assert, logSection } from './framework.js';

const GRID_SIZE = 512;
const WARMUP = 10;
const COMPUTE_STEPS = 100;
const RENDER_FRAMES = 50;
const RENDER_SIZE = 512;

// Shared pipelines (compiled once)
let simPipeline, refPipeline, metaballPipeline, debugPipeline;

async function ensureShaders() {
    if (simPipeline) return;
    const [refSrc, metaballSrc, debugSrc] = await Promise.all([
        loadShader('./src/shaders/ca/v2ref/mining_game.wgsl'),
        loadShader('./src/shaders/ca/render_metaballs.wgsl'),
        loadShader('./src/shaders/ca/v2/render.wgsl')
    ]);
    simPipeline = await SimulationPipeline.create(GRID_SIZE, GRID_SIZE);
    refPipeline = new ComputePipeline(refSrc, { label: 'Perf reference sim' });
    metaballPipeline = new RenderPipeline(metaballSrc, { label: 'Perf metaball' });
    debugPipeline = new RenderPipeline(debugSrc, { label: 'Perf debug' });
}

/** Fill grid with realistic game content (~25% resources, ~2% units, ~1% walls) */
function populateGrid(data, size) {
    let seed = 42;
    const rand = () => {
        seed = (seed * 1664525 + 1013904223) & 0x7FFFFFFF;
        return seed / 0x7FFFFFFF;
    };
    const factoryPacked = (size / 2) + (size / 2) * 512;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const idx = (y * size + x) * 4;
            const r = rand();
            if (r < 0.25) {
                data[idx] = 1; data[idx + 1] = 1; // CELL_RESOURCE
            } else if (r < 0.27) {
                data[idx] = 2; data[idx + 2] = factoryPacked; data[idx + 3] = -1; // CELL_MINING_UNIT
            } else if (r < 0.28) {
                data[idx] = 4; // CELL_WALL
            }
        }
    }
}

/** Build RenderParams uniform data (32 floats = 128 bytes) */
function makeRenderUniforms(frameCount, renderWidth, renderHeight) {
    const w = renderWidth || RENDER_SIZE;
    const h = renderHeight || RENDER_SIZE;
    const d = new Float32Array(32);
    const di = new Int32Array(d.buffer);
    d[0] = GRID_SIZE; d[1] = GRID_SIZE;
    d[2] = w; d[3] = h;
    d[4] = 100.0;       // time
    d[5] = 1.0;         // metaballScale
    di[6] = frameCount;  // frameCount (i32)
    d[7] = 1.0;         // temporalBlend
    d[8] = 1.0;         // currentPlayer
    d[16] = 0.5; d[17] = 0.5; // mousePos
    d[19] = 5.0;        // deleteRadius
    d[20] = GRID_SIZE / 2; d[21] = GRID_SIZE / 2; // cameraPos
    d[22] = 2.0;        // cameraZoom
    d[23] = w / h;      // aspectRatio
    d[24] = 1.0;        // showMinimap
    return d;
}

/** Create an offscreen render target */
function createRenderTarget(gpu, width, height) {
    const texture = gpu.device.createTexture({
        size: { width, height },
        format: gpu.canvasFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        label: 'Perf render target'
    });
    return { texture, view: texture.createView() };
}

export async function runPerformanceTests() {
    logSection('Performance Benchmarks');
    await ensureShaders();
    const gpu = GPU.get();
    const workgroups = Math.ceil(GRID_SIZE / 8);

    // Shared grid data
    const gridData = new Float32Array(GRID_SIZE * GRID_SIZE * 4);
    populateGrid(gridData, GRID_SIZE);

    // ====================================================================
    // 1. Compute throughput (individual command submissions)
    // ====================================================================
    await runTest('Perf: compute sim throughput (individual dispatch)', async () => {
        const buffer = new PingPongBuffer(GRID_SIZE, GRID_SIZE, { format: 'float' });
        buffer.upload(gridData);

        // Warmup
        for (let i = 0; i < WARMUP; i++) {
            simPipeline.step(buffer.getReadTexture(), buffer.getWriteTexture(), i);
            buffer.swap();
        }
        await gpu.device.queue.onSubmittedWorkDone();

        // Benchmark
        const start = performance.now();
        for (let i = 0; i < COMPUTE_STEPS; i++) {
            simPipeline.step(buffer.getReadTexture(), buffer.getWriteTexture(), WARMUP + i);
            buffer.swap();
        }
        await gpu.device.queue.onSubmittedWorkDone();
        const elapsed = performance.now() - start;

        const tps = (COMPUTE_STEPS / elapsed) * 1000;
        console.log(`  Compute ${GRID_SIZE}x${GRID_SIZE} individual: ${tps.toFixed(1)} TPS, ${(elapsed / COMPUTE_STEPS).toFixed(2)}ms/step (${COMPUTE_STEPS} steps in ${elapsed.toFixed(0)}ms)`);

        buffer.destroy();
        assert(tps > 10, `Compute TPS too low: ${tps.toFixed(1)} (need > 10)`);
    });

    // ====================================================================
    // 1b. Reference (single-pass) shader, for comparison with the two-pass sim
    // ====================================================================
    await runTest('Perf: optimised two-pass sim is faster than the reference single-pass shader', async () => {
        const buffer = new PingPongBuffer(GRID_SIZE, GRID_SIZE, { format: 'float' });
        const uniformBuffer = gpu.createUniformBuffer(16, 'Perf ref params');
        buffer.upload(gridData);
        const refStep = (t) => {
            gpu.writeBuffer(uniformBuffer, new Float32Array([GRID_SIZE, GRID_SIZE, t, 0]));
            const bg = refPipeline.createBindGroup([
                { binding: 0, resource: buffer.getReadTexture().view },
                { binding: 1, resource: buffer.getWriteTexture().view },
                { binding: 2, resource: { buffer: uniformBuffer } }
            ]);
            refPipeline.dispatch(bg, workgroups, workgroups);
            buffer.swap();
        };
        for (let i = 0; i < WARMUP; i++) refStep(i);
        await gpu.device.queue.onSubmittedWorkDone();
        let start = performance.now();
        for (let i = 0; i < COMPUTE_STEPS; i++) refStep(WARMUP + i);
        await gpu.device.queue.onSubmittedWorkDone();
        const refMs = (performance.now() - start) / COMPUTE_STEPS;

        for (let i = 0; i < WARMUP; i++) { simPipeline.step(buffer.getReadTexture(), buffer.getWriteTexture(), i); buffer.swap(); }
        await gpu.device.queue.onSubmittedWorkDone();
        start = performance.now();
        for (let i = 0; i < COMPUTE_STEPS; i++) { simPipeline.step(buffer.getReadTexture(), buffer.getWriteTexture(), WARMUP + i); buffer.swap(); }
        await gpu.device.queue.onSubmittedWorkDone();
        const newMs = (performance.now() - start) / COMPUTE_STEPS;

        console.log(`  Reference single-pass: ${refMs.toFixed(2)}ms/step, two-pass: ${newMs.toFixed(2)}ms/step (${(refMs / newMs).toFixed(1)}x)`);
        buffer.destroy();
        uniformBuffer.destroy();
        assert(newMs < refMs, `two-pass (${newMs.toFixed(2)}ms) should beat reference (${refMs.toFixed(2)}ms)`);
    });

    // ====================================================================
    // 2. Compute throughput (batched into single command buffer)
    // ====================================================================
    await runTest('Perf: compute sim throughput (batched dispatch)', async () => {
        const buffer = new PingPongBuffer(GRID_SIZE, GRID_SIZE, { format: 'float' });
        buffer.upload(gridData);
        const BATCH = 20;   // ticks per command buffer (uniform ring size permitting)

        // Warmup
        let encoder = gpu.createCommandEncoder('Perf warmup batch');
        for (let i = 0; i < WARMUP; i++) {
            simPipeline.encodeStep(encoder, buffer.getReadTexture(), buffer.getWriteTexture(), i);
            buffer.swap();
        }
        gpu.submit([encoder.finish()]);
        await gpu.device.queue.onSubmittedWorkDone();

        // Benchmark
        const start = performance.now();
        for (let b = 0; b < COMPUTE_STEPS / BATCH; b++) {
            encoder = gpu.createCommandEncoder('Perf bench batch');
            for (let i = 0; i < BATCH; i++) {
                simPipeline.encodeStep(encoder, buffer.getReadTexture(), buffer.getWriteTexture(), WARMUP + b * BATCH + i);
                buffer.swap();
            }
            gpu.submit([encoder.finish()]);
        }
        await gpu.device.queue.onSubmittedWorkDone();
        const elapsed = performance.now() - start;

        const tps = (COMPUTE_STEPS / elapsed) * 1000;
        console.log(`  Compute ${GRID_SIZE}x${GRID_SIZE} batched:    ${tps.toFixed(1)} TPS, ${(elapsed / COMPUTE_STEPS).toFixed(2)}ms/step (${COMPUTE_STEPS} steps in ${elapsed.toFixed(0)}ms)`);

        buffer.destroy();
        assert(tps > 10, `Batched compute TPS too low: ${tps.toFixed(1)} (need > 10)`);
    });

    // ====================================================================
    // 3. Metaball render throughput
    // ====================================================================
    await runTest('Perf: render metaball throughput', async () => {
        // 8 state textures for temporal AA
        const textures = [];
        for (let i = 0; i < 8; i++) {
            const tex = new DataTexture(GRID_SIZE, GRID_SIZE, { format: 'float' });
            tex.upload(gridData);
            textures.push(tex);
        }

        const target = createRenderTarget(gpu, RENDER_SIZE, RENDER_SIZE);
        const sampler = gpu.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
        const uniformBuffer = gpu.createUniformBuffer(128, 'Perf metaball params');
        gpu.writeBuffer(uniformBuffer, makeRenderUniforms(8));

        const entries = [];
        for (let i = 0; i < 8; i++) {
            entries.push({ binding: i, resource: textures[i].view });
        }
        entries.push({ binding: 8, resource: sampler });
        entries.push({ binding: 9, resource: { buffer: uniformBuffer } });
        const bindGroup = metaballPipeline.createBindGroup(entries);

        // Warmup
        for (let i = 0; i < 5; i++) metaballPipeline.draw(bindGroup, target.view);
        await gpu.device.queue.onSubmittedWorkDone();

        // Benchmark
        const start = performance.now();
        for (let i = 0; i < RENDER_FRAMES; i++) {
            metaballPipeline.draw(bindGroup, target.view);
        }
        await gpu.device.queue.onSubmittedWorkDone();
        const elapsed = performance.now() - start;

        const fps = (RENDER_FRAMES / elapsed) * 1000;
        console.log(`  Metaball render ${RENDER_SIZE}x${RENDER_SIZE}: ${fps.toFixed(1)} FPS, ${(elapsed / RENDER_FRAMES).toFixed(2)}ms/frame (${RENDER_FRAMES} frames in ${elapsed.toFixed(0)}ms)`);

        for (const tex of textures) tex.destroy();
        target.texture.destroy();
        uniformBuffer.destroy();
        assert(fps > 5, `Metaball render FPS too low: ${fps.toFixed(1)} (need > 5)`);
    });

    // ====================================================================
    // 4. Debug render throughput
    // ====================================================================
    await runTest('Perf: render debug throughput', async () => {
        const texture = new DataTexture(GRID_SIZE, GRID_SIZE, { format: 'float' });
        texture.upload(gridData);

        const target = createRenderTarget(gpu, RENDER_SIZE, RENDER_SIZE);
        const sampler = gpu.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
        const uniformBuffer = gpu.createUniformBuffer(128, 'Perf debug params');
        gpu.writeBuffer(uniformBuffer, makeRenderUniforms(1));

        const bindGroup = debugPipeline.createBindGroup([
            { binding: 0, resource: texture.view },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: uniformBuffer } }
        ]);

        // Warmup
        for (let i = 0; i < 5; i++) debugPipeline.draw(bindGroup, target.view);
        await gpu.device.queue.onSubmittedWorkDone();

        // Benchmark
        const start = performance.now();
        for (let i = 0; i < RENDER_FRAMES; i++) {
            debugPipeline.draw(bindGroup, target.view);
        }
        await gpu.device.queue.onSubmittedWorkDone();
        const elapsed = performance.now() - start;

        const fps = (RENDER_FRAMES / elapsed) * 1000;
        console.log(`  Debug render ${RENDER_SIZE}x${RENDER_SIZE}:   ${fps.toFixed(1)} FPS, ${(elapsed / RENDER_FRAMES).toFixed(2)}ms/frame (${RENDER_FRAMES} frames in ${elapsed.toFixed(0)}ms)`);

        texture.destroy();
        target.texture.destroy();
        uniformBuffer.destroy();
        assert(fps > 10, `Debug render FPS too low: ${fps.toFixed(1)} (need > 10)`);
    });

    // ====================================================================
    // 5. Combined sim + metaball render (real game loop pattern)
    // ====================================================================
    await runTest('Perf: combined sim+render throughput', async () => {
        const ring = new RingBuffer(GRID_SIZE, GRID_SIZE, { format: 'float' }, 8);
        ring.upload(gridData, true);

        const simUniformBuffer = gpu.createUniformBuffer(16, 'Perf combined sim');
        const renderUniformBuffer = gpu.createUniformBuffer(128, 'Perf combined render');
        gpu.writeBuffer(renderUniformBuffer, makeRenderUniforms(8));

        const target = createRenderTarget(gpu, RENDER_SIZE, RENDER_SIZE);
        const sampler = gpu.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });

        const frames = RENDER_FRAMES;

        // Helper: one sim+render cycle
        function doFrame(time) {
            // Sim step
            simPipeline.step(ring.getReadTexture(), ring.getWriteTexture(), time);
            ring.swap();

            // Render step
            const renderEntries = [];
            for (let j = 0; j < 8; j++) {
                renderEntries.push({ binding: j, resource: ring.getTextureByAge(j).view });
            }
            renderEntries.push({ binding: 8, resource: sampler });
            renderEntries.push({ binding: 9, resource: { buffer: renderUniformBuffer } });
            const renderBG = metaballPipeline.createBindGroup(renderEntries);
            metaballPipeline.draw(renderBG, target.view);
        }

        // Warmup
        for (let i = 0; i < WARMUP; i++) doFrame(i);
        await gpu.device.queue.onSubmittedWorkDone();

        // Benchmark
        const start = performance.now();
        for (let i = 0; i < frames; i++) doFrame(WARMUP + i);
        await gpu.device.queue.onSubmittedWorkDone();
        const elapsed = performance.now() - start;

        const fps = (frames / elapsed) * 1000;
        console.log(`  Combined sim+metaball ${RENDER_SIZE}x${RENDER_SIZE}: ${fps.toFixed(1)} FPS, ${(elapsed / frames).toFixed(2)}ms/frame (${frames} frames in ${elapsed.toFixed(0)}ms)`);

        ring.destroy();
        target.texture.destroy();
        simUniformBuffer.destroy();
        renderUniformBuffer.destroy();
        assert(fps > 5, `Combined FPS too low: ${fps.toFixed(1)} (need > 5)`);
    });

    // ====================================================================
    // 6. Texture upload bandwidth
    // ====================================================================
    await runTest('Perf: texture upload bandwidth', async () => {
        const tex = new DataTexture(GRID_SIZE, GRID_SIZE, { format: 'float' });
        const uploads = 50;

        // Warmup
        for (let i = 0; i < 5; i++) tex.upload(gridData);
        await gpu.device.queue.onSubmittedWorkDone();

        const start = performance.now();
        for (let i = 0; i < uploads; i++) tex.upload(gridData);
        await gpu.device.queue.onSubmittedWorkDone();
        const elapsed = performance.now() - start;

        const bytesPerUpload = GRID_SIZE * GRID_SIZE * 16; // RGBA32F
        const totalMB = (bytesPerUpload * uploads) / (1024 * 1024);
        const mbps = totalMB / (elapsed / 1000);
        console.log(`  Upload ${GRID_SIZE}x${GRID_SIZE} RGBA32F: ${mbps.toFixed(0)} MB/s, ${(elapsed / uploads).toFixed(2)}ms/upload (${totalMB.toFixed(0)} MB in ${elapsed.toFixed(0)}ms)`);

        tex.destroy();
        assert(mbps > 10, `Upload bandwidth too low: ${mbps.toFixed(0)} MB/s (need > 10)`);
    });

    // ====================================================================
    // 7. Texture download latency
    // ====================================================================
    await runTest('Perf: texture download latency', async () => {
        const tex = new DataTexture(GRID_SIZE, GRID_SIZE, { format: 'float' });
        tex.upload(gridData);
        await gpu.device.queue.onSubmittedWorkDone();

        const downloads = 10;

        // Warmup
        await tex.download();

        const start = performance.now();
        for (let i = 0; i < downloads; i++) await tex.download();
        const elapsed = performance.now() - start;

        const bytesPerDownload = GRID_SIZE * GRID_SIZE * 16;
        const totalMB = (bytesPerDownload * downloads) / (1024 * 1024);
        const mbps = totalMB / (elapsed / 1000);
        const msPerDownload = elapsed / downloads;
        console.log(`  Download ${GRID_SIZE}x${GRID_SIZE} RGBA32F: ${mbps.toFixed(0)} MB/s, ${msPerDownload.toFixed(1)}ms/download (${totalMB.toFixed(0)} MB in ${elapsed.toFixed(0)}ms)`);

        tex.destroy();
        assert(msPerDownload < 1000, `Download too slow: ${msPerDownload.toFixed(0)}ms (need < 1000ms)`);
    });

    // ====================================================================
    // 8. Metaball render at 1920x1080 (laptop resolution)
    // ====================================================================
    await runTest('Perf: metaball render 1920x1080', async () => {
        const W = 1920, H = 1080;
        const textures = [];
        for (let i = 0; i < 8; i++) {
            const tex = new DataTexture(GRID_SIZE, GRID_SIZE, { format: 'float' });
            tex.upload(gridData);
            textures.push(tex);
        }

        const target = createRenderTarget(gpu, W, H);
        const sampler = gpu.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
        const uniformBuffer = gpu.createUniformBuffer(128, 'Perf metaball 1080p params');
        gpu.writeBuffer(uniformBuffer, makeRenderUniforms(8, W, H));

        const entries = [];
        for (let i = 0; i < 8; i++) {
            entries.push({ binding: i, resource: textures[i].view });
        }
        entries.push({ binding: 8, resource: sampler });
        entries.push({ binding: 9, resource: { buffer: uniformBuffer } });
        const bindGroup = metaballPipeline.createBindGroup(entries);

        // Warmup
        for (let i = 0; i < 5; i++) metaballPipeline.draw(bindGroup, target.view);
        await gpu.device.queue.onSubmittedWorkDone();

        // Benchmark
        const start = performance.now();
        for (let i = 0; i < RENDER_FRAMES; i++) {
            metaballPipeline.draw(bindGroup, target.view);
        }
        await gpu.device.queue.onSubmittedWorkDone();
        const elapsed = performance.now() - start;

        const fps = (RENDER_FRAMES / elapsed) * 1000;
        console.log(`  Metaball render ${W}x${H}: ${fps.toFixed(1)} FPS, ${(elapsed / RENDER_FRAMES).toFixed(2)}ms/frame (${RENDER_FRAMES} frames in ${elapsed.toFixed(0)}ms)`);

        for (const tex of textures) tex.destroy();
        target.texture.destroy();
        uniformBuffer.destroy();
        assert(fps > 30, `Metaball 1080p FPS too low: ${fps.toFixed(1)} (need > 30)`);
    });

    // ====================================================================
    // 9. Metaball render at 2560x1600 (retina resolution)
    // ====================================================================
    await runTest('Perf: metaball render 2560x1600', async () => {
        const W = 2560, H = 1600;
        const textures = [];
        for (let i = 0; i < 8; i++) {
            const tex = new DataTexture(GRID_SIZE, GRID_SIZE, { format: 'float' });
            tex.upload(gridData);
            textures.push(tex);
        }

        const target = createRenderTarget(gpu, W, H);
        const sampler = gpu.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
        const uniformBuffer = gpu.createUniformBuffer(128, 'Perf metaball retina params');
        gpu.writeBuffer(uniformBuffer, makeRenderUniforms(8, W, H));

        const entries = [];
        for (let i = 0; i < 8; i++) {
            entries.push({ binding: i, resource: textures[i].view });
        }
        entries.push({ binding: 8, resource: sampler });
        entries.push({ binding: 9, resource: { buffer: uniformBuffer } });
        const bindGroup = metaballPipeline.createBindGroup(entries);

        // Warmup
        for (let i = 0; i < 5; i++) metaballPipeline.draw(bindGroup, target.view);
        await gpu.device.queue.onSubmittedWorkDone();

        // Benchmark
        const start = performance.now();
        for (let i = 0; i < RENDER_FRAMES; i++) {
            metaballPipeline.draw(bindGroup, target.view);
        }
        await gpu.device.queue.onSubmittedWorkDone();
        const elapsed = performance.now() - start;

        const fps = (RENDER_FRAMES / elapsed) * 1000;
        console.log(`  Metaball render ${W}x${H}: ${fps.toFixed(1)} FPS, ${(elapsed / RENDER_FRAMES).toFixed(2)}ms/frame (${RENDER_FRAMES} frames in ${elapsed.toFixed(0)}ms)`);

        for (const tex of textures) tex.destroy();
        target.texture.destroy();
        uniformBuffer.destroy();
        assert(fps > 20, `Metaball retina FPS too low: ${fps.toFixed(1)} (need > 20)`);
    });

    // Cleanup shared pipelines
    simPipeline.destroy();
    metaballPipeline.destroy();
    debugPipeline.destroy();
    simPipeline = metaballPipeline = debugPipeline = null;
}
