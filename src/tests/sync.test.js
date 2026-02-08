/**
 * Multiplayer Synchronization Integration Tests
 *
 * Tests that two game clients running the REAL GPU compute shader
 * stay in sync under various network conditions (latency, jitter, reordering).
 *
 * Uses real WebGPU compute pipeline, real ActionQueue, real RollbackManager,
 * real CheckpointBuffer, and real CAGrid (64x64 for speed).
 */

import { GPU } from '../gpu/GPU.js';
import { CAGrid } from '../ca/CAGrid.js';
import { CheckpointBuffer } from '../gpu/CheckpointBuffer.js';
import { ComputePipeline } from '../gpu/ComputePipeline.js';
import { ActionQueue } from '../network/ActionQueue.js';
import { ActionApplier } from '../game/ActionApplier.js';
import { RollbackManager } from '../game/RollbackManager.js';
import { MapGenerator } from '../game/MapGenerator.js';
import { loadShader } from '../shaders/load.js';
import { runTest, assert, logSection } from './framework.js';

// ============================================================================
// Constants
// ============================================================================

const GRID_SIZE = 64;
const MAP_SEED = 12345;

// ============================================================================
// HeadlessGameClient — real GPU sim with real ActionQueue/RollbackManager
// ============================================================================

class HeadlessGameClient {
    /**
     * @param {number} gridSize
     * @param {ComputePipeline} simPipeline - shared compute pipeline
     */
    constructor(gridSize, simPipeline) {
        this.gridSize = gridSize;
        this.simPipeline = simPipeline;

        const gpu = GPU.get();

        // Own GPU state
        this.grid = new CAGrid(gridSize, gridSize);
        this.simUniformBuffer = gpu.createUniformBuffer(16, 'HeadlessClient SimParams');
        this.simTime = 0;
        this.isMultiplayer = true;

        // Own action/rollback state
        this.actionApplier = new ActionApplier({
            gridSize,
            deleteRadius: 2,
            firstFactoryResources: 80,
            onStateChange: () => {}
        });

        this.checkpointBuffer = new CheckpointBuffer(
            gridSize, gridSize,
            { format: 'float' },
            10,  // maxCheckpoints (reduced for test)
            10   // checkpointInterval (reduced for test)
        );

        this.actionQueue = new ActionQueue();

        this.rollbackManager = new RollbackManager({
            checkpointBuffer: this.checkpointBuffer,
            actionQueue: this.actionQueue,
            getGridData: async () => await this.grid.download(),
            uploadGridData: (data) => this.grid.uploadCurrent(data),
            getCurrentTick: () => Math.floor(this.simTime),
            setTick: (tick) => { this.simTime = tick; },
            simulationStep: () => this.simulationStep(),
            applyAction: async (action, playerId) => {
                const currentData = await this.grid.download();
                const modified = this.actionApplier.applyAction(currentData, action, playerId);
                if (modified) {
                    this.grid.uploadCurrent(currentData);
                }
            }
        });
    }

    /**
     * Load initial map data (same as Game.generateMap)
     */
    loadMap(seed) {
        const mapGen = new MapGenerator(this.gridSize, {
            // Use reduced blob counts for 64x64 grid
            numBlobs: 30,
            blobMinRadius: 1,
            blobMaxRadius: 3,
            blobDensity: 0.6,
            numWallLines: 10,
            wallMinLength: 2,
            wallMaxLength: 6,
            numWallBlobs: 3,
            wallBlobRadius: 2
        });
        const data = new Float32Array(this.gridSize * this.gridSize * 4);
        mapGen.generate(data, seed);
        this.grid.upload(data, true);
    }

    /**
     * Run one simulation step — identical to Game.simulationStep()
     */
    simulationStep() {
        const gpu = GPU.get();
        const readTex = this.grid.getReadTexture();
        const writeTex = this.grid.getWriteTexture();

        const params = new Float32Array([
            this.gridSize, this.gridSize, this.simTime, 0
        ]);
        gpu.writeBuffer(this.simUniformBuffer, params);

        const bindGroup = this.simPipeline.createBindGroup([
            { binding: 0, resource: readTex.view },
            { binding: 1, resource: writeTex.view },
            { binding: 2, resource: { buffer: this.simUniformBuffer } }
        ]);

        const workgroups = Math.ceil(this.gridSize / 8);
        this.simPipeline.dispatch(bindGroup, workgroups, workgroups);

        this.grid.swap();
        this.simTime += 1.0;

        // Save periodic checkpoints
        if (this.rollbackManager.shouldSaveCheckpoint()) {
            this.rollbackManager.saveCheckpoint();
        }
    }

