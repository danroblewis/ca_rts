/**
 * Game - Top-level game object that owns all state and components
 *
 * This is the central orchestrator. All game state flows through here,
 * and child components receive references to what they need.
 *
 * Simulation model
 * ----------------
 * The world is a 512x512 RGBA32F grid stepped by a WebGPU compute pipeline
 * (SimulationPipeline). Player actions are never written to the grid from the
 * CPU: they are queued, scheduled for a tick, and applied by a GPU pass
 * (ActionPipeline) right before that tick is simulated. In multiplayer the
 * scheduling is done by LockstepSync so both clients apply the same actions at
 * the same ticks and the timelines stay identical (see LockstepSync.js).
 *
 * Nothing in the per-frame path waits on the GPU. The only readbacks are the
 * asynchronous state-hash exchange and the occasional factory count.
 */

import { GPU } from '../gpu/GPU.js';
import { PLAYER_1, PLAYER_2 } from '../utils/GameUtils.js';
import { initCamera } from './Camera.js';
import { GridActions } from './GridActions.js';
import { MapGenerator } from './MapGenerator.js';
import { ActionApplier } from './ActionApplier.js';
import { WinConditionManager } from './WinConditionManager.js';
import { InputHandler } from '../input/InputHandler.js';
import { GameUI } from '../ui/GameUI.js';
import { AudioManager } from '../audio/AudioManager.js';
import { CAGrid } from '../ca/CAGrid.js';
import { LockstepSync } from '../network/LockstepSync.js';
import { Logger } from '../utils/Logger.js';

export class Game {
    constructor(config) {
        // Store configuration
        this.config = config;

        // Core references (passed in from bootstrap)
        this.canvas = config.canvas;
        this.simPipeline = config.simPipeline;
        this.actionPipeline = config.actionPipeline;
        this.renderShader = config.renderShader;

        // Game state
        this.simTime = 0;
        this.currentPlayer = config.currentPlayer || PLAYER_1;
        this.isMultiplayer = false;
        this.isSpectator = config.isSpectator || false;
        this.mapSeed = config.mapSeed;

        // Factory state
        this.factoriesPlaced = 0;
        this.playerFactoryCounts = { [PLAYER_1]: 0, [PLAYER_2]: 0 };
        this.playerTotalFactoriesPlaced = { [PLAYER_1]: 0, [PLAYER_2]: 0 };
        // Local placements scheduled but not yet applied (for validation)
        this.pendingLocalFactories = 0;
        // Whether a unit_selection has been scheduled since the last clear
        this.selectionActive = false;

        // Multiplayer state
        this.connectedPlayers = new Set();
        this.waitingForSync = false;
        this.waitingForSyncStartTime = 0;
        this.targetTicksPerSecond = 60;
        this.hostId = null;

        // Rendering state
        this.performanceMode = config.performanceMode || false;
        this.showMinimap = !this.performanceMode;

        // Speed control
        this.syncWithRender = config.defaultSyncMode ?? true;

        // Lockstep bookkeeping (used in single player too, with delay 0)
        this.lockstep = new LockstepSync({
            inputDelay: 0,
            historyTicks: config.inputHistoryTicks ?? 1800
        });
        this.multiplayerInputDelay = config.inputDelay ?? 6;

        // Hash exchange
        this.hashInterval = config.hashInterval ?? 60;
        this.pendingHashReads = [];
        this.desyncDetected = false;
        this.onDesync = null;            // (tick) => void, set by NetworkManager
        this.onFramesEmitted = null;     // (frames) => void, set by NetworkManager

        // Instrumentation (read by tests / debug UI)
        this.perf = {
            ticks: 0,
            stalls: 0,
            actionPasses: 0,
            actionsApplied: 0,
            hashReads: 0,
            gpuDownloads: 0,
            snapshotsSent: 0,
            snapshotsApplied: 0,
            lastStallTick: -1
        };

        // Initialize components
        this._initializeComponents();
    }

