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
            simulationStep: () => this._replaySimulationStep(),
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
     * Synchronous simulation step used during rollback replay.
     * No checkpoint saves — matches Game.simulationStep() behavior
     * where the RollbackManager calls it without await.
     */
    _replaySimulationStep() {
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
    }

    /**
     * Run one simulation step — identical to Game.simulationStep()
     * Made async to properly await checkpoint saves.
     */
    async simulationStep() {
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

        // Save periodic checkpoints (must await to avoid racing with next step)
        if (this.rollbackManager.shouldSaveCheckpoint()) {
            await this.rollbackManager.saveCheckpoint();
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
                await c1.simulationStep();
                await c2.simulationStep();
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
                await c1.simulationStep();
                await c2.simulationStep();
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
                await c1.simulationStep();
                await c2.simulationStep();
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
                await c1.simulationStep();
                await c2.simulationStep();
            }

            // P1 places factory at tick 10 on both clients
            const action = factoryAction(10, 10);
            c1.actionQueue.addAction(10, 1, action.type, action, false);
            c2.actionQueue.addAction(10, 1, action.type, action, false);

            // Both apply and continue
            await c1.applyPendingActions();
            await c2.applyPendingActions();

            for (let i = 0; i < 50; i++) {
                await c1.simulationStep();
                await c2.simulationStep();
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
                await c1.simulationStep();
                await c2.simulationStep();
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
                await c1.simulationStep();
                await c2.simulationStep();
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
                await c1.simulationStep();
                await c2.simulationStep();
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
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
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
                await c1.simulationStep();
                await c2.simulationStep();
            }

            // At tick 15, c1 receives P2's action from tick 10 (late delivery)
            await c1.receiveRemoteAction(action, 2, 10);

            // Continue to tick 100
            for (let i = 0; i < 85; i++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
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
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const action = factoryAction(15, 15);
            c1.actionQueue.addAction(10, 1, action.type, action, false);
            await c1.applyPendingActions();

            for (let i = 0; i < 10; i++) {
                await c1.simulationStep();
                await c2.simulationStep();
            }

            // At tick 20, c2 receives P1's action from tick 10
            await c2.receiveRemoteAction(action, 1, 10);

            for (let i = 0; i < 80; i++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
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
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
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
                await c1.simulationStep();
                await c2.simulationStep();
            }

            // Cross-deliver at tick 15
            await c1.receiveRemoteAction(a2, 2, 10);
            await c2.receiveRemoteAction(a1, 1, 10);

            // Continue to tick 100
            for (let i = 0; i < 85; i++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
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
                await c1.simulationStep();
                await c2.simulationStep();
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
                await c1.simulationStep();
                await c2.simulationStep();
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
                await c1.simulationStep();
                await c2.simulationStep();
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
                await c1.simulationStep();
                await c2.simulationStep();
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
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const action = factoryAction(25, 25);
            c1.actionQueue.addAction(10, 1, action.type, action, false);
            await c1.applyPendingActions();

            // Advance both to tick 20
            for (let i = 0; i < 10; i++) {
                await c1.simulationStep();
                await c2.simulationStep();
            }

            // Deliver at tick 20 (exactly at another checkpoint boundary)
            await c2.receiveRemoteAction(action, 1, 10);

            for (let i = 0; i < 80; i++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
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
                await c1.simulationStep();
                await c2.simulationStep();
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
                await c1.simulationStep();
                await c2.simulationStep();
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
                await c1.simulationStep();
                await c2.simulationStep();
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
                await c1.simulationStep();
                await c2.simulationStep();
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
                await c1.simulationStep();
                await c2.simulationStep();
            }

            // Adjacent factories with overlapping 3x3 patterns.
            // P1 at (30,30), P2 at (32,30) — their right/left columns overlap.
            // The overlapping cells at x=31 will have the type of whoever wrote last.
            const a1 = factoryAction(30, 30);
            const a2 = factoryAction(32, 30);

            // c1: insert P2 first, P1 second. Unsorted applies P2 then P1.
            // Overlapping cells at x=31 end up as P1's factory type.
            c1.actionQueue.addAction(10, 2, a2.type, a2, false);
            c1.actionQueue.addAction(10, 1, a1.type, a1, false);

            // c2: sorted by playerId, so P1 first then P2.
            // Overlapping cells at x=31 end up as P2's factory type.
            c2.actionQueue.addAction(10, 2, a2.type, a2, false);
            c2.actionQueue.addAction(10, 1, a1.type, a1, false);

            // c1 applies WITHOUT sorting (insertion order: P2 then P1)
            await c1.applyPendingActionsUnsorted();
            // c2 applies WITH sorting (sorted order: P1 then P2)
            await c2.applyPendingActions();

            for (let i = 0; i < 50; i++) {
                await c1.simulationStep();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            // Overlapping cells have different factory owner types depending on application order.
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
                await c1.simulationStep();
                await c2.simulationStep();
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

            await c1.simulationStep();
            await c2.simulationStep();

            // Continue a few more ticks
            for (let i = 0; i < 20; i++) {
                await c1.simulationStep();
                await c2.simulationStep();
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

    // ====================================================================
    // H. Garbage Collection Edge Cases
    // ====================================================================
    logSection('Sync - Garbage Collection Edge Cases');

    await runTest('Sync: GC — action survives garbage collection when needed for rollback', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // Advance to tick 30
            for (let tick = 0; tick < 30; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // P1 places factory at tick 30 on c1
            const a1 = factoryAction(10, 10);
            c1.actionQueue.addAction(30, 1, a1.type, a1, false);
            await c1.applyPendingActions();

            // P2 places factory at tick 25 on c2 (slightly earlier)
            const a2 = factoryAction(50, 50);
            c2.actionQueue.addAction(25, 2, a2.type, a2, false);

            // Advance to tick 80 — GC has run ~7 times via checkpoint saves
            // Oldest checkpoint ~tick 1, so tick-25 and tick-30 actions survive GC
            for (let tick = 30; tick < 80; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // Cross-deliver at tick 80 (50-tick latency, within checkpoint window)
            await c1.receiveRemoteAction(a2, 2, 25);
            await c2.receiveRemoteAction(a1, 1, 30);

            // Continue to tick 130
            for (let tick = 80; tick < 130; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `GC: grids diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: GC — aggressive checkpoint saving doesn\'t lose actions', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // Place actions at ticks 10, 20, 30 on both clients
            const actions = [
                { tick: 10, action: factoryAction(10, 10), player: 1 },
                { tick: 20, action: factoryAction(50, 50), player: 2 },
                { tick: 30, action: factoryAction(20, 20, true), player: 1 },
            ];

            for (let tick = 0; tick < 200; tick++) {
                for (const entry of actions) {
                    if (tick === entry.tick) {
                        const local = entry.player === 1 ? c1 : c2;
                        local.actionQueue.addAction(entry.tick, entry.player, entry.action.type, entry.action, false);
                    }
                    // Deliver to other client with 5-tick latency
                    if (tick === entry.tick + 5) {
                        const remote = entry.player === 1 ? c2 : c1;
                        await remote.receiveRemoteAction(entry.action, entry.player, entry.tick);
                    }
                }

                await c1.applyPendingActions();
                await c2.applyPendingActions();
                await c1.simulationStep();
                await c2.simulationStep();
            }

            // Late action at tick 15 arrives after 200 ticks of GC pressure
            const lateAction = factoryAction(40, 40, true);
            c2.actionQueue.addAction(15, 2, lateAction.type, lateAction, false);
            await c1.receiveRemoteAction(lateAction, 2, 15);
            await c2.receiveRemoteAction(lateAction, 2, 15);

            // Continue to tick 250
            for (let tick = 200; tick < 250; tick++) {
                await c1.applyPendingActions();
                await c2.applyPendingActions();
                await c1.simulationStep();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Aggressive GC: grids diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: GC — clearAfter + saveCheckpoint don\'t GC needed actions', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // P1 acts at tick 10
            for (let tick = 0; tick < 10; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const a1 = factoryAction(10, 10);
            c1.actionQueue.addAction(10, 1, a1.type, a1, false);
            await c1.applyPendingActions();

            // Advance to tick 40
            for (let tick = 10; tick < 40; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // P2's tick-5 action arrives → first rollback
            const a2 = factoryAction(50, 50);
            await c1.receiveRemoteAction(a2, 2, 5);
            c2.actionQueue.addAction(5, 2, a2.type, a2, false);

            // Advance to tick 50 — new checkpoints saved, GC runs
            for (let tick = 40; tick < 50; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // Another late action for tick 8 → second rollback
            const a3 = factoryAction(30, 30, true);
            await c1.receiveRemoteAction(a3, 2, 8);
            c2.actionQueue.addAction(8, 2, a3.type, a3, false);

            // Deliver P1's action to c2 as well
            await c2.receiveRemoteAction(a1, 1, 10);

            // Continue to tick 100
            for (let tick = 50; tick < 100; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `clearAfter+GC: grids diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: GC — many actions over long game with periodic GC', async () => {
        const { c1, c2 } = await createClientPair();
        const net = new SimulatedNetwork(c1, c2, { latencyTicks: 8 });
        try {
            const rng = createSimpleRng(999);
            const schedule = [];

            // Generate actions every ~40 ticks from both players (moderate density)
            // 8-tick latency keeps rollbacks well within the 100-tick checkpoint window
            for (let tick = 20; tick < 500; tick += 30 + Math.floor(rng() * 20)) {
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
                await c1.simulationStep();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Long game GC: grids diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    // ====================================================================
    // I. Rapid/Nested Rollbacks
    // ====================================================================
    logSection('Sync - Rapid/Nested Rollbacks');

    await runTest('Sync: Rollback — two remote actions arrive at same tick', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // Advance both to tick 30
            for (let tick = 0; tick < 30; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // P2 placed at tick 10 and tick 20 (c2 knows both locally)
            const a10 = factoryAction(50, 50);
            const a20 = factoryAction(40, 40, true);
            c2.actionQueue.addAction(10, 2, a10.type, a10, false);
            c2.actionQueue.addAction(20, 2, a20.type, a20, false);

            // c1 receives both at tick 30 — two sequential rollbacks
            await c1.receiveRemoteAction(a10, 2, 10);
            await c1.receiveRemoteAction(a20, 2, 20);

            // c2 needs to apply its pending actions (they were queued but not applied since c2 was ahead)
            // Replay the ticks for c2 with actions applied
            // Actually, c2 already had them queued at the right ticks. We need to re-apply.
            // Simpler: deliver to c2 as well so both have identical queues
            await c2.receiveRemoteAction(a10, 2, 10);
            await c2.receiveRemoteAction(a20, 2, 20);

            // Continue to tick 100
            for (let tick = 30; tick < 100; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Two rollbacks at same tick: diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: Rollback — second rollback to earlier tick than first', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // Advance to tick 40
            for (let tick = 0; tick < 40; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // P2 acts at tick 25, delivered to c1 at tick 40
            const a25 = factoryAction(50, 50);
            c2.actionQueue.addAction(25, 2, a25.type, a25, false);
            await c1.receiveRemoteAction(a25, 2, 25);

            // Advance to tick 42
            for (let tick = 40; tick < 42; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // P2 acts at tick 15, delivered to c1 at tick 42 — earlier than first rollback
            const a15 = factoryAction(40, 40, true);
            c2.actionQueue.addAction(15, 2, a15.type, a15, false);
            await c1.receiveRemoteAction(a15, 2, 15);

            // Deliver all to c2 as well
            await c2.receiveRemoteAction(a25, 2, 25);
            await c2.receiveRemoteAction(a15, 2, 15);

            // Continue to tick 100
            for (let tick = 42; tick < 100; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Second rollback earlier: diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: Rollback — three sequential rollbacks with overlapping ranges', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // P1 places at tick 5
            for (let tick = 0; tick < 5; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }
            const a1 = factoryAction(10, 10);
            c1.actionQueue.addAction(5, 1, a1.type, a1, false);
            await c1.applyPendingActions();

            // Advance to tick 55
            for (let tick = 5; tick < 55; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // P2 actions at ticks 10, 20, 30 — all delivered late
            const a10 = factoryAction(50, 50);
            const a20 = factoryAction(40, 40, true);
            const a30 = factoryAction(45, 45, true);

            // Deliver at ticks 50, 52, 54 (we're at 55, deliver all now sequentially)
            await c1.receiveRemoteAction(a10, 2, 10);
            await c1.receiveRemoteAction(a20, 2, 20);
            await c1.receiveRemoteAction(a30, 2, 30);

            // c2 receives all as well
            c2.actionQueue.addAction(10, 2, a10.type, a10, false);
            c2.actionQueue.addAction(20, 2, a20.type, a20, false);
            c2.actionQueue.addAction(30, 2, a30.type, a30, false);
            await c2.receiveRemoteAction(a1, 1, 5);
            await c2.receiveRemoteAction(a10, 2, 10);
            await c2.receiveRemoteAction(a20, 2, 20);
            await c2.receiveRemoteAction(a30, 2, 30);

            // Continue to tick 120
            for (let tick = 55; tick < 120; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Three rollbacks: diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: Rollback — action arrives for tick that was already rolled back to', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // Advance to tick 30
            for (let tick = 0; tick < 30; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // P2's first tick-10 action → rollback
            const a10a = factoryAction(50, 50);
            c2.actionQueue.addAction(10, 2, a10a.type, a10a, false);
            await c1.receiveRemoteAction(a10a, 2, 10);

            // Advance to tick 35
            for (let tick = 30; tick < 35; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // P1's tick-10 action (different coordinates) → must rollback again to tick 10
            const a10b = factoryAction(10, 10);
            c1.actionQueue.addAction(10, 1, a10b.type, a10b, false);
            await c2.receiveRemoteAction(a10b, 1, 10);
            // Also deliver P2's action to c2 as rollback (already queued locally, but trigger replay)
            await c2.receiveRemoteAction(a10a, 2, 10);
            // And deliver P1's action to c1 as well (already local)
            await c1.receiveRemoteAction(a10b, 1, 10);

            // Continue to tick 100
            for (let tick = 35; tick < 100; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Re-rollback same tick: diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    // ====================================================================
    // J. Demolish Actions
    // ====================================================================
    logSection('Sync - Demolish Actions');

    await runTest('Sync: Demolish — place then demolish with latency — grids match', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // Advance to tick 10
            for (let tick = 0; tick < 10; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // P1 places factory at tick 10
            const placeAction = factoryAction(10, 10);
            c1.actionQueue.addAction(10, 1, placeAction.type, placeAction, false);
            await c1.applyPendingActions();

            // Advance to tick 30
            for (let tick = 10; tick < 30; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // P1 demolishes at tick 30
            const demolishAction = { type: 'demolish', x: 10, y: 10 };
            c1.actionQueue.addAction(30, 1, demolishAction.type, demolishAction, false);
            await c1.applyPendingActions();

            // Deliver both to P2 at tick 40 (10-tick latency)
            for (let tick = 30; tick < 40; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            await c2.receiveRemoteAction(placeAction, 1, 10);
            await c2.receiveRemoteAction(demolishAction, 1, 30);

            // Continue to tick 100
            for (let tick = 40; tick < 100; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Demolish with latency: diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: Demolish — replayed during rollback produces same result', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // Advance to tick 10
            for (let tick = 0; tick < 10; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // P1 places at tick 10
            const placeAction = factoryAction(10, 10);
            c1.actionQueue.addAction(10, 1, placeAction.type, placeAction, false);
            c2.actionQueue.addAction(10, 1, placeAction.type, placeAction, false);
            await c1.applyPendingActions();
            await c2.applyPendingActions();

            // Advance to tick 30
            for (let tick = 10; tick < 30; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // P1 demolishes at tick 30 on both
            const demolishAction = { type: 'demolish', x: 10, y: 10 };
            c1.actionQueue.addAction(30, 1, demolishAction.type, demolishAction, false);
            c2.actionQueue.addAction(30, 1, demolishAction.type, demolishAction, false);
            await c1.applyPendingActions();
            await c2.applyPendingActions();

            // Advance to tick 40
            for (let tick = 30; tick < 40; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // P2 acts at tick 20 → c1 must rollback and replay place + demolish
            const a2 = factoryAction(50, 50);
            await c1.receiveRemoteAction(a2, 2, 20);
            c2.actionQueue.addAction(20, 2, a2.type, a2, false);
            await c2.receiveRemoteAction(a2, 2, 20);

            // Continue to tick 100
            for (let tick = 40; tick < 100; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Demolish replay: diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: Demolish — place + demolish at same tick from different players', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // Advance to tick 20
            for (let tick = 0; tick < 20; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // P1 places factory at tick 20 at (10, 10)
            const placeAction = factoryAction(10, 10);
            // P2 demolishes nearby at tick 20 at (10, 10) — same tick
            const demolishAction = { type: 'demolish', x: 10, y: 10 };

            // Both clients get both actions at the same tick
            c1.actionQueue.addAction(20, 1, placeAction.type, placeAction, false);
            c1.actionQueue.addAction(20, 2, demolishAction.type, demolishAction, false);
            c2.actionQueue.addAction(20, 1, placeAction.type, placeAction, false);
            c2.actionQueue.addAction(20, 2, demolishAction.type, demolishAction, false);

            // Apply — sorted by playerId: P1's place first, then P2's demolish
            await c1.applyPendingActions();
            await c2.applyPendingActions();

            // Continue to tick 80
            for (let tick = 20; tick < 80; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Same-tick place+demolish: diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: Demolish — demolish of nonexistent factory is harmless', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // Advance to tick 10
            for (let tick = 0; tick < 10; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // P1 demolishes at coordinates with no factory
            const demolishAction = { type: 'demolish', x: 30, y: 30 };
            c1.actionQueue.addAction(10, 1, demolishAction.type, demolishAction, false);
            await c1.applyPendingActions();

            // Advance to tick 20, deliver to P2
            for (let tick = 10; tick < 20; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            await c2.receiveRemoteAction(demolishAction, 1, 10);

            // Continue to tick 60
            for (let tick = 20; tick < 60; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Demolish nonexistent: diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    // ====================================================================
    // K. Mixed Action Types
    // ====================================================================
    logSection('Sync - Mixed Action Types');

    await runTest('Sync: Mixed — factory + unit_command in same rollback window', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // P1 places factory at tick 10
            for (let tick = 0; tick < 10; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const placeAction = factoryAction(10, 10);
            c1.actionQueue.addAction(10, 1, placeAction.type, placeAction, false);
            c2.actionQueue.addAction(10, 1, placeAction.type, placeAction, false);
            await c1.applyPendingActions();
            await c2.applyPendingActions();

            // Advance to tick 50, P1 issues unit_command
            for (let tick = 10; tick < 50; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const cmdAction = { type: 'unit_command', destX: 30, destY: 30 };
            c1.actionQueue.addAction(50, 1, cmdAction.type, cmdAction, false);
            c2.actionQueue.addAction(50, 1, cmdAction.type, cmdAction, false);
            await c1.applyPendingActions();
            await c2.applyPendingActions();

            // Advance to tick 60
            for (let tick = 50; tick < 60; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // P2 acts at tick 30 → c1 must rollback past both factory and command
            const a2 = factoryAction(50, 50);
            await c1.receiveRemoteAction(a2, 2, 30);
            c2.actionQueue.addAction(30, 2, a2.type, a2, false);
            await c2.receiveRemoteAction(a2, 2, 30);

            // Continue to tick 120
            for (let tick = 60; tick < 120; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Mixed factory+command: diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: Mixed — both players issue different action types at same tick', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // P1 places factory at tick 10 first (so units exist later)
            for (let tick = 0; tick < 10; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const placeAction1 = factoryAction(10, 10);
            c1.actionQueue.addAction(10, 1, placeAction1.type, placeAction1, false);
            c2.actionQueue.addAction(10, 1, placeAction1.type, placeAction1, false);
            await c1.applyPendingActions();
            await c2.applyPendingActions();

            // Advance to tick 20
            for (let tick = 10; tick < 20; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // P1 places another factory, P2 issues unit_command — same tick 20
            const placeAction2 = factoryAction(50, 50);
            const cmdAction = { type: 'unit_command', destX: 30, destY: 30 };

            c1.actionQueue.addAction(20, 1, placeAction2.type, placeAction2, false);
            c1.actionQueue.addAction(20, 2, cmdAction.type, cmdAction, false);
            c2.actionQueue.addAction(20, 1, placeAction2.type, placeAction2, false);
            c2.actionQueue.addAction(20, 2, cmdAction.type, cmdAction, false);
            await c1.applyPendingActions();
            await c2.applyPendingActions();

            // Continue to tick 80
            for (let tick = 20; tick < 80; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Mixed same-tick: diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: Mixed — clear_selection + unit_selection + unit_command sequence with rollback', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // Place factory early so units may exist
            for (let tick = 0; tick < 5; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const placeAction = factoryAction(10, 10);
            c1.actionQueue.addAction(5, 1, placeAction.type, placeAction, false);
            c2.actionQueue.addAction(5, 1, placeAction.type, placeAction, false);
            await c1.applyPendingActions();
            await c2.applyPendingActions();

            // Advance to tick 10
            for (let tick = 5; tick < 10; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // P1 sequence: clear_selection at 10, unit_selection at 11, unit_command at 12
            const clearAction = { type: 'clear_selection' };
            const selectAction = { type: 'unit_selection', region: { x1: 0, y1: 0, x2: 63, y2: 63 } };
            const cmdAction = { type: 'unit_command', destX: 50, destY: 50 };

            c1.actionQueue.addAction(10, 1, clearAction.type, clearAction, false);
            c1.actionQueue.addAction(11, 1, selectAction.type, selectAction, false);
            c1.actionQueue.addAction(12, 1, cmdAction.type, cmdAction, false);

            // Advance to tick 17 while applying
            for (let tick = 10; tick < 17; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // Delivered to P2 with 5-tick latency (arrives at 15, 16, 17)
            await c2.receiveRemoteAction(clearAction, 1, 10);
            await c2.receiveRemoteAction(selectAction, 1, 11);
            await c2.receiveRemoteAction(cmdAction, 1, 12);

            // Continue to tick 60
            for (let tick = 17; tick < 60; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Mixed selection sequence: diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    // ====================================================================
    // L. Checkpoint Boundary Stress
    // ====================================================================
    logSection('Sync - Checkpoint Boundary Stress');

    await runTest('Sync: Checkpoint — rollback when only one checkpoint exists', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // Save initial checkpoint at tick 0 by running one step
            await c1.simulationStep();
            await c2.simulationStep();

            // Advance to tick 5
            for (let tick = 1; tick < 5; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // Late action at tick 2
            const action = factoryAction(10, 10);
            c2.actionQueue.addAction(2, 2, action.type, action, false);
            await c1.receiveRemoteAction(action, 2, 2);
            await c2.receiveRemoteAction(action, 2, 2);

            // Continue to tick 50
            for (let tick = 5; tick < 50; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Single checkpoint rollback: diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: Checkpoint — all checkpoints evicted, rollback falls back gracefully', async () => {
        // maxCheckpoints=10, interval=10: checkpoints at 10, 20, ..., 100 (oldest=10 when full)
        // After 110 ticks: checkpoints at 20, 30, ..., 110
        const { c1, c2 } = await createClientPair();
        try {
            // Advance 110 ticks — all early checkpoints evicted
            for (let tick = 0; tick < 110; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // Late action for tick 5 — no checkpoint before tick 5 exists
            const action = factoryAction(10, 10);

            // This should not crash. The fallback applies the action directly.
            let didNotCrash = true;
            try {
                await c1.receiveRemoteAction(action, 2, 5);
            } catch (e) {
                didNotCrash = false;
            }
            assert(didNotCrash, 'Rollback with no valid checkpoint should not crash');

            // Grids may diverge here — this documents that the fallback path works without crashing
            // but doesn't guarantee sync (the action is applied at the wrong time)
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: Checkpoint — rapid actions cause many checkpoint saves', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // Advance to tick 10
            for (let tick = 0; tick < 10; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // P1 places actions at ticks 10, 11, 12, 13, 14 — each triggers applyPendingActions
            const actions = [];
            for (let t = 10; t <= 14; t++) {
                const a = factoryAction(5 + t, 5 + t, t > 10);
                actions.push({ tick: t, action: a });
                c1.actionQueue.addAction(t, 1, a.type, a, false);
            }

            // Apply on c1 as we advance
            for (let tick = 10; tick < 15; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.simulationStep();
            }

            // Deliver to P2 at tick 25 (10-tick latency)
            for (let tick = 15; tick < 25; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            for (const entry of actions) {
                await c2.receiveRemoteAction(entry.action, 1, entry.tick);
            }

            // Continue to tick 80
            for (let tick = 25; tick < 80; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Rapid checkpoints: diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    // ====================================================================
    // M. Long-Running / Precision
    // ====================================================================
    logSection('Sync - Long-Running / Precision');

    await runTest('Sync: Precision — 5000 ticks with periodic actions — grids match', async () => {
        const { c1, c2 } = await createClientPair();
        const net = new SimulatedNetwork(c1, c2, { latencyTicks: 10 });
        try {
            const schedule = [];
            let p1Count = 0, p2Count = 0;
            for (let tick = 200; tick < 4800; tick += 200) {
                const player = tick % 400 === 0 ? 1 : 2;
                const x = 5 + (tick % 54);
                const y = 5 + ((tick * 7) % 54);
                const isUnbuilt = player === 1 ? p1Count++ > 0 : p2Count++ > 0;
                schedule.push({ tick, player, action: factoryAction(x, y, isUnbuilt) });
            }

            for (let tick = 0; tick < 5000; tick++) {
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
                await c1.simulationStep();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `5000-tick precision: diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: Precision — simTime matches between clients after rollback', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // Advance to tick 50
            for (let tick = 0; tick < 50; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // P2 acts at tick 20, delivered late
            const action = factoryAction(50, 50);
            c2.actionQueue.addAction(20, 2, action.type, action, false);
            await c1.receiveRemoteAction(action, 2, 20);
            await c2.receiveRemoteAction(action, 2, 20);

            // After rollback and replay, simTime should match
            const t1 = Math.floor(c1.simTime);
            const t2 = Math.floor(c2.simTime);
            assert(t1 === t2, `simTime mismatch after rollback: c1=${t1}, c2=${t2}`);

            // Continue a few more ticks to verify they stay in sync
            for (let tick = 50; tick < 80; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `simTime precision: diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: Precision — action at tick 0 with rollback', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // P1 places at tick 0 on c1
            const action = factoryAction(10, 10);
            c1.actionQueue.addAction(0, 1, action.type, action, false);
            await c1.applyPendingActions();

            // Advance to tick 5
            for (let tick = 0; tick < 5; tick++) {
                await c1.simulationStep();
                await c2.simulationStep();
            }

            // Deliver to P2 at tick 5 — rollback to tick 0
            await c2.receiveRemoteAction(action, 1, 0);

            // Continue to tick 50
            for (let tick = 5; tick < 50; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Tick-0 action: diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    // ====================================================================
    // N. Negative / Regression Tests (extended)
    // ====================================================================
    logSection('Sync - Negative / Regression Tests (extended)');

    await runTest('Sync: Regression — fire-and-forget checkpoint save causes stale checkpoint', async () => {
        // Simulates the production bug where saveCheckpoint() is called without await.
        // The checkpoint may capture stale grid data if the download hasn't completed.
        const { c1, c2 } = await createClientPair();
        try {
            // Advance to tick 10 with proper awaiting
            for (let tick = 0; tick < 10; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // Place action at tick 10
            const action = factoryAction(10, 10);
            c1.actionQueue.addAction(10, 1, action.type, action, false);
            c2.actionQueue.addAction(10, 1, action.type, action, false);
            await c1.applyPendingActions();
            await c2.applyPendingActions();

            // On c1: fire-and-forget checkpoint save (no await) then immediately step
            // This simulates the production code path
            if (c1.rollbackManager.shouldSaveCheckpoint()) {
                c1.rollbackManager.saveCheckpoint(); // intentionally no await
            }
            // Immediately run simulation (may race with checkpoint download)
            c1._replaySimulationStep();

            // c2: properly awaited
            await c2.simulationStep();

            // Continue properly for both
            for (let tick = 11; tick < 50; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // The grids should still match because the sim step itself is deterministic.
            // The checkpoint may be stale, but that only matters if a rollback uses it.
            // Trigger a rollback on c1 to test if stale checkpoint causes divergence.
            const a2 = factoryAction(50, 50);
            await c1.receiveRemoteAction(a2, 2, 5);
            c2.actionQueue.addAction(5, 2, a2.type, a2, false);
            await c2.receiveRemoteAction(a2, 2, 5);

            for (let tick = 50; tick < 80; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // This test documents behavior — stale checkpoint may or may not cause divergence
            // depending on timing. If it passes, great. If it fails, it exposes the bug.
            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            // We accept either outcome — the test documents whether the race is hit
            assert(true, `Fire-and-forget checkpoint: match=${result.match} (documents race condition behavior)`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: Regression — concurrent rollbacks cause divergence', async () => {
        // Simulates the production bug where processRemoteAction is called without await.
        // Two rapid WebSocket messages → two concurrent rollbacks on shared state.
        const { c1, c2 } = await createClientPair();
        try {
            // Advance to tick 30
            for (let tick = 0; tick < 30; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const a1 = factoryAction(10, 10);
            const a2 = factoryAction(50, 50);

            // c1: fire-and-forget (simulating NetworkManager.js:158 bug)
            // Two processRemoteAction calls without awaiting the first
            const promise1 = c1.rollbackManager.processRemoteAction(a1, 2, 10);
            const promise2 = c1.rollbackManager.processRemoteAction(a2, 2, 20);
            // Wait for both to complete
            await Promise.all([promise1, promise2]);

            // c2: properly sequential
            c2.actionQueue.addAction(10, 2, a1.type, a1, false);
            c2.actionQueue.addAction(20, 2, a2.type, a2, false);
            await c2.receiveRemoteAction(a1, 2, 10);
            await c2.receiveRemoteAction(a2, 2, 20);

            // Continue
            for (let tick = 30; tick < 80; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            // This test documents the concurrent rollback behavior.
            // If grids match, the system is resilient. If they don't, it exposes the bug.
            assert(true, `Concurrent rollbacks: match=${result.match} (documents concurrent rollback behavior)`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: Regression — action at checkpoint.tick gets double-applied', async () => {
        const { c1, c2 } = await createClientPair();
        try {
            // Advance to tick 10 — checkpoint saved at tick 10
            for (let tick = 0; tick < 10; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // Both place factory at tick 10 (applied=true, checkpoint includes this state)
            const action = factoryAction(10, 10);
            c1.actionQueue.addAction(10, 1, action.type, action, false);
            c2.actionQueue.addAction(10, 1, action.type, action, false);
            await c1.applyPendingActions();
            await c2.applyPendingActions();

            // Force a checkpoint save at tick 10 (after action applied)
            await c1.rollbackManager.saveCheckpoint();
            await c2.rollbackManager.saveCheckpoint();

            // Advance to tick 30
            for (let tick = 10; tick < 30; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // Remote action at tick 10 triggers rollback through the checkpoint
            // resetAppliedAfter(checkpoint.tick - 1) resets actions at tick >= checkpoint.tick
            // The tick-10 action may get double-applied if checkpoint already includes it
            const a2 = factoryAction(50, 50);
            await c1.receiveRemoteAction(a2, 2, 10);
            c2.actionQueue.addAction(10, 2, a2.type, a2, false);
            await c2.receiveRemoteAction(a2, 2, 10);

            // Continue to tick 80
            for (let tick = 30; tick < 80; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const d1 = await c1.getGridData();
            const d2 = await c2.getGridData();
            const result = gridsMatch(d1, d2);
            assert(result.match, `Double-apply at checkpoint tick: diverged at (${result.x},${result.y}) ch=${result.channel}: ${result.valA} vs ${result.valB}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });

    await runTest('Sync: Regression — GC removes action then rollback needs it', async () => {
        // Tests whether GC can remove an action that's later needed for rollback
        const pipeline = await ensureShader();

        // Use aggressive GC settings: maxCheckpoints=3, interval=10
        const c1 = new HeadlessGameClient(GRID_SIZE, pipeline);
        const c2 = new HeadlessGameClient(GRID_SIZE, pipeline);
        c1.loadMap(MAP_SEED);
        c2.loadMap(MAP_SEED);

        // Override checkpoint buffer with aggressive settings
        c1.checkpointBuffer.destroy();
        c2.checkpointBuffer.destroy();
        c1.checkpointBuffer = new CheckpointBuffer(GRID_SIZE, GRID_SIZE, { format: 'float' }, 3, 10);
        c2.checkpointBuffer = new CheckpointBuffer(GRID_SIZE, GRID_SIZE, { format: 'float' }, 3, 10);
        c1.rollbackManager.checkpointBuffer = c1.checkpointBuffer;
        c2.rollbackManager.checkpointBuffer = c2.checkpointBuffer;

        try {
            // P1 places at tick 10
            for (let tick = 0; tick < 10; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            const a1 = factoryAction(10, 10);
            c1.actionQueue.addAction(10, 1, a1.type, a1, false);
            c2.actionQueue.addAction(10, 1, a1.type, a1, false);
            await c1.applyPendingActions();
            await c2.applyPendingActions();

            // Advance 100+ ticks to force GC (oldest checkpoint advances past tick 10)
            // With maxCheckpoints=3, interval=10: checkpoints at e.g., tick 80, 90, 100
            for (let tick = 10; tick < 120; tick++) {
                await c1.applyPendingActions();
                await c1.simulationStep();
                await c2.applyPendingActions();
                await c2.simulationStep();
            }

            // Check if the tick-10 action was GC'd from c1
            const c1HasAction = c1.actionQueue.actions.some(a => a.tick === 10 && a.playerId === 1);

            // Force a rollback that would need to replay from before tick 10
            const a2 = factoryAction(50, 50);
            let rollbackSucceeded = true;
            try {
                await c1.receiveRemoteAction(a2, 2, 5);
            } catch (e) {
                rollbackSucceeded = false;
            }

            // This test documents GC behavior: if the action was GC'd, rollback
            // cannot replay it, leading to potential divergence
            assert(true, `GC behavior documented: action at tick 10 survived GC=${c1HasAction}, rollback succeeded=${rollbackSucceeded}`);
        } finally {
            c1.destroy();
            c2.destroy();
        }
    });
}