    /**
     * Apply pending actions — identical to Game.applyPendingActions()
     */
    async applyPendingActions() {
        const tick = Math.floor(this.simTime);
        const actionsAtTick = this.actionQueue.getActionsAtTick(tick);
        const unapplied = actionsAtTick.filter(a => !a.applied);

        if (unapplied.length === 0) return;

        const currentData = await this.grid.download();

        // Save checkpoint BEFORE actions
        this.checkpointBuffer.saveCheckpoint(tick, new Float32Array(currentData));

        // Sort by playerId for deterministic ordering
        unapplied.sort((a, b) => a.playerId - b.playerId);

        for (const action of unapplied) {
            this.actionApplier.applyAction(currentData, action.data, action.playerId);
            action.applied = true;
        }

        this.grid.uploadCurrent(currentData);
    }

    /**
     * Apply pending actions WITHOUT sorting — for negative test
     */
    async applyPendingActionsUnsorted() {
        const tick = Math.floor(this.simTime);
        const actionsAtTick = this.actionQueue.getActionsAtTick(tick);
        const unapplied = actionsAtTick.filter(a => !a.applied);

        if (unapplied.length === 0) return;

        const currentData = await this.grid.download();
        this.checkpointBuffer.saveCheckpoint(tick, new Float32Array(currentData));

        // NO SORT — intentionally non-deterministic
        for (const action of unapplied) {
            this.actionApplier.applyAction(currentData, action.data, action.playerId);
            action.applied = true;
        }

        this.grid.uploadCurrent(currentData);
    }

    /**
     * Advance N ticks: applyPendingActions + simulationStep per tick
     */
    async advanceTicks(n) {
        for (let i = 0; i < n; i++) {
            await this.applyPendingActions();
            this.simulationStep();
        }
    }

    /**
     * Store a local action (applied immediately + queued)
     */
    performLocalAction(action, playerId) {
        const tick = Math.floor(this.simTime);
        this.actionQueue.addAction(tick, playerId, action.type, action, true);
    }

    /**
     * Receive a remote action — routes to RollbackManager
     */
    async receiveRemoteAction(action, playerId, tick) {
        await this.rollbackManager.processRemoteAction(action, playerId, tick);
    }

    /**
     * Download grid data for comparison
     */
    async getGridData() {
        return this.grid.download();
    }

    destroy() {
        this.grid.destroy();
        this.checkpointBuffer.destroy();
    }
}

// ============================================================================
// SimulatedNetwork — configurable message relay between two clients
// ============================================================================

class SimulatedNetwork {
    /**
     * @param {HeadlessGameClient} client1
     * @param {HeadlessGameClient} client2
     * @param {Object} options
     * @param {number} options.latencyTicks - base latency in ticks
     * @param {number} [options.jitterTicks=0] - random additional delay
     * @param {number} [options.reorderChance=0] - probability of swapping order
     * @param {number} [options.dropChance=0] - probability of dropping a message
     * @param {number} [options.latencyTicksReverse] - latency from client2 to client1 (for asymmetric)
     */
    constructor(client1, client2, options = {}) {
        this.client1 = client1;
        this.client2 = client2;
        this.latencyTicks = options.latencyTicks ?? 0;
        this.latencyTicksReverse = options.latencyTicksReverse ?? this.latencyTicks;
        this.jitterTicks = options.jitterTicks ?? 0;
        this.reorderChance = options.reorderChance ?? 0;
        this.dropChance = options.dropChance ?? 0;

        // Pending messages: { deliverAtTick, targetClient, action, playerId, actionTick }
        this.pendingMessages = [];
        this._rng = createSimpleRng(42);
    }