    _initializeComponents() {
        const { gridSize, deleteRadius, firstFactoryResources } = this.config;
        console.time('🎮 Game._initializeComponents');

        // Camera
        this.camera = initCamera({
            gridSize: gridSize,
            defaultZoom: this.config.defaultZoom,
            minZoom: this.config.minZoom,
            maxZoom: this.config.maxZoom,
            zoomSpeed: this.config.zoomSpeed,
            panSpeed: this.config.panSpeed
        });
        this.camera.setCanvas(this.canvas);

        // Grid and world - ring of 8 textures (temporal AA in the renderer)
        console.time('  📦 CAGrid (8x 512x512 RGBA32F textures)');
        this.grid = new CAGrid(gridSize, gridSize);
        // Instrument downloads (they are the only GPU stalls we allow)
        const origDownload = this.grid.download.bind(this.grid);
        this.grid.download = async () => { this.perf.gpuDownloads++; return origDownload(); };
        console.timeEnd('  📦 CAGrid (8x 512x512 RGBA32F textures)');

        this.gridActions = new GridActions(gridSize);

        this.data = new Float32Array(gridSize * gridSize * 4);

        // Map generator
        this.mapGenerator = new MapGenerator(gridSize, {
            numBlobs: this.config.numBlobs,
            blobMinRadius: this.config.blobMinRadius,
            blobMaxRadius: this.config.blobMaxRadius,
            blobDensity: this.config.blobDensity,
            numWallLines: this.config.numWallLines,
            wallMinLength: this.config.wallMinLength,
            wallMaxLength: this.config.wallMaxLength,
            numWallBlobs: this.config.numWallBlobs,
            wallBlobRadius: this.config.wallBlobRadius
        });

        // CPU action applier: used for input validation and as the reference
        // implementation the GPU action pass is tested against.
        this.actionApplier = new ActionApplier({
            gridSize: gridSize,
            deleteRadius: deleteRadius,
            firstFactoryResources: firstFactoryResources,
            onStateChange: () => {}
        });

        // Audio
        this.audioManager = new AudioManager({ gridSize: gridSize });

        // Missile tracking for sound effects
        this.missileStates = new Map();
        this.hasMovingMissile = false;

        // Win condition manager
        this.winConditionManager = new WinConditionManager({
            countFactories: async () => {
                const data = await this.grid.download();
                return this.gridActions.countFactories(data);
            },
            getPlayerTotalFactoriesPlaced: () => this.playerTotalFactoriesPlaced,
            onFactoryCountsUpdated: (counts) => {
                this.playerFactoryCounts[PLAYER_1] = counts[PLAYER_1];
                this.playerFactoryCounts[PLAYER_2] = counts[PLAYER_2];
                this.gameUI?.updatePlayerIndicator();
            },
            onGameOver: (winner) => this._handleGameOver(winner),
            checkInterval: 5000
        });

        // UI (needs game reference for callbacks)
        this.gameUI = new GameUI({
            isOnGitHub: this.config.isOnGitHub,
            maxFactoriesPerPlayer: this.config.maxFactoriesPerPlayer,
            tickSyncThreshold: this.config.tickSyncDisplayThreshold,
            getCurrentPlayer: () => this.currentPlayer,
            getPlayerFactoryCount: (player) => this.playerFactoryCounts[player] || 0,
            isSpectator: () => this.isSpectator,
            isMultiplayer: () => this.isMultiplayer,
            getSimTime: () => this.simTime,
            onSwitchPlayer: (player) => this.switchPlayer(player)
        });

        // Input handler (needs game reference for callbacks)
        this.inputHandler = new InputHandler({
            canvas: this.canvas,
            camera: this.camera,
            gridSize: gridSize,
            zoomSpeed: this.config.zoomSpeed,
            deleteRadius: deleteRadius,
            onPlaceFactory: (x, y) => this.handlePlaceFactory(x, y),
            onDemolish: (x, y) => this.handleDemolish(x, y),
            onUnitCommand: (cmd) => this.handleUnitCommand(cmd),
            onClearSelection: () => this.handleClearSelection(),
            onUnitSelection: (region) => this.handleUnitSelection(region),
            onInitAudio: () => this.audioManager.init(),
            isSpectator: () => this.isSpectator,
            screenToGrid: (x, y) => this.camera.screenToGrid(x, y),
            markUnitsInRegion: (region) => this.markUnitsInRegion(region),
            clearAllSelections: () => this.clearAllSelections()
        });

        console.timeEnd('🎮 Game._initializeComponents');
    }

    // ========================================================================
    // State change handlers
    // ========================================================================

    _onActionApplied(action, playerId) {
        if (action.type === 'place_factory') {
            this.playerFactoryCounts[playerId] = (this.playerFactoryCounts[playerId] || 0) + 1;
            this.playerTotalFactoriesPlaced[playerId] = (this.playerTotalFactoriesPlaced[playerId] || 0) + 1;
            this.factoriesPlaced++;
            if (playerId === this.currentPlayer && this.pendingLocalFactories > 0) {
                this.pendingLocalFactories--;
            }
            this.gameUI?.updatePlayerIndicator();
        }
    }

