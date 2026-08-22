/**
 * Multiplayer Synchronization Integration Tests
 *
 * Two headless game clients running the REAL GPU simulation (SimulationPipeline
 * + ActionPipeline) and the REAL LockstepSync, connected by a simulated
 * network with latency, jitter, reordering and loss (+ re-send recovery).
 *
 * The invariant under test: at every shared tick both clients hold
 * bit-identical grids, whatever the network does.
 */

import { GPU } from '../gpu/GPU.js';
import { CAGrid } from '../ca/CAGrid.js';
import { SimulationPipeline } from '../ca/SimulationPipeline.js';
import { ActionPipeline } from '../game/ActionPipeline.js';
import { LockstepSync } from '../network/LockstepSync.js';
import { MapGenerator } from '../game/MapGenerator.js';
import { runTest, assert, logSection } from './framework.js';

const GRID_SIZE = 64;
const MAP_SEED = 12345;

// ============================================================================
// HeadlessGameClient — real GPU sim + real lockstep, no DOM
// ============================================================================

class HeadlessGameClient {
    constructor(playerId, gridSize, simPipeline, actionPipeline, inputDelay) {
        this.playerId = playerId;
        this.gridSize = gridSize;
        this.sim = simPipeline;
        this.actions = actionPipeline;
        this.grid = new CAGrid(gridSize, gridSize);
        this.simTime = 0;
        this.lockstep = new LockstepSync({ inputDelay });
        this.lockstep.start(0, playerId);
        this.applied = [];          // { tick, playerId, type }
        this.sentFrames = 0;
        this.stalls = 0;
        this.network = null;
    }

    loadMap(seed) {
        const mapGen = new MapGenerator(this.gridSize, {
            numBlobs: 30, blobMinRadius: 1, blobMaxRadius: 3, blobDensity: 0.6,
            numWallLines: 10, wallMinLength: 2, wallMaxLength: 6, numWallBlobs: 3, wallBlobRadius: 2
        });
        const data = new Float32Array(this.gridSize * this.gridSize * 4);
        mapGen.generate(data, seed);
        this.grid.upload(data, true);
    }

    addPeer(p) { this.lockstep.addPeer(p, this.simTime); }

    schedule(action) { return this.lockstep.scheduleLocal(action); }

    /** Try to simulate one tick. Returns false when gated. */
    step() {
        const tick = this.simTime;
        const frames = this.lockstep.emitFramesThrough(tick + this.lockstep.inputDelay);
        if (frames.length) { this.sentFrames += frames.length; this.network?.send(this, frames); }
        if (!this.lockstep.canSimulate(tick)) { this.stalls++; return false; }

        const gpu = GPU.get();
        const encoder = gpu.createCommandEncoder('headless tick');
        const acts = this.lockstep.actionsForTick(tick);
        if (acts.length) {
            const n = this.actions.encodeApply(encoder, this.grid.getReadTexture(), this.grid.getWriteTexture(), acts);
            if (n > 0) {
                this.grid.swap();
                for (const a of acts) this.applied.push({ tick, playerId: a.playerId, type: a.action.type });
            }
        }
        this.sim.encodeStep(encoder, this.grid.getReadTexture(), this.grid.getWriteTexture(), tick);
        this.grid.swap();
        gpu.submit([encoder.finish()]);
        this.simTime = tick + 1;
        return true;
    }

    async download() { return this.grid.download(); }

    destroy() { this.grid.destroy(); }
}

// ============================================================================
// SimulatedNetwork — latency / jitter / reorder / drop, plus NACK recovery
// ============================================================================

