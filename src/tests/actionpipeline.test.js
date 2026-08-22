/**
 * ActionPipeline Tests - the GPU action pass must match the CPU ActionApplier
 * bit-for-bit for every action type, on realistic states.
 */

import { GPU } from '../gpu/GPU.js';
import { PingPongBuffer } from '../gpu/PingPongBuffer.js';
import { ActionPipeline } from '../game/ActionPipeline.js';
import { ActionApplier } from '../game/ActionApplier.js';
import { MapGenerator } from '../game/MapGenerator.js';
import { createSeededRandom, packCoords, CELL_MINING_UNIT, CELL_MINING_UNIT_P2, CELL_MISSILE, CELL_MISSILE_P2, SELECTED_PACK_BASE, AGE_PACK_BASE, MISSILE_SELECTED_PACK_BASE } from '../utils/GameUtils.js';
import { runTest, assert, logSection } from './framework.js';

const N = 128;
const DELETE_RADIUS = 5;
const FIRST_FACTORY_RESOURCES = 50;

function makeState(seed) {
    const data = new Float32Array(N * N * 4);
    const gen = new MapGenerator(N, { numBlobs: 30, numWallLines: 10, numWallBlobs: 2 });
    gen.generate(data, seed);
    const rnd = createSeededRandom(seed);
    // sprinkle units (selected / unselected / holding / aged) and missiles
    for (let i = 0; i < 300; i++) {
        const x = Math.floor(rnd() * N), y = Math.floor(rnd() * N);
        const idx = (y * N + x) * 4;
        if (Math.round(data[idx]) !== 0) continue;
        const p2 = rnd() < 0.5;
        const holding = rnd() < 0.5 ? 1 : 0;
        const counter = Math.floor(rnd() * 16);
        const selected = rnd() < 0.5 ? SELECTED_PACK_BASE : 0;
        const age = Math.floor(rnd() * 400) - 30;
        data[idx] = p2 ? CELL_MINING_UNIT_P2 : CELL_MINING_UNIT;
        data[idx + 1] = holding + counter * 2 + selected + age * AGE_PACK_BASE;
        data[idx + 2] = packCoords(Math.floor(rnd() * N), Math.floor(rnd() * N));
        data[idx + 3] = rnd() < 0.5 ? -(Math.floor(rnd() * 100) + 1) : packCoords(5, 5) + Math.floor(rnd() * 200) * 262144;
    }
    for (let i = 0; i < 40; i++) {
        const x = Math.floor(rnd() * N), y = Math.floor(rnd() * N);
        const idx = (y * N + x) * 4;
        if (Math.round(data[idx]) !== 0) continue;
        const state = Math.floor(rnd() * 4);
        const selected = rnd() < 0.5 ? MISSILE_SELECTED_PACK_BASE : 0;
        data[idx] = rnd() < 0.5 ? CELL_MISSILE_P2 : CELL_MISSILE;
        data[idx + 1] = Math.floor(rnd() * 9) + state * 16 + selected;
        data[idx + 2] = -1;
        data[idx + 3] = packCoords(x, y);
    }
    return data;
}

function firstDiff(a, b) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            const cell = Math.floor(i / 4);
            return { i, x: cell % N, y: Math.floor(cell / N), cpu: Array.from(a.slice(cell * 4, cell * 4 + 4)), gpu: Array.from(b.slice(cell * 4, cell * 4 + 4)) };
        }
    }
    return null;
}