    _handleGameOver(winner) {
        this.gameUI.showGameOver(winner, this.isMultiplayer, this.isSpectator, () => {
            if (this.isMultiplayer && !this.isSpectator && this.networkSync) {
                this.networkSync.requestRestart();
            } else {
                const url = new URL(window.location);
                url.searchParams.set('seed', Math.floor(Math.random() * 999999));
                window.location.href = url.toString();
            }
        });
    }

    // ========================================================================
    // Map generation
    // ========================================================================

    generateMap(seed) {
        this.mapSeed = seed;
        const result = this.mapGenerator.generate(this.data, seed);
        this.grid.upload(this.data, true);
        return result;
    }

    // ========================================================================
    // Player management
    // ========================================================================

    switchPlayer(player) {
        if (player === 1 || player === PLAYER_1) {
            this.currentPlayer = PLAYER_1;
        } else if (player === 2 || player === PLAYER_2) {
            this.currentPlayer = PLAYER_2;
        } else {
            this.currentPlayer = this.currentPlayer === PLAYER_1 ? PLAYER_2 : PLAYER_1;
        }
        console.log(`Switched to Player ${this.currentPlayer}`);
        this.gameUI.updatePlayerIndicator();
    }

    // ========================================================================
    // Selection management
    // ========================================================================

    /**
     * Count the player's units in a region and schedule a unit_selection
     * action for them. The selection bits live in the synced grid, so they
     * are only ever written through the action pipeline.
     */
    async markUnitsInRegion(region) {
        const currentData = await this.grid.download();
        const unitsMarked = this.gridActions.markUnitsInRegion(new Float32Array(currentData), region, this.currentPlayer);
        if (unitsMarked > 0) {
            this.scheduleAction({ type: 'unit_selection', region: { ...region } });
            this.selectionActive = true;
        }
        return unitsMarked;
    }

    async clearAllSelections() {
        if (!this.selectionActive) return 0;
        this.selectionActive = false;
        this.scheduleAction({ type: 'clear_selection' });
        return 0;
    }

    // ========================================================================
    // Input action handlers
    // ========================================================================

    async handlePlaceFactory(x, y) {
        if (this.isMultiplayer && this.connectedPlayers.size < 2) {
            console.log('Waiting for opponent to join');
            this.audioManager.getEngine()?.playReject();
            return false;
        }
        // While waiting for the host's snapshot the action is validated
        // against the local map and queued; it rides in our first frame.
        const currentData = await this.grid.download();

        if (!this.gridActions.canPlaceFactory(currentData, x, y)) {
            console.log('Cannot place factory - location blocked');
            this.audioManager.getEngine()?.playReject();
            return false;
        }

        const effectiveCount = (this.playerFactoryCounts[this.currentPlayer] || 0) + this.pendingLocalFactories;
        if (effectiveCount >= this.config.maxFactoriesPerPlayer) {
            console.log('Max factories reached');
            this.audioManager.getEngine()?.playReject();
            return false;
        }

        const isUnbuilt = effectiveCount > 0;
        this.pendingLocalFactories++;
        this.scheduleAction({ type: 'place_factory', x, y, isUnbuilt, factoryNumber: this.factoriesPlaced });
        return true;
    }

    async handleDemolish(x, y) {
        const currentData = await this.grid.download();
        const action = { type: 'demolish', x, y };
        // Only schedule if it would actually do something
        const modified = this.actionApplier.applyDemolish(new Float32Array(currentData), action, this.currentPlayer);
        if (modified) {
            this.scheduleAction(action);
        }
        return modified;
    }

    async handleUnitCommand(command) {
        const currentData = await this.grid.download();
        const result = this.gridActions.applyUnitCommand(
            new Float32Array(currentData), command.destX, command.destY, this.currentPlayer
        );
        if (result.total > 0) {
            this.scheduleAction({ type: 'unit_command', ...command });
            if (result.missilesLaunched > 0) {
                this.audioManager.startMissileMoving();
            }
        }
        return result.total;
    }

    handleUnitSelection(region) {
        // Selection was already scheduled by markUnitsInRegion.
    }

    handleClearSelection() {
        // clearAllSelections() schedules the clear_selection action.
    }

    // ========================================================================
    // Action scheduling
    // ========================================================================