class SimulatedNetwork {
    constructor(c1, c2, opts = {}) {
        this.c1 = c1; this.c2 = c2;
        c1.network = this; c2.network = this;
        this.latency = opts.latency ?? 0;           // c1 -> c2 (in steps)
        this.latencyReverse = opts.latencyReverse ?? this.latency;
        this.jitter = opts.jitter ?? 0;
        this.dropChance = opts.dropChance ?? 0;
        this.reorder = opts.reorder ?? false;
        this.rng = createRng(opts.seed ?? 1);
        this.now = 0;
        this.queue = [];
        this.dropped = 0;
        this.resends = 0;
    }
    send(from, frames) {
        if (this.dropChance > 0 && this.rng() < this.dropChance) { this.dropped++; return; }
        const to = from === this.c1 ? this.c2 : this.c1;
        const base = from === this.c1 ? this.latency : this.latencyReverse;
        const jitter = this.jitter ? Math.floor(this.rng() * (this.jitter + 1)) : 0;
        this.queue.push({ at: this.now + base + jitter, to, from, frames: frames.map(f => ({ tick: f.tick, actions: f.actions })) });
    }
    tick() {
        this.now++;
        if (this.reorder) this.queue.sort(() => this.rng() - 0.5);
        const due = this.queue.filter(m => m.at <= this.now);
        this.queue = this.queue.filter(m => m.at > this.now);
        for (const m of due) m.to.lockstep.receiveFrames(m.from.playerId, m.frames);
    }
    /** Gap recovery, as NetworkManager does it after a stall: ask peer to re-send. */
    recover(client) {
        const peer = client === this.c1 ? this.c2 : this.c1;
        for (const { fromTick } of client.lockstep.missingFor(client.simTime)) {
            const frames = peer.lockstep.ownFramesSince(fromTick).map(f => ({ tick: f.tick, actions: f.actions }));
            if (frames.length) { this.resends++; this.queue.push({ at: this.now + 1, to: client, from: peer, frames }); }
        }
    }
    flush() { this.now += 100000; this.tick(); }
}

function createRng(seed) {
    let s = seed;
    return function () {
        s |= 0; s = s + 0x6D2B79F5 | 0;
        let t = Math.imul(s ^ s >>> 15, 1 | s);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function gridsMatch(a, b) {
    if (a.length !== b.length) return { match: false, reason: 'length' };
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            const cell = Math.floor(i / 4);
            return { match: false, x: cell % GRID_SIZE, y: Math.floor(cell / GRID_SIZE), channel: 'RGBA'[i % 4], valA: a[i], valB: b[i] };
        }
    }
    return { match: true };
}

// ============================================================================
// Shared pipelines + pair factory
// ============================================================================

let shared = null;
async function ensurePipelines() {
    if (!shared) {
        shared = {
            sim: await SimulationPipeline.create(GRID_SIZE, GRID_SIZE),
            actions: await ActionPipeline.create(GRID_SIZE, GRID_SIZE, { deleteRadius: 2, firstFactoryResources: 80 })
        };
    }
    return shared;
}

async function createPair({ delay = 3, seed = MAP_SEED, ...netOpts } = {}) {
    const p = await ensurePipelines();
    const c1 = new HeadlessGameClient(1, GRID_SIZE, p.sim, p.actions, delay);
    const c2 = new HeadlessGameClient(2, GRID_SIZE, p.sim, p.actions, delay);
    c1.loadMap(seed); c2.loadMap(seed);
    c1.addPeer(2); c2.addPeer(1);
    const net = new SimulatedNetwork(c1, c2, netOpts);
    return { c1, c2, net };
}

/**
 * Run the pair for `steps` wall-clock steps. Each step: each client attempts
 * one tick (optionally skipping some, to simulate a slow machine), the
 * network delivers, and stalled clients trigger gap recovery after a while.
 */
async function run(pair, steps, { slowClient = null, slowEvery = 2, recoverAfter = 30, onStep = null } = {}) {
    const { c1, c2, net } = pair;
    const stalledFor = pair.stalledFor ??= { 1: 0, 2: 0 };
    for (let i = 0; i < steps; i++) {
        onStep?.(i);
        for (const c of [c1, c2]) {
            if (c === slowClient && i % slowEvery !== 0) continue;
            const ok = c.step();
            stalledFor[c.playerId] = ok ? 0 : stalledFor[c.playerId] + 1;
            if (stalledFor[c.playerId] >= recoverAfter) { net.recover(c); stalledFor[c.playerId] = 0; }
        }
        net.tick();
    }
}