export async function runActionPipelineTests() {
    logSection('ActionPipeline - GPU action pass vs CPU ActionApplier');

    const pipeline = await ActionPipeline.create(N, N, { deleteRadius: DELETE_RADIUS, firstFactoryResources: FIRST_FACTORY_RESOURCES });
    const applier = new ActionApplier({ gridSize: N, deleteRadius: DELETE_RADIUS, firstFactoryResources: FIRST_FACTORY_RESOURCES });
    const buffer = new PingPongBuffer(N, N, { format: 'float' });

    async function check(name, seed, actions) {
        await runTest(name, async () => {
            const base = makeState(seed);
            // CPU
            const cpu = new Float32Array(base);
            for (const { action, playerId } of actions) applier.applyAction(cpu, action, playerId);
            // GPU
            buffer.upload(base);
            pipeline.apply(buffer.getReadTexture(), buffer.getWriteTexture(), actions);
            buffer.swap();
            const gpu = await buffer.download();
            const d = firstDiff(cpu, gpu);
            assert(d === null, `GPU differs from CPU at (${d?.x},${d?.y}): cpu=${d?.cpu} gpu=${d?.gpu}`);
            // sanity: the action changed something
            let changed = false;
            for (let i = 0; i < base.length; i++) if (base[i] !== cpu[i]) { changed = true; break; }
            assert(changed, 'action should modify the grid');
        });
    }

    await check('Action: place_factory (first, with resources) matches CPU', 1,
        [{ action: { type: 'place_factory', x: 40, y: 40, isUnbuilt: false }, playerId: 1 }]);
    await check('Action: place_factory (unbuilt) for P2 matches CPU', 2,
        [{ action: { type: 'place_factory', x: 70, y: 33, isUnbuilt: true }, playerId: 2 }]);
    await check('Action: place_factory at the grid edge matches CPU', 3,
        [{ action: { type: 'place_factory', x: 1, y: N - 2, isUnbuilt: false }, playerId: 1 }]);
    await check('Action: demolish own factory (built + unbuilt cells) matches CPU', 4, [
        { action: { type: 'place_factory', x: 60, y: 60, isUnbuilt: false }, playerId: 1 },
        { action: { type: 'place_factory', x: 64, y: 60, isUnbuilt: true }, playerId: 1 },
        { action: { type: 'demolish', x: 62, y: 61 }, playerId: 1 }
    ]);
    await check('Action: demolish ignores the other player\'s factory', 5, [
        { action: { type: 'place_factory', x: 60, y: 60, isUnbuilt: false }, playerId: 2 },
        { action: { type: 'place_factory', x: 66, y: 60, isUnbuilt: false }, playerId: 1 },
        { action: { type: 'demolish', x: 63, y: 60 }, playerId: 1 }
    ]);
    await check('Action: unit_selection region selects P1 units and armed missiles', 6,
        [{ action: { type: 'unit_selection', region: { x1: 10, y1: 10, x2: 90, y2: 90 } }, playerId: 1 }]);
    await check('Action: unit_selection for P2 matches CPU', 7,
        [{ action: { type: 'unit_selection', region: { x1: 0, y1: 0, x2: N - 1, y2: N - 1 } }, playerId: 2 }]);
    await check('Action: clear_selection matches CPU', 8,
        [{ action: { type: 'clear_selection' }, playerId: 1 }, { action: { type: 'clear_selection' }, playerId: 2 }]);
    await check('Action: unit_command retargets selected units and launches armed missiles', 9,
        [{ action: { type: 'unit_command', destX: 100, destY: 20 }, playerId: 1 },
         { action: { type: 'unit_command', destX: 3, destY: 120 }, playerId: 2 }]);
    await check('Action: select then command then clear in one tick (ordering) matches CPU', 10, [
        { action: { type: 'unit_selection', region: { x1: 0, y1: 0, x2: 60, y2: 60 } }, playerId: 1 },
        { action: { type: 'unit_command', destX: 77, destY: 77 }, playerId: 1 },
        { action: { type: 'clear_selection' }, playerId: 1 },
        { action: { type: 'place_factory', x: 20, y: 100, isUnbuilt: true }, playerId: 2 }
    ]);
    await check('Action: many mixed actions from both players in one tick match CPU', 11, (() => {
        const rnd = createSeededRandom(99);
        const acts = [];
        for (let i = 0; i < 30; i++) {
            const playerId = rnd() < 0.5 ? 1 : 2;
            const r = rnd();
            if (r < 0.3) acts.push({ action: { type: 'place_factory', x: 2 + Math.floor(rnd() * (N - 4)), y: 2 + Math.floor(rnd() * (N - 4)), isUnbuilt: rnd() < 0.5 }, playerId });
            else if (r < 0.5) acts.push({ action: { type: 'demolish', x: Math.floor(rnd() * N), y: Math.floor(rnd() * N) }, playerId });
            else if (r < 0.7) acts.push({ action: { type: 'unit_selection', region: { x1: Math.floor(rnd() * 64), y1: Math.floor(rnd() * 64), x2: 64 + Math.floor(rnd() * 63), y2: 64 + Math.floor(rnd() * 63) } }, playerId });
            else if (r < 0.9) acts.push({ action: { type: 'unit_command', destX: Math.floor(rnd() * N), destY: Math.floor(rnd() * N) }, playerId });
            else acts.push({ action: { type: 'clear_selection' }, playerId });
        }
        return acts;
    })());

    await runTest('Action: empty action list is a no-op (returns 0, nothing encoded)', async () => {
        const gpu = GPU.get();
        const enc = gpu.createCommandEncoder();
        const n = pipeline.encodeApply(enc, buffer.getReadTexture(), buffer.getWriteTexture(), []);
        gpu.submit([enc.finish()]);
        assert(n === 0, 'nothing applied');
    });

    buffer.destroy();
}