    /**
     * Schedule an action by the local player. It is applied at the next
     * emitted input frame (immediately next tick in single player; after the
     * input delay in multiplayer) on every client.
     * @returns {number} tick the action is scheduled for
     */
    scheduleAction(action) {
        if (this.isSpectator) return -1;
        const full = { ...action, player: this.currentPlayer };
        const tick = this.lockstep.scheduleLocal(full);
        Logger.log('action', `Scheduled ${action.type} for tick ${tick}`);
        return tick;
    }

    /** Legacy name used by older call sites/tests. */
    syncAction(action) {
        return this.scheduleAction(action);
    }

    // ========================================================================
    // Simulation
    // ========================================================================

    /**
     * The input delay in effect (0 in single player).
     */
    get inputDelay() {
        return this.isMultiplayer ? this.multiplayerInputDelay : 0;
    }

    /**
     * Whether the next tick can be simulated right now (all peer inputs
     * present). Always true outside multiplayer.
     */
    canSimulate() {
        if (this.waitingForSync) return false;
        return this.lockstep.canSimulate(this.simTime);
    }

    /**
     * Simulate one tick: emit own input frame(s), apply this tick's actions
     * on the GPU, run the CA step, schedule a hash readback when due.
     * Synchronous; never waits on the GPU.
     * @returns {boolean} true if a tick was simulated
     */
    simulationStep() {
        if (this.waitingForSync) {
            // Never simulate ahead of a pending snapshot while connected: the
            // NetworkManager re-requests it. Only give up if the connection is gone.
            const connected = this.networkSync?.isConnected;
            if (!connected && performance.now() - this.waitingForSyncStartTime > this.config.syncWaitTimeout) {
                console.warn('Sync wait timeout (not connected), proceeding with local state');
                this.waitingForSync = false;
            } else {
                return false;
            }
        }

        const tick = this.simTime;

        // Emit our input frames far enough ahead for the peers. This happens
        // even when we can't simulate yet: peers may be waiting on exactly
        // these frames (two clients gating on each other must not deadlock).
        const frames = this.lockstep.emitFramesThrough(tick + this.inputDelay);
        if (frames.length && this.onFramesEmitted) {
            this.onFramesEmitted(frames);
        }

        if (!this.lockstep.canSimulate(tick)) {
            this.perf.stalls++;
            this.perf.lastStallTick = tick;
            return false;
        }

        const gpu = GPU.get();
        const encoder = gpu.createCommandEncoder('Game tick');

        // Apply this tick's actions (all players, deterministic order)
        const actions = this.lockstep.actionsForTick(tick);
        if (actions.length > 0) {
            const n = this.actionPipeline.encodeApply(encoder, this.grid.getReadTexture(), this.grid.getWriteTexture(), actions);
            if (n > 0) {
                this.grid.swap();
                this.perf.actionPasses++;
                this.perf.actionsApplied += n;
                for (const { action, playerId } of actions) this._onActionApplied(action, playerId);
            }
        }

        // CA step
        this.simPipeline.encodeStep(encoder, this.grid.getReadTexture(), this.grid.getWriteTexture(), tick);
        this.grid.swap();

        // State hash of this tick's input state, for divergence detection
        let hashRead = null;
        if (this.hashInterval > 0 && tick % this.hashInterval === 0) {
            hashRead = this.simPipeline.encodeHashReadback(encoder);
        }

        gpu.submit([encoder.finish()]);

        if (hashRead) this._collectHash(tick, hashRead);

        this.simTime = tick + 1;
        this.perf.ticks++;

        if (tick % 600 === 0) this.lockstep.gc(tick);

        return true;
    }

    _collectHash(tick, read) {
        this.perf.hashReads++;
        const p = read().then((hash) => {
            this.onLocalHash?.(tick, hash);
            const cmp = this.lockstep.recordLocalHash(tick, hash);
            this._handleHashComparison(cmp);
        }).catch((e) => console.warn('[Game] hash readback failed', e));
        this.pendingHashReads.push(p);
        if (this.pendingHashReads.length > 8) this.pendingHashReads.shift();
    }

    /** Called by NetworkManager when a peer's hash arrives. */
    receivePeerHash(playerId, tick, hash) {
        this._handleHashComparison(this.lockstep.receivePeerHash(playerId, tick, hash));
    }

    _handleHashComparison(cmp) {
        if (!cmp) return;
        if (cmp.mismatch) {
            if (!this.desyncDetected) {
                console.error(`[Game] DESYNC detected at tick ${cmp.tick}`);
            }
            this.desyncDetected = true;
            this.onDesync?.(cmp.tick);
        } else if (this.desyncDetected) {
            // Back in sync (after a snapshot resync)
            this.desyncDetected = false;
        }
    }