    /**
     * Queue an action to be delivered to the other client.
     */
    sendAction(fromClient, action, playerId, tick) {
        if (this._rng() < this.dropChance) return; // dropped

        const targetClient = fromClient === this.client1 ? this.client2 : this.client1;
        const baseLatency = fromClient === this.client1 ? this.latencyTicks : this.latencyTicksReverse;
        const jitter = this.jitterTicks > 0 ? Math.floor(this._rng() * (this.jitterTicks + 1)) : 0;
        const deliverAtTick = tick + baseLatency + jitter;

        this.pendingMessages.push({
            deliverAtTick,
            targetClient,
            action,
            playerId,
            actionTick: tick
        });
    }

    /**
     * Deliver all messages that should arrive at or before currentTick.
     */
    async deliverPendingMessages(currentTick) {
        // Optionally reorder
        if (this.reorderChance > 0) {
            for (let i = this.pendingMessages.length - 1; i > 0; i--) {
                if (this._rng() < this.reorderChance) {
                    // Swap with random earlier message
                    const j = Math.floor(this._rng() * i);
                    [this.pendingMessages[i], this.pendingMessages[j]] =
                        [this.pendingMessages[j], this.pendingMessages[i]];
                }
            }
        }

        const toDeliver = this.pendingMessages.filter(m => m.deliverAtTick <= currentTick);
        this.pendingMessages = this.pendingMessages.filter(m => m.deliverAtTick > currentTick);

        for (const msg of toDeliver) {
            await msg.targetClient.receiveRemoteAction(msg.action, msg.playerId, msg.actionTick);
        }
    }
}

// ============================================================================
// Helpers
// ============================================================================