/** Bring both clients to the same tick (the lower of the two), and compare. */
async function settleAndCompare(pair, { maxSteps = 2000 } = {}) {
    const { c1, c2, net } = pair;
    net.flush();
    // Step only the one behind until aligned
    let guard = 0;
    while (c1.simTime !== c2.simTime && guard++ < maxSteps) {
        const behind = c1.simTime < c2.simTime ? c1 : c2;
        if (!behind.step()) { net.recover(behind); net.flush(); }
    }
    assert(c1.simTime === c2.simTime, `ticks aligned (${c1.simTime} vs ${c2.simTime})`);
    const [a, b] = await Promise.all([c1.download(), c2.download()]);
    const r = gridsMatch(a, b);
    assert(r.match, `grids differ at tick ${c1.simTime}: (${r.x},${r.y}) ${r.channel} ${r.valA} vs ${r.valB}`);
    // applied action logs identical
    assert(c1.applied.length === c2.applied.length, `applied counts differ: ${c1.applied.length} vs ${c2.applied.length}`);
    for (let i = 0; i < c1.applied.length; i++) {
        const x = c1.applied[i], y = c2.applied[i];
        assert(x.tick === y.tick && x.playerId === y.playerId && x.type === y.type, `applied[${i}] differs: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
    }
    return { tick: c1.simTime, applied: c1.applied.length, data: a };
}

function factoryAction(x, y, isUnbuilt = false) { return { type: 'place_factory', x, y, isUnbuilt }; }
function countType(data, type) { let n = 0; for (let i = 0; i < data.length; i += 4) if (Math.round(data[i]) === type) n++; return n; }

// ============================================================================
// Tests
// ============================================================================

export async function runSyncTests() {
    logSection('Sync - Lockstep basics');

    await runTest('Sync: two clients, no actions, identical after 200 ticks', async () => {
        const pair = await createPair();
        await run(pair, 200);
        const r = await settleAndCompare(pair);
        assert(r.tick >= 190, `advanced (${r.tick})`);
        pair.c1.destroy(); pair.c2.destroy();
    });

    await runTest('Sync: two clients with different initial state DO diverge (control)', async () => {
        const pair = await createPair({ seed: 1 });
        pair.c2.loadMap(2);
        await run(pair, 50);
        pair.net.flush();
        while (pair.c1.simTime !== pair.c2.simTime) { (pair.c1.simTime < pair.c2.simTime ? pair.c1 : pair.c2).step(); }
        const [a, b] = await Promise.all([pair.c1.download(), pair.c2.download()]);
        assert(!gridsMatch(a, b).match, 'different maps must differ');
        pair.c1.destroy(); pair.c2.destroy();
    });

    await runTest('Sync: P1 places a factory — applied at tick+delay on both, grids match', async () => {
        const pair = await createPair({ delay: 4 });
        await run(pair, 10);
        const t = pair.c1.schedule(factoryAction(20, 20));
        await run(pair, 100);
        const r = await settleAndCompare(pair);
        assert(r.applied === 1, 'one action applied');
        assert(pair.c1.applied[0].tick === t, `applied at scheduled tick ${t}`);
        assert(countType(r.data, 3) === 8, 'factory has 8 cells');
        pair.c1.destroy(); pair.c2.destroy();
    });

    await runTest('Sync: both players place at the same tick — deterministic order, grids match', async () => {
        const pair = await createPair({ delay: 2 });
        await run(pair, 5);
        pair.c1.schedule(factoryAction(20, 20));
        pair.c2.schedule(factoryAction(40, 40));
        await run(pair, 100);
        const r = await settleAndCompare(pair);
        assert(r.applied === 2, 'two actions');
        assert(pair.c1.applied[0].playerId === 1 && pair.c1.applied[1].playerId === 2, 'P1 before P2 at the same tick');
        pair.c1.destroy(); pair.c2.destroy();
    });

    await runTest('Sync: overlapping placements at the same tick resolve identically', async () => {
        const pair = await createPair({ delay: 2 });
        await run(pair, 5);
        pair.c1.schedule(factoryAction(30, 30));
        pair.c2.schedule(factoryAction(31, 30));
        await run(pair, 60);
        const r = await settleAndCompare(pair);
        assert(r.applied === 2, 'both applied');
        pair.c1.destroy(); pair.c2.destroy();
    });

    logSection('Sync - Latency');

    await runTest('Sync: 2-step latency below delay 4 — no stalls, grids match', async () => {
        const pair = await createPair({ delay: 4, latency: 2 });
        await run(pair, 20);
        pair.c1.stalls = 0; pair.c2.stalls = 0;   // ignore the initial handshake
        pair.c1.schedule(factoryAction(20, 20));
        pair.c2.schedule(factoryAction(40, 40));
        await run(pair, 200);
        assert(pair.c1.stalls === 0 && pair.c2.stalls === 0, `no stalls (${pair.c1.stalls}, ${pair.c2.stalls})`);
        await settleAndCompare(pair);
        pair.c1.destroy(); pair.c2.destroy();
    });

    await runTest('Sync: 10-step latency above delay 3 — stalls but grids match', async () => {
        const pair = await createPair({ delay: 3, latency: 10 });
        for (let i = 0; i < 300; i++) {
            if (i === 20) pair.c1.schedule(factoryAction(20, 20));
            if (i === 25) pair.c2.schedule(factoryAction(40, 40));
            await run(pair, 1);
        }
        assert(pair.c1.stalls > 0, 'stalled at least once');
        const r = await settleAndCompare(pair);
        assert(r.applied === 2, 'both actions applied');
        pair.c1.destroy(); pair.c2.destroy();
    });

    await runTest('Sync: asymmetric latency P1→P2=5, P2→P1=20 — grids match', async () => {
        const pair = await createPair({ delay: 4, latency: 5, latencyReverse: 20 });
        for (let i = 0; i < 300; i++) {
            if (i % 40 === 10) pair.c1.schedule(factoryAction(10 + (i % 3) * 12, 20));
            if (i % 50 === 30) pair.c2.schedule(factoryAction(10 + (i % 3) * 12, 44));
            await run(pair, 1);
        }
        await settleAndCompare(pair);
        pair.c1.destroy(); pair.c2.destroy();
    });

    await runTest('Sync: 30-step latency with multiple actions — grids match', async () => {
        const pair = await createPair({ delay: 6, latency: 30 });
        for (let i = 0; i < 400; i++) {
            if (i % 60 === 15) pair.c1.schedule(factoryAction(12 + (i % 4) * 10, 15));
            if (i % 70 === 35) pair.c2.schedule(factoryAction(12 + (i % 4) * 10, 45));
            await run(pair, 1);
        }
        const r = await settleAndCompare(pair);
        assert(r.applied >= 8, `actions applied (${r.applied})`);
        pair.c1.destroy(); pair.c2.destroy();
    });

    logSection('Sync - Jitter, reordering, loss');

    await runTest('Sync: 0-5 step jitter over 500 ticks with actions — grids match', async () => {
        const pair = await createPair({ delay: 6, latency: 2, jitter: 5, seed: 7 });
        for (let i = 0; i < 500; i++) {
            if (i % 45 === 0) pair.c1.schedule(factoryAction(8 + (i % 5) * 10, 12));
            if (i % 55 === 0) pair.c2.schedule(factoryAction(8 + (i % 5) * 10, 50));
            await run(pair, 1);
        }
        await settleAndCompare(pair);
        pair.c1.destroy(); pair.c2.destroy();
    });

    await runTest('Sync: reordered delivery — grids match', async () => {
        const pair = await createPair({ delay: 5, latency: 3, jitter: 4, reorder: true, seed: 3 });
        for (let i = 0; i < 400; i++) {
            if (i % 37 === 0) pair.c1.schedule(factoryAction(8 + (i % 5) * 10, 12));
            if (i % 41 === 0) pair.c2.schedule(factoryAction(8 + (i % 5) * 10, 50));
            await run(pair, 1);
        }
        await settleAndCompare(pair);
        pair.c1.destroy(); pair.c2.destroy();
    });

    await runTest('Sync: 10% message loss with re-send recovery — grids match, no action lost', async () => {
        const pair = await createPair({ delay: 4, latency: 2, dropChance: 0.1, seed: 11 });
        let scheduled = 0;
        for (let i = 0; i < 600; i++) {
            if (i % 50 === 5) { pair.c1.schedule(factoryAction(8 + (i % 5) * 10, 12)); scheduled++; }
            if (i % 60 === 7) { pair.c2.schedule(factoryAction(8 + (i % 5) * 10, 50)); scheduled++; }
            await run(pair, 1, { recoverAfter: 15 });
        }
        assert(pair.net.dropped > 0, 'messages were dropped');
        const r = await settleAndCompare(pair);
        assert(pair.net.resends > 0, 'recovery re-sends happened');
        assert(r.applied === scheduled, `all ${scheduled} actions applied (${r.applied})`);
        pair.c1.destroy(); pair.c2.destroy();
    });

    logSection('Sync - Slow peer');

    await runTest('Sync: P2 runs at half speed — P1 never more than delay ahead, grids match', async () => {
        const pair = await createPair({ delay: 5, latency: 1 });
        let maxLead = 0;
        await run(pair, 400, {
            slowClient: pair.c2, slowEvery: 2,
            onStep: (i) => {
                maxLead = Math.max(maxLead, pair.c1.simTime - pair.c2.simTime);
                if (i % 50 === 10) pair.c1.schedule(factoryAction(10 + (i % 4) * 12, 15));
                if (i % 70 === 20) pair.c2.schedule(factoryAction(10 + (i % 4) * 12, 45));
            }
        });
        assert(maxLead <= 6, `lead bounded by delay (${maxLead})`);
        await settleAndCompare(pair);
        pair.c1.destroy(); pair.c2.destroy();
    });

    await runTest('Sync: P1 at 1/5 speed with latency both ways — grids match', async () => {
        const pair = await createPair({ delay: 6, latency: 4, latencyReverse: 8 });
        await run(pair, 500, {
            slowClient: pair.c1, slowEvery: 5,
            onStep: (i) => {
                if (i % 60 === 10) pair.c1.schedule(factoryAction(10 + (i % 4) * 12, 15));
                if (i % 45 === 20) pair.c2.schedule(factoryAction(10 + (i % 4) * 12, 45));
            }
        });
        await settleAndCompare(pair);
        pair.c1.destroy(); pair.c2.destroy();
    });

    logSection('Sync - Action types');

    await runTest('Sync: place then demolish with latency — grids match, factory gone', async () => {
        const pair = await createPair({ delay: 3, latency: 4 });
        await run(pair, 5);
        pair.c1.schedule(factoryAction(20, 20));
        await run(pair, 40);
        pair.c1.schedule({ type: 'demolish', x: 20, y: 20 });
        await run(pair, 120);
        const r = await settleAndCompare(pair);
        assert(r.applied === 2, 'two actions');
        pair.c1.destroy(); pair.c2.destroy();
    });

    await runTest('Sync: place + demolish at the same tick from different players — grids match', async () => {
        const pair = await createPair({ delay: 2 });
        await run(pair, 5);
        pair.c1.schedule(factoryAction(20, 20));
        await run(pair, 30);
        pair.c1.schedule(factoryAction(40, 40));
        pair.c2.schedule({ type: 'demolish', x: 20, y: 20 });   // P2 can't demolish P1's factory
        await run(pair, 60);
        const r = await settleAndCompare(pair);
        assert(r.applied === 3, 'three actions');
        assert(countType(r.data, 3) >= 8, 'P1 factories survive P2 demolish');
        pair.c1.destroy(); pair.c2.destroy();
    });

    await runTest('Sync: selection + command + clear sequence with latency — grids match', async () => {
        const pair = await createPair({ delay: 3, latency: 6, jitter: 2, seed: 5 });
        await run(pair, 5);
        pair.c1.schedule(factoryAction(20, 20));
        pair.c2.schedule(factoryAction(44, 44));
        await run(pair, 200);   // let units spawn
        pair.c1.schedule({ type: 'unit_selection', region: { x1: 0, y1: 0, x2: 63, y2: 63 } });
        await run(pair, 10);
        pair.c1.schedule({ type: 'unit_command', destX: 50, destY: 10 });
        pair.c2.schedule({ type: 'unit_selection', region: { x1: 0, y1: 0, x2: 63, y2: 63 } });
        await run(pair, 10);
        pair.c1.schedule({ type: 'clear_selection' });
        pair.c2.schedule({ type: 'unit_command', destX: 5, destY: 60 });
        await run(pair, 150);
        const r = await settleAndCompare(pair);
        assert(r.applied === 7, `seven actions (${r.applied})`);
        pair.c1.destroy(); pair.c2.destroy();
    });

    logSection('Sync - Long runs');

    await runTest('Sync: 2000 ticks, random interlaced actions, jittery latency — grids match', async () => {
        const pair = await createPair({ delay: 6, latency: 3, jitter: 6, seed: 21 });
        const rng = createRng(77);
        let scheduled = 0;
        for (let i = 0; i < 2000; i++) {
            if (rng() < 0.02) {
                const c = rng() < 0.5 ? pair.c1 : pair.c2;
                const k = rng();
                if (k < 0.4) c.schedule(factoryAction(4 + Math.floor(rng() * 56), 4 + Math.floor(rng() * 56), rng() < 0.5));
                else if (k < 0.55) c.schedule({ type: 'demolish', x: Math.floor(rng() * 64), y: Math.floor(rng() * 64) });
                else if (k < 0.75) c.schedule({ type: 'unit_selection', region: { x1: 0, y1: 0, x2: 63, y2: 63 } });
                else if (k < 0.9) c.schedule({ type: 'unit_command', destX: Math.floor(rng() * 64), destY: Math.floor(rng() * 64) });
                else c.schedule({ type: 'clear_selection' });
                scheduled++;
            }
            await run(pair, 1);
        }
        const r = await settleAndCompare(pair);
        assert(r.applied === scheduled, `all ${scheduled} actions applied (${r.applied})`);
        assert(r.tick >= 1200, `advanced ${r.tick} ticks`);
        pair.c1.destroy(); pair.c2.destroy();
    });

    await runTest('Sync: 5000 ticks with periodic actions — grids match (precision)', async () => {
        const pair = await createPair({ delay: 4, latency: 2 });
        for (let i = 0; i < 5000; i++) {
            if (i % 400 === 20) pair.c1.schedule(factoryAction(10 + (i / 400 % 4) * 12, 15));
            if (i % 500 === 60) pair.c2.schedule(factoryAction(10 + (i / 500 % 4) * 12, 45));
            await run(pair, 1);
        }
        const r = await settleAndCompare(pair);
        assert(r.tick >= 4990, `advanced ${r.tick}`);
        pair.c1.destroy(); pair.c2.destroy();
    });

    logSection('Sync - Snapshot join');

    await runTest('Sync: late joiner from snapshot (grid + future frames) matches the host', async () => {
        const p = await ensurePipelines();
        const host = new HeadlessGameClient(1, GRID_SIZE, p.sim, p.actions, 4);
        host.loadMap(MAP_SEED);
        // host runs alone for a while with an action
        for (let i = 0; i < 100; i++) { if (i === 10) host.schedule(factoryAction(20, 20)); host.step(); }
        // joiner appears: host gates on them at tick T and snapshots (grid + frames >= T)
        const T = host.simTime;
        host.addPeer(2);
        const gridData = await host.download();
        const frames = host.lockstep.allFramesSince(T);
        assert(frames.length === host.lockstep.inputDelay, `snapshot carries the host's ${host.lockstep.inputDelay} future frames (${frames.length})`);
        assert(!host.step(), 'host stalls until the joiner sends frames');

        const joiner = new HeadlessGameClient(2, GRID_SIZE, p.sim, p.actions, 4);
        joiner.grid.upload(gridData, true);
        joiner.simTime = T;
        joiner.lockstep.start(T, 2);
        joiner.addPeer(1);
        joiner.lockstep.importFrames(frames);

        host.applied = [];   // compare action logs from the snapshot tick on
        const net = new SimulatedNetwork(host, joiner, { latency: 2 });
        const pair = { c1: host, c2: joiner, net };
        for (let i = 0; i < 200; i++) {
            if (i === 30) joiner.schedule(factoryAction(40, 40));
            if (i === 50) host.schedule(factoryAction(20, 44));
            await run(pair, 1);
        }
        const r = await settleAndCompare(pair);
        assert(r.tick > T + 100, `both progressed (${r.tick} vs ${T})`);
        assert(countType(r.data, 7) === 8, 'joiner\'s factory exists on both');
        host.destroy(); joiner.destroy();
    });
}