    // ========================================================================
    // Snapshots (join / resync)
    // ========================================================================

    /**
     * Capture the full state at the current tick boundary. The grid copy is
     * enqueued synchronously, so later ticks don't affect it; the CPU data
     * arrives asynchronously.
     * @returns {Promise<Object>} { tick, gridData, counters, frames }
     */
    async createSnapshot() {
        const tick = this.simTime;
        const gridPromise = this.grid.download();
        // Frames the receiver needs: everything from `tick` on, from all players.
        const frames = this.lockstep.allFramesSince(tick);
        const counters = {
            factoryCounts: { ...this.playerFactoryCounts },
            totalPlaced: { ...this.playerTotalFactoriesPlaced },
            factoriesPlaced: this.factoriesPlaced
        };
        const gridData = await gridPromise;
        this.perf.snapshotsSent++;
        return { tick, gridData, counters, frames };
    }

    /**
     * Replace local state with a snapshot from the host and restart lockstep
     * from its tick. Own pending (unsent) actions are preserved; own frames
     * already emitted for ticks >= snapshot tick are re-sent by the caller.
     */
    applySnapshot(snapshot) {
        const { tick, gridData, counters, frames } = snapshot;
        this.grid.upload(gridData, true);
        this.simTime = tick;
        if (counters) {
            if (counters.factoryCounts) {
                this.playerFactoryCounts[PLAYER_1] = counters.factoryCounts[PLAYER_1] || 0;
                this.playerFactoryCounts[PLAYER_2] = counters.factoryCounts[PLAYER_2] || 0;
            }
            if (counters.totalPlaced) {
                this.playerTotalFactoriesPlaced[PLAYER_1] = counters.totalPlaced[PLAYER_1] || 0;
                this.playerTotalFactoriesPlaced[PLAYER_2] = counters.totalPlaced[PLAYER_2] || 0;
            }
            if (counters.factoriesPlaced !== undefined) this.factoriesPlaced = counters.factoriesPlaced;
        }
        this.pendingLocalFactories = 0;
        // Keep what we already told the peers: frames we emitted for ticks
        // >= snapshot tick must be replayed exactly as sent, not regenerated.
        const pending = this.lockstep.pendingLocalActions;
        const emitted = this.lockstep.ownFramesSince(tick);
        this.lockstep.start(tick, this.isSpectator ? 0 : this.currentPlayer);
        for (const f of emitted) {
            this.lockstep.ownFrames.set(f.tick, f.actions);
            this.lockstep.sentThrough = Math.max(this.lockstep.sentThrough, f.tick);
        }
        this.lockstep.pendingLocalActions = pending;
        if (frames?.length) this.lockstep.importFrames(frames);
        this.desyncDetected = false;
        this.waitingForSync = false;
        this.perf.snapshotsApplied++;
        this.gameUI?.updatePlayerIndicator();
        Logger.log('sync', `Applied snapshot at tick ${tick} (${frames?.length || 0} frames)`);
    }

    // ========================================================================
    // Network sync (set externally after construction)
    // ========================================================================

    setNetworkSync(networkSync) {
        this.networkSync = networkSync;
    }

    /**
     * Enter multiplayer: switch the lockstep delay and (re)start frames at
     * the current tick for the local player.
     */
    enterMultiplayer(playerId) {
        this.isMultiplayer = true;
        if (playerId === 0) {
            // Spectator: no own inputs, gate on every player.
            this.isSpectator = true;
            this.lockstep.inputDelay = this.multiplayerInputDelay;
            this.lockstep.start(this.simTime, 0);
            return;
        }
        this.currentPlayer = playerId === 2 ? PLAYER_2 : PLAYER_1;
        this.lockstep.inputDelay = this.multiplayerInputDelay;
        this.lockstep.start(this.simTime, this.currentPlayer);
    }

    leaveMultiplayer() {
        this.isMultiplayer = false;
        this.connectedPlayers.clear();
        this.lockstep.peers.clear();
        this.lockstep.inputDelay = 0;
        this.lockstep.start(this.simTime, this.currentPlayer);
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    start() {
        this.generateMap(this.mapSeed);
        this.lockstep.start(this.simTime, this.currentPlayer);
        this.winConditionManager.start();
        this.gameUI.updatePlayerIndicator();
    }

    /** Debug/test helper: sync + perf stats in one object. */
    getSyncStats() {
        return { ...this.lockstep.getStats(), ...this.perf, tick: this.simTime, desync: this.desyncDetected };
    }
}