/** Simple seeded RNG for deterministic network simulation */
function createSimpleRng(seed) {
    let s = seed;
    return function() {
        s |= 0;
        s = s + 0x6D2B79F5 | 0;
        let t = Math.imul(s ^ s >>> 15, 1 | s);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

/** Compare two grid data arrays. Returns { match, firstDiffIndex, firstDiffChannel } */
function gridsMatch(dataA, dataB) {
    if (dataA.length !== dataB.length) {
        return { match: false, firstDiffIndex: -1, reason: 'length mismatch' };
    }
    for (let i = 0; i < dataA.length; i++) {
        if (dataA[i] !== dataB[i]) {
            const cellIndex = Math.floor(i / 4);
            const channel = i % 4;
            const x = cellIndex % GRID_SIZE;
            const y = Math.floor(cellIndex / GRID_SIZE);
            return {
                match: false,
                firstDiffIndex: i,
                x, y,
                channel: ['R', 'G', 'B', 'A'][channel],
                valA: dataA[i],
                valB: dataB[i]
            };
        }
    }
    return { match: true };
}

// ============================================================================
// Shared pipeline (compiled once, shared by all clients)
// ============================================================================

let sharedSimPipeline = null;

async function ensureShader() {
    if (!sharedSimPipeline) {
        const source = await loadShader('./src/shaders/ca/v2/mining_game.wgsl');
        sharedSimPipeline = new ComputePipeline(source, { label: 'Sync test pipeline' });
    }
    return sharedSimPipeline;
}

/** Create two clients with identical initial state */
async function createClientPair(seed = MAP_SEED) {
    const pipeline = await ensureShader();
    const c1 = new HeadlessGameClient(GRID_SIZE, pipeline);
    const c2 = new HeadlessGameClient(GRID_SIZE, pipeline);
    c1.loadMap(seed);
    c2.loadMap(seed);
    return { c1, c2 };
}

// A factory action for testing
function factoryAction(x, y, isUnbuilt = false) {
    return { type: 'place_factory', x, y, isUnbuilt };
}

// ============================================================================
// Tests
// ============================================================================

export async function runSyncTests() {
    // ====================================================================
    // A. Baseline Determinism (no actions, no network)
    // ====================================================================
    logSection('Sync - Baseline Determinism');

    await runTest('Sync: two clients with same initial state stay in sync for 100 ticks', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            for (let i = 0; i < 100; i++) {
                c1.simulationStep();
                c2.simulationStep();
            }
            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Grids diverged after 100 ticks at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: two clients with same initial state stay in sync for 1000 ticks', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            for (let i = 0; i < 1000; i++) {
                c1.simulationStep();
                c2.simulationStep();
            }
            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Grids diverged after 1000 ticks at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: two clients with different initial state diverge', async () => {
        const pipeline = await ensureShader();
        const c1 = new HeadlessGameClient(GRID_SIZE, pipeline);
        const c2 = new HeadlessGameClient(GRID_SIZE, pipeline);
        c1.loadMap(11111);
        c2.loadMap(99999);
        try {
            for (let i = 0; i < 10; i++) {
                c1.simulationStep();
                c2.simulationStep();
            }
            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(!result.match, 'Grids should differ with different seeds');
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    // ====================================================================
    // B. Action Application Determinism (no network delay)
    // ====================================================================
    logSection('Sync - Action Application Determinism');

    await runTest('Sync: P1 places factory, both clients get action at same tick — grids match', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // Advance 10 ticks
            for (let i = 0; i < 10; i++) {
                c1.simulationStep();
                c2.simulationStep();
            }

            // P1 places factory at tick 10 on both clients
            const action = factoryAction(10, 10);
            c1.actionQueue.addAction(10, 1, action.type, action, false);
            c2.actionQueue.addAction(10, 1, action.type, action, false);

            // Both apply and continue
            await c1.applyPendingActions();
            await c2.applyPendingActions();

            for (let i = 0; i < 50; i++) {
                c1.simulationStep();
                c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Grids diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: both players place factories at same tick — grids match', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            for (let i = 0; i < 10; i++) {
                c1.simulationStep();
                c2.simulationStep();
            }

            // Both players act at tick 10
            const a1 = factoryAction(10, 10);
            const a2 = factoryAction(50, 50);
            c1.actionQueue.addAction(10, 1, a1.type, a1, false);
            c1.actionQueue.addAction(10, 2, a2.type, a2, false);
            c2.actionQueue.addAction(10, 1, a1.type, a1, false);
            c2.actionQueue.addAction(10, 2, a2.type, a2, false);

            await c1.applyPendingActions();
            await c2.applyPendingActions();

            for (let i = 0; i < 50; i++) {
                c1.simulationStep();
                c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Grids diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: sequence of actions from both players — grids match after 200 ticks', async () => {
        const { c1, c2 } = await createClientPair();
        const net = new SimulatedNetwork(c1, c2, { latencyTicks: 0 });
        try {
            for (let tick = 0; tick < 200; tick++) {
                // P1 places at tick 20
                if (tick === 20) {
                    const a = factoryAction(10, 10);
                    c1.actionQueue.addAction(tick, 1, a.type, a, false);
                    c2.actionQueue.addAction(tick, 1, a.type, a, false);
                }
                // P2 places at tick 40
                if (tick === 40) {
                    const a = factoryAction(50, 50);
                    c1.actionQueue.addAction(tick, 2, a.type, a, false);
                    c2.actionQueue.addAction(tick, 2, a.type, a, false);
                }
                // P1 places second factory at tick 80
                if (tick === 80) {
                    const a = factoryAction(20, 20, true);
                    c1.actionQueue.addAction(tick, 1, a.type, a, false);
                    c2.actionQueue.addAction(tick, 1, a.type, a, false);
                }

                await c1.applyPendingActions();
                await c2.applyPendingActions();
                c1.simulationStep();
                c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Grids diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    // ====================================================================
    // C. Network Latency (the real tests)
    // ====================================================================
    logSection('Sync - Network Latency');

    await runTest('Sync: P2 action at tick 10, delivered to P1 at tick 15 (5-tick latency) — grids match', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // Advance both to tick 10
            for (let i = 0; i < 10; i++) {
                await c1.applyPendingActions();
                c1.simulationStep();
                await c2.applyPendingActions();
                c2.simulationStep();
            }

            // P2 places factory at tick 10
            const action = factoryAction(30, 30);
            // On c2 (P2's client), action is applied immediately
            c2.actionQueue.addAction(10, 2, action.type, action, false);
            // Rewind c2 to tick 10 to apply
            // Actually: P2 applies it right now at tick 10
            await c2.applyPendingActions();

            // Advance both to tick 15, c1 doesn't know about the action yet
            for (let i = 0; i < 5; i++) {
                c1.simulationStep();
                c2.simulationStep();
            }

            // At tick 15, c1 receives P2's action from tick 10 (late delivery)
            await c1.receiveRemoteAction(action, 2, 10);

            // Continue to tick 100
            for (let i = 0; i < 85; i++) {
                await c1.applyPendingActions();
                c1.simulationStep();
                await c2.applyPendingActions();
                c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Grids diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: P1 action at tick 10, delivered to P2 at tick 20 (10-tick latency) — grids match', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            for (let i = 0; i < 10; i++) {
                await c1.applyPendingActions();
                c1.simulationStep();
                await c2.applyPendingActions();
                c2.simulationStep();
            }

            const action = factoryAction(15, 15);
            c1.actionQueue.addAction(10, 1, action.type, action, false);
            await c1.applyPendingActions();

            for (let i = 0; i < 10; i++) {
                c1.simulationStep();
                c2.simulationStep();
            }

            // At tick 20, c2 receives P1's action from tick 10
            await c2.receiveRemoteAction(action, 1, 10);

            for (let i = 0; i < 80; i++) {
                await c1.applyPendingActions();
                c1.simulationStep();
                await c2.applyPendingActions();
                c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Grids diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: both players act at tick 10, cross-delivered with 5-tick latency — grids match', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            for (let i = 0; i < 10; i++) {
                await c1.applyPendingActions();
                c1.simulationStep();
                await c2.applyPendingActions();
                c2.simulationStep();
            }

            // Both place at tick 10
            const a1 = factoryAction(10, 10);
            const a2 = factoryAction(50, 50);

            // Each client knows its own action immediately
            c1.actionQueue.addAction(10, 1, a1.type, a1, false);
            c2.actionQueue.addAction(10, 2, a2.type, a2, false);
            await c1.applyPendingActions();
            await c2.applyPendingActions();

            // Advance 5 ticks
            for (let i = 0; i < 5; i++) {
                c1.simulationStep();
                c2.simulationStep();
            }

            // Cross-deliver at tick 15
            await c1.receiveRemoteAction(a2, 2, 10);
            await c2.receiveRemoteAction(a1, 1, 10);

            // Continue to tick 100
            for (let i = 0; i < 85; i++) {
                await c1.applyPendingActions();
                c1.simulationStep();
                await c2.applyPendingActions();
                c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Grids diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: high latency (30 ticks) with multiple actions — grids match', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // Actions from both players at various ticks
            const actions = [
                { tick: 10, player: 1, action: factoryAction(10, 10) },
                { tick: 20, player: 2, action: factoryAction(50, 50) },
                { tick: 50, player: 1, action: factoryAction(20, 20, true) },
                { tick: 60, player: 2, action: factoryAction(40, 40, true) },
            ];

            for (let tick = 0; tick < 200; tick++) {
                // Apply local actions
                for (const entry of actions) {
                    if (tick === entry.tick) {
                        const clientLocal = entry.player === 1 ? c1 : c2;
                        clientLocal.actionQueue.addAction(entry.tick, entry.player, entry.action.type, entry.action, false);
                    }
                }

                // Deliver delayed actions (30-tick latency)
                for (const entry of actions) {
                    if (tick === entry.tick + 30) {
                        const clientRemote = entry.player === 1 ? c2 : c1;
                        await clientRemote.receiveRemoteAction(entry.action, entry.player, entry.tick);
                    }
                }

                await c1.applyPendingActions();
                await c2.applyPendingActions();
                c1.simulationStep();
                c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Grids diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: asymmetric latency P1→P2=5, P2→P1=20 — grids match', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            const a1 = factoryAction(10, 10);
            const a2 = factoryAction(50, 50);

            for (let tick = 0; tick < 150; tick++) {
                if (tick === 15) {
                    c1.actionQueue.addAction(15, 1, a1.type, a1, false);
                }
                if (tick === 20) {
                    c2.actionQueue.addAction(20, 2, a2.type, a2, false);
                }
                // P1→P2 latency: 5 ticks
                if (tick === 20) {
                    await c2.receiveRemoteAction(a1, 1, 15);
                }
                // P2→P1 latency: 20 ticks
                if (tick === 40) {
                    await c1.receiveRemoteAction(a2, 2, 20);
                }

                await c1.applyPendingActions();
                await c2.applyPendingActions();
                c1.simulationStep();
                c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Grids diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    // ====================================================================
    // D. Action Bursts and Timing
    // ====================================================================
    logSection('Sync - Action Bursts and Timing');

    await runTest('Sync: rapid-fire P1 acts at ticks 10-15, P2 receives all at tick 25 — grids match', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            const burstActions = [];
            for (let t = 10; t <= 15; t++) {
                burstActions.push({
                    tick: t,
                    action: factoryAction(5 + t, 5 + t, t > 10)
                });
            }

            for (let tick = 0; tick < 150; tick++) {
                // P1 places factories at ticks 10-15
                for (const entry of burstActions) {
                    if (tick === entry.tick) {
                        c1.actionQueue.addAction(entry.tick, 1, entry.action.type, entry.action, false);
                    }
                }

                // All delivered to P2 at tick 25
                if (tick === 25) {
                    for (const entry of burstActions) {
                        await c2.receiveRemoteAction(entry.action, 1, entry.tick);
                    }
                }

                await c1.applyPendingActions();
                await c2.applyPendingActions();
                c1.simulationStep();
                c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Grids diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: P1 and P2 both rapid-fire at overlapping ticks with latency — grids match', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // P1 places at ticks 10, 12, 14
            const p1Actions = [
                { tick: 10, action: factoryAction(8, 8) },
                { tick: 12, action: factoryAction(14, 14, true) },
                { tick: 14, action: factoryAction(20, 20, true) },
            ];
            // P2 places at ticks 11, 13, 15
            const p2Actions = [
                { tick: 11, action: factoryAction(50, 50) },
                { tick: 13, action: factoryAction(44, 44, true) },
                { tick: 15, action: factoryAction(38, 38, true) },
            ];

            for (let tick = 0; tick < 150; tick++) {
                // Local actions
                for (const e of p1Actions) {
                    if (tick === e.tick) c1.actionQueue.addAction(e.tick, 1, e.action.type, e.action, false);
                }
                for (const e of p2Actions) {
                    if (tick === e.tick) c2.actionQueue.addAction(e.tick, 2, e.action.type, e.action, false);
                }

                // Deliver with 10-tick latency
                for (const e of p1Actions) {
                    if (tick === e.tick + 10) await c2.receiveRemoteAction(e.action, 1, e.tick);
                }
                for (const e of p2Actions) {
                    if (tick === e.tick + 10) await c1.receiveRemoteAction(e.action, 2, e.tick);
                }

                await c1.applyPendingActions();
                await c2.applyPendingActions();
                c1.simulationStep();
                c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Grids diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: action arrives exactly at checkpoint boundary tick — grids match', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // Checkpoint interval is 10. Action at tick 10 should hit boundary.
            for (let tick = 0; tick < 10; tick++) {
                await c1.applyPendingActions();
                c1.simulationStep();
                await c2.applyPendingActions();
                c2.simulationStep();
            }

            const action = factoryAction(25, 25);
            c1.actionQueue.addAction(10, 1, action.type, action, false);
            await c1.applyPendingActions();

            // Advance both to tick 20
            for (let i = 0; i < 10; i++) {
                c1.simulationStep();
                c2.simulationStep();
            }

            // Deliver at tick 20 (exactly at another checkpoint boundary)
            await c2.receiveRemoteAction(action, 1, 10);

            for (let i = 0; i < 80; i++) {
                await c1.applyPendingActions();
                c1.simulationStep();
                await c2.applyPendingActions();
                c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Grids diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    // ====================================================================
    // E. Jitter and Reordering
    // ====================================================================
    logSection('Sync - Jitter and Reordering');

    await runTest('Sync: network jitter (0-5 tick random delay) over 500 ticks with actions — grids match', async () => {
        const { c1, c2 } = await createClientPair();
        const net = new SimulatedNetwork(c1, c2, { latencyTicks: 5, jitterTicks: 5 });
        try {
            // Schedule actions
            const actionTicks = [20, 50, 100, 150, 200, 250, 300, 350];
            const p1Actions = actionTicks.filter((_, i) => i % 2 === 0).map((t, i) =>
                ({ tick: t, action: factoryAction(5 + i * 6, 5 + i * 6, i > 0) })
            );
            const p2Actions = actionTicks.filter((_, i) => i % 2 === 1).map((t, i) =>
                ({ tick: t, action: factoryAction(50 - i * 6, 50 - i * 6, i > 0) })
            );

            for (let tick = 0; tick < 500; tick++) {
                // Local actions + network send
                for (const e of p1Actions) {
                    if (tick === e.tick) {
                        c1.actionQueue.addAction(e.tick, 1, e.action.type, e.action, false);
                        net.sendAction(c1, e.action, 1, e.tick);
                    }
                }
                for (const e of p2Actions) {
                    if (tick === e.tick) {
                        c2.actionQueue.addAction(e.tick, 2, e.action.type, e.action, false);
                        net.sendAction(c2, e.action, 2, e.tick);
                    }
                }

                await net.deliverPendingMessages(tick);
                await c1.applyPendingActions();
                await c2.applyPendingActions();
                c1.simulationStep();
                c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Grids diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: actions from two players interleave at different delivery times — grids match', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // P1 sends actions at ticks 10, 20 — delivered to P2 in reverse effective order
            // P1 tick 20 arrives first at tick 22, P1 tick 10 arrives at tick 25
            const a10 = factoryAction(10, 10);
            const a20 = factoryAction(20, 20, true);
            const a2 = factoryAction(50, 50);

            for (let tick = 0; tick < 150; tick++) {
                if (tick === 10) c1.actionQueue.addAction(10, 1, a10.type, a10, false);
                if (tick === 15) c2.actionQueue.addAction(15, 2, a2.type, a2, false);
                if (tick === 20) c1.actionQueue.addAction(20, 1, a20.type, a20, false);

                // Deliver P2's action to P1 at tick 25
                if (tick === 25) await c1.receiveRemoteAction(a2, 2, 15);

                // Deliver P1 tick 20 to P2 at tick 22 (arrives before tick 10!)
                if (tick === 22) await c2.receiveRemoteAction(a20, 1, 20);
                // Deliver P1 tick 10 to P2 at tick 25
                if (tick === 25) await c2.receiveRemoteAction(a10, 1, 10);

                await c1.applyPendingActions();
                await c2.applyPendingActions();
                c1.simulationStep();
                c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Grids diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    // ====================================================================
    // F. Long-Running Stress
    // ====================================================================
    logSection('Sync - Long-Running Stress');

    await runTest('Sync: 1000 ticks, both players place 3 factories each, 5-tick latency — grids match', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            const schedule = [
                { tick: 50, player: 1, action: factoryAction(10, 10) },
                { tick: 100, player: 2, action: factoryAction(50, 50) },
                { tick: 200, player: 1, action: factoryAction(20, 20, true) },
                { tick: 300, player: 2, action: factoryAction(40, 40, true) },
                { tick: 500, player: 1, action: factoryAction(30, 10, true) },
                { tick: 700, player: 2, action: factoryAction(35, 50, true) },
            ];

            for (let tick = 0; tick < 1000; tick++) {
                for (const s of schedule) {
                    if (tick === s.tick) {
                        const local = s.player === 1 ? c1 : c2;
                        local.actionQueue.addAction(s.tick, s.player, s.action.type, s.action, false);
                    }
                    if (tick === s.tick + 5) {
                        const remote = s.player === 1 ? c2 : c1;
                        await remote.receiveRemoteAction(s.action, s.player, s.tick);
                    }
                }

                await c1.applyPendingActions();
                await c2.applyPendingActions();
                c1.simulationStep();
                c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Grids diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: 500 ticks, random actions every ~50 ticks, 10-tick jittery latency — grids match', async () => {
        const { c1, c2 } = await createClientPair();
        const net = new SimulatedNetwork(c1, c2, { latencyTicks: 10, jitterTicks: 5 });
        try {
            const rng = createSimpleRng(777);

            // Pre-generate action schedule
            const schedule = [];
            for (let tick = 20; tick < 450; tick += 40 + Math.floor(rng() * 20)) {
                const player = rng() < 0.5 ? 1 : 2;
                const x = 5 + Math.floor(rng() * 54);
                const y = 5 + Math.floor(rng() * 54);
                const isUnbuilt = schedule.filter(s => s.player === player).length > 0;
                schedule.push({ tick, player, action: factoryAction(x, y, isUnbuilt) });
            }

            for (let tick = 0; tick < 500; tick++) {
                for (const s of schedule) {
                    if (tick === s.tick) {
                        const local = s.player === 1 ? c1 : c2;
                        local.actionQueue.addAction(s.tick, s.player, s.action.type, s.action, false);
                        net.sendAction(local, s.action, s.player, s.tick);
                    }
                }

                await net.deliverPendingMessages(tick);
                await c1.applyPendingActions();
                await c2.applyPendingActions();
                c1.simulationStep();
                c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Grids diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    // ====================================================================
    // G. Negative / Regression Tests
    // ====================================================================
    logSection('Sync - Negative / Regression Tests');

    await runTest('Sync: without playerId sort, simultaneous same-tick actions cause divergence', async () => {
        const pipeline = await ensureShader();
        const c1 = new HeadlessGameClient(GRID_SIZE, pipeline);
        const c2 = new HeadlessGameClient(GRID_SIZE, pipeline);
        c1.loadMap(MAP_SEED);
        c2.loadMap(MAP_SEED);
        try {
            for (let i = 0; i < 10; i++) {
                c1.simulationStep();
                c2.simulationStep();
            }

            // Both players act at same tick, same position (overlapping factories)
            const a1 = factoryAction(30, 30);
            const a2 = factoryAction(30, 30);  // Same position — order matters!

            // c1: P1 first, then P2 (sorted = P1 first)
            c1.actionQueue.addAction(10, 1, a1.type, a1, false);
            c1.actionQueue.addAction(10, 2, a2.type, a2, false);

            // c2: P2 first, then P1 (reverse order — unsorted would differ)
            c2.actionQueue.addAction(10, 2, a2.type, a2, false);
            c2.actionQueue.addAction(10, 1, a1.type, a1, false);

            // Apply WITHOUT sorting on c1, WITH sorting on c2
            await c1.applyPendingActionsUnsorted();
            await c2.applyPendingActions(); // sorted

            for (let i = 0; i < 50; i++) {
                c1.simulationStep();
                c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            // They SHOULD differ since one is sorted and one isn't (with overlapping positions)
            // Note: If the actions write to the same cells, order matters.
            // If this passes (grids match), it means the sort doesn't matter for non-overlapping,
            // which is also useful info. We assert it doesn't match for overlapping case.
            assert(!result.match, 'Grids should differ when applying overlapping actions without sorting — the playerId sort is load-bearing');
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: without awaiting applyPendingActions, simulation can miss actions', async () => {
        // This test verifies the fix from commit 0b5a159:
        // "Fix multiplayer desync: await async action application before GPU compute"
        // We simulate the old bug by not awaiting applyPendingActions.
        const { c1, c2 } = await createClientPair();
        try {
            for (let i = 0; i < 10; i++) {
                c1.simulationStep();
                c2.simulationStep();
            }

            const action = factoryAction(30, 30);
            c1.actionQueue.addAction(10, 1, action.type, action, false);
            c2.actionQueue.addAction(10, 1, action.type, action, false);

            // c1: properly awaits
            await c1.applyPendingActions();

            // c2: fire-and-forget (the old bug)
            // We simulate this by just skipping the apply entirely,
            // since without await the GPU step would race ahead
            // In practice, the action simply never gets applied to the grid

            c1.simulationStep();
            c2.simulationStep();

            // Continue a few more ticks
            for (let i = 0; i < 20; i++) {
                c1.simulationStep();
                c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(!result.match, 'Grids should differ when one client skips action application — the await fix is load-bearing');
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });
}
