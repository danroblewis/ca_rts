/**
 * Simulation Equivalence Tests
 *
 * The optimised two-pass simulation (sim_prepass.wgsl + mining_game.wgsl)
 * must produce results bit-identical to the original single-pass shader
 * (frozen under shaders/ca/v2ref). These tests run both from the same state
 * for hundreds of ticks on populated maps and compare every tick.
 */

import { GPU } from '../gpu/GPU.js';
import { ComputePipeline } from '../gpu/ComputePipeline.js';
import { PingPongBuffer } from '../gpu/PingPongBuffer.js';
import { SimulationPipeline } from '../ca/SimulationPipeline.js';
import { ActionApplier } from '../game/ActionApplier.js';
import { MapGenerator } from '../game/MapGenerator.js';
import { loadShader } from '../shaders/load.js';
import { createSeededRandom } from '../utils/GameUtils.js';
import { runTest, assert, logSection } from './framework.js';

class RefSim {
    constructor(pipeline, width, height, missilesEnabled = false) {
        this.pipeline = pipeline;
        this.width = width; this.height = height;
        this.flags = missilesEnabled ? 1 : 0;
        this.uniform = GPU.get().createUniformBuffer(16);
    }
    step(readTex, writeTex, time) {
        const gpu = GPU.get();
        gpu.writeBuffer(this.uniform, new Float32Array([this.width, this.height, time, this.flags]));
        const bg = this.pipeline.createBindGroup([
            { binding: 0, resource: readTex.view },
            { binding: 1, resource: writeTex.view },
            { binding: 2, resource: { buffer: this.uniform } }
        ]);
        this.pipeline.dispatch(bg, Math.ceil(this.width / 8), Math.ceil(this.height / 8));
    }
}

function populate(data, N, seed, factories) {
    const gen = new MapGenerator(N, { numBlobs: Math.round(600 * (N * N) / (512 * 512)) + 5, numWallLines: Math.round(176 * N / 512) + 2, numWallBlobs: 3 });
    gen.generate(data, seed);
    const applier = new ActionApplier({ gridSize: N, deleteRadius: 5, firstFactoryResources: 50 });
    const rnd = createSeededRandom(seed * 7 + 1);
    let placed = 0, tries = 0;
    while (placed < factories && tries < 5000) {
        tries++;
        const x = 4 + Math.floor(rnd() * (N - 8)), y = 4 + Math.floor(rnd() * (N - 8));
        let ok = true, res = 0;
        for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2 && ok; dx++) if (Math.round(data[((y + dy) * N + x + dx) * 4]) !== 0) ok = false;
        if (!ok) continue;
        for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
            if (Math.round(data[(yy * N + xx) * 4]) === 1) res++;
        }
        if (res < 10) continue;
        applier.applyPlaceFactory(data, { type: 'place_factory', x, y, isUnbuilt: placed % 3 === 2 }, placed % 2 === 0 ? 1 : 2);
        placed++;
    }
    return placed;
}

function firstDiff(a, b, N) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) {
            const cell = Math.floor(i / 4);
            return { x: cell % N, y: Math.floor(cell / N), ref: Array.from(a.slice(cell * 4, cell * 4 + 4)), neu: Array.from(b.slice(cell * 4, cell * 4 + 4)) };
        }
    }
    return null;
}

export async function runSimEquivalenceTests() {
    logSection('Simulation Equivalence - reference single-pass vs optimised two-pass');

    const refSource = await loadShader('./src/shaders/ca/v2ref/mining_game.wgsl');
    const refPipeline = new ComputePipeline(refSource, { label: 'Reference simulation' });

    async function compareRun(name, { N, seed, factories, ticks, compareEvery = 1, actionsEvery = 0, missilesEnabled = false }) {
        await runTest(name, async () => {
            const data = new Float32Array(N * N * 4);
            const placed = populate(data, N, seed, factories);
            assert(placed > 0, 'placed factories');

            const ref = new RefSim(refPipeline, N, N, missilesEnabled);
            const sim = await SimulationPipeline.create(N, N, { missilesEnabled });
            const refBuf = new PingPongBuffer(N, N, { format: 'float' });
            const newBuf = new PingPongBuffer(N, N, { format: 'float' });
            refBuf.upload(data); newBuf.upload(data);
            const applier = new ActionApplier({ gridSize: N, deleteRadius: 5, firstFactoryResources: 50 });
            const rnd = createSeededRandom(seed + 1000);

            let units = 0;
            for (let t = 0; t < ticks; t++) {
                if (actionsEvery && t > 0 && t % actionsEvery === 0) {
                    // Inject an identical CPU-side action into both (demolish / selection / command)
                    const [a, b] = await Promise.all([refBuf.download(), newBuf.download()]);
                    const kind = rnd();
                    const player = rnd() < 0.5 ? 1 : 2;
                    let action;
                    if (kind < 0.4) action = { type: 'unit_selection', region: { x1: 0, y1: 0, x2: N - 1, y2: N - 1 } };
                    else if (kind < 0.8) action = { type: 'unit_command', destX: Math.floor(rnd() * N), destY: Math.floor(rnd() * N) };
                    else action = { type: 'clear_selection' };
                    applier.applyAction(a, action, player); applier.applyAction(b, action, player);
                    refBuf.upload(a); newBuf.upload(b);
                }
                ref.step(refBuf.getReadTexture(), refBuf.getWriteTexture(), t); refBuf.swap();
                sim.step(newBuf.getReadTexture(), newBuf.getWriteTexture(), t); newBuf.swap();
                if ((t + 1) % compareEvery === 0 || t === ticks - 1) {
                    const [a, b] = await Promise.all([refBuf.download(), newBuf.download()]);
                    const d = firstDiff(a, b, N);
                    assert(d === null, `tick ${t}: mismatch at (${d?.x},${d?.y}) ref=${d?.ref} new=${d?.neu}`);
                    if (t === ticks - 1) for (let i = 0; i < a.length; i += 4) { const ty = Math.round(a[i]); if (ty === 2 || ty === 5) units++; }
                }
            }
            console.log(`    ${name}: ${ticks} ticks, ${units} units at the end`);
            refBuf.destroy(); newBuf.destroy(); sim.destroy();
        });
    }

    await compareRun('SimEquiv: 128x128, 6 factories, 300 ticks (every tick compared)', { N: 128, seed: 11, factories: 6, ticks: 300 });
    await compareRun('SimEquiv: 64x64 (non-multiple block edges), 3 factories, 300 ticks', { N: 72, seed: 5, factories: 3, ticks: 300 });
    await compareRun('SimEquiv: 256x256, 12 factories, 600 ticks, compared every 3 ticks', { N: 256, seed: 23, factories: 12, ticks: 600, compareEvery: 3 });
    await compareRun('SimEquiv: 128x128 with selection/command actions injected, 400 ticks', { N: 128, seed: 42, factories: 8, ticks: 400, actionsEvery: 37 });
    await compareRun('SimEquiv: 512x512 full map, 16 factories, 300 ticks, compared every 10 ticks', { N: 512, seed: 12345, factories: 16, ticks: 300, compareEvery: 10 });
    await compareRun('SimEquiv: 128x128 with the missile feature enabled, 600 ticks', { N: 128, seed: 155433, factories: 8, ticks: 600, compareEvery: 2, missilesEnabled: true });
}
