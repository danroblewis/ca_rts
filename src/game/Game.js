/**
 * Game - Top-level game object that owns all state and components
 * 
 * This is the central orchestrator. All game state flows through here,
 * and child components receive references to what they need.
 */

import { GPU } from '../gpu/GPU.js';
import { PLAYER_1, PLAYER_2 } from '../utils/GameUtils.js';
import { initCamera } from './Camera.js';
import { GridActions } from './GridActions.js';
import { MapGenerator } from './MapGenerator.js';
import { ActionApplier } from './ActionApplier.js';
import { RollbackManager } from './RollbackManager.js';
import { WinConditionManager } from './WinConditionManager.js';
import { InputHandler } from '../input/InputHandler.js';
import { GameUI } from '../ui/GameUI.js';
import { AudioManager } from '../audio/AudioManager.js';
import { CAGrid } from '../ca/CAGrid.js';
import { CheckpointBuffer } from '../gpu/CheckpointBuffer.js';
import { ActionQueue } from '../network/ActionQueue.js';

export class Game {
    constructor(config) {
        // Store configuration
        this.config = config;
        
        // Core references (passed in from bootstrap)
        this.canvas = config.canvas;
        this.simShader = config.simShader;
        this.renderShader = config.renderShader;

        // Uniform buffer for simulation params: resolution(vec2f) + time(f32) + _pad(f32) = 16 bytes
        const gpu = GPU.get();
        this.simUniformBuffer = gpu.createUniformBuffer(16, 'SimParams');
        
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
        
        // Multiplayer state
        this.connectedPlayers = new Set();
        this.waitingForSync = false;
        this.waitingForSyncStartTime = 0;
        this.targetTicksPerSecond = 60;
        
        // Rendering state
        this.performanceMode = config.performanceMode || false;
        this.showMinimap = !this.performanceMode;
        
        // Speed control
        this.syncWithRender = config.defaultSyncMode ?? true;
        
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
        
        // Grid and world - creates 8 textures + framebuffers
        console.time('  📦 CAGrid (8x 512x512 RGBA32F textures)');
        this.grid = new CAGrid(gridSize, gridSize);
        console.timeEnd('  📦 CAGrid (8x 512x512 RGBA32F textures)');
        
        this.gridActions = new GridActions(gridSize);
        
        console.time('  📦 Float32Array data buffer');
        this.data = new Float32Array(gridSize * gridSize * 4);
        console.timeEnd('  📦 Float32Array data buffer');
        
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
        
        // Action applier
        this.actionApplier = new ActionApplier({
            gridSize: gridSize,
            deleteRadius: deleteRadius,
            firstFactoryResources: firstFactoryResources,
            onStateChange: (changes) => this._handleStateChange(changes)
        });
        
        // Rollback netcode - creates more textures for checkpoints
        console.time('  📦 CheckpointBuffer (30x checkpoints)');
        this.checkpointBuffer = new CheckpointBuffer(
            gridSize, gridSize,
            { format: 'float' },
            this.config.maxCheckpoints,
            this.config.checkpointInterval
        );
        console.timeEnd('  📦 CheckpointBuffer (30x checkpoints)');
        
        this.actionQueue = new ActionQueue();
        
        // RollbackManager (initialized with callbacks that reference this)
        // NOTE: getGridData is async (WebGPU texture download)
        this.rollbackManager = new RollbackManager({
            checkpointBuffer: this.checkpointBuffer,
            actionQueue: this.actionQueue,
            getGridData: async () => await this.grid.download(),
            uploadGridData: (data) => this.grid.uploadCurrent(data),
            getCurrentTick: () => Math.floor(this.simTime),
            setTick: (tick) => { this.simTime = tick; },
            simulationStep: () => this.simulationStep(),
            applyAction: (action, playerId) => this.applyAction(action, playerId)
        });
        
        // Audio
        this.audioManager = new AudioManager({ gridSize: gridSize });
        
        // Missile tracking for sound effects
        this.missileStates = new Map();  // Map of position key to state
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
    
    _handleStateChange(changes) {
        if (changes.factoryPlaced) {
            const { player } = changes.factoryPlaced;
            this.playerFactoryCounts[player]++;
            this.playerTotalFactoriesPlaced[player]++;
            this.factoriesPlaced++;
            this.gameUI?.updatePlayerIndicator();
        }
        if (changes.factoriesFreed) {
            for (const [owner, count] of Object.entries(changes.factoriesFreed)) {
                this.playerFactoryCounts[owner] = Math.max(0, this.playerFactoryCounts[owner] - count);
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
    
    async markUnitsInRegion(region) {
        const currentData = await this.grid.download();
        const unitsMarked = this.gridActions.markUnitsInRegion(currentData, region, this.currentPlayer);
        if (unitsMarked > 0) {
            this.grid.upload(currentData);
        }
        return unitsMarked;
    }

    async clearAllSelections() {
        const currentData = await this.grid.download();
        const unitsCleared = this.gridActions.clearAllSelections(currentData, this.currentPlayer);
        if (unitsCleared > 0) {
            this.grid.upload(currentData);
        }
        return unitsCleared;
    }
    
    // ========================================================================
    // Input action handlers
    // ========================================================================
    
    async handlePlaceFactory(x, y) {
        const currentData = await this.grid.download();

        // Validation
        if (this.isMultiplayer && this.connectedPlayers.size < 2) {
            console.log('Waiting for opponent to join');
            this.audioManager.getEngine()?.playReject();
            return;
        }

        if (!this.gridActions.canPlaceFactory(currentData, x, y)) {
            console.log('Cannot place factory - location blocked');
            this.audioManager.getEngine()?.playReject();
            return;
        }

        if (this.playerFactoryCounts[this.currentPlayer] >= this.config.maxFactoriesPerPlayer) {
            console.log('Max factories reached');
            this.audioManager.getEngine()?.playReject();
            return;
        }

        const isUnbuilt = this.playerFactoryCounts[this.currentPlayer] > 0;
        const action = { type: 'place_factory', x, y, isUnbuilt };

        if (this.isMultiplayer && this.networkSync?.isConnected) {
            // MULTIPLAYER: Queue action for safe application by applyPendingActions()
            // Do NOT modify GPU here — avoids race with rollback
            const fullAction = { ...action, player: this.currentPlayer, factoryNumber: this.factoriesPlaced };
            const tick = Math.floor(this.simTime);
            this.actionQueue.addAction(tick, this.currentPlayer, action.type, fullAction, false);
            this.networkSync.sendAction(fullAction, tick);
        } else {
            // SINGLE-PLAYER: Apply directly (no rollback race possible)
            this.actionApplier.applyPlaceFactory(currentData, action, this.currentPlayer);
            this.grid.upload(currentData);
        }
    }

    async handleDemolish(x, y) {
        const currentData = await this.grid.download();
        const action = { type: 'demolish', x, y };

        const modified = this.actionApplier.applyDemolish(currentData, action, this.currentPlayer);
        if (modified) {
            if (this.isMultiplayer && this.networkSync?.isConnected) {
                const fullAction = { ...action, player: this.currentPlayer };
                const tick = Math.floor(this.simTime);
                this.actionQueue.addAction(tick, this.currentPlayer, action.type, fullAction, false);
                this.networkSync.sendAction(fullAction, tick);
            } else {
                this.grid.upload(currentData);
            }
        }
    }

    async handleUnitCommand(command) {
        const activeCommand = { ...command, player: this.currentPlayer };

        const currentData = await this.grid.download();
        const result = this.gridActions.applyUnitCommand(
            currentData, command.destX, command.destY, this.currentPlayer
        );

        if (result.total > 0) {
            if (this.isMultiplayer && this.networkSync?.isConnected) {
                const fullAction = { type: 'unit_command', ...activeCommand };
                const tick = Math.floor(this.simTime);
                this.actionQueue.addAction(tick, this.currentPlayer, fullAction.type, fullAction, false);
                this.networkSync.sendAction(fullAction, tick);
            } else {
                this.grid.upload(currentData);
            }

            // Play missile moving sound if missiles were launched
            if (result.missilesLaunched > 0) {
                this.audioManager.startMissileMoving();
            }
        }
    }
    
    handleUnitSelection(region) {
        if (this.isMultiplayer && this.networkSync?.isConnected) {
            this.syncAction({ type: 'unit_selection', player: this.currentPlayer, region });
        }
    }
    
    handleClearSelection() {
        if (this.isMultiplayer && this.networkSync?.isConnected) {
            this.syncAction({ type: 'clear_selection', player: this.currentPlayer });
        }
    }
    
    // ========================================================================
    // Action application (for network replay)
    // ========================================================================
    
    async applyAction(action, playerId) {
        const currentData = await this.grid.download();
        const modified = this.actionApplier.applyAction(currentData, action, playerId);
        if (modified) {
            this.grid.uploadCurrent(currentData);
        }
        return modified;
    }
    
    syncAction(action) {
        if (this.isMultiplayer && this.networkSync?.isConnected) {
            this.rollbackManager.storeLocalAction(action, this.currentPlayer);
            this.networkSync.sendAction(action, Math.floor(this.simTime));
        }
    }
    
    // ========================================================================
    // Simulation
    // ========================================================================

    /**
     * Apply pending actions from the action queue before the next simulation step.
     * Must be called (and awaited) before simulationStep() in multiplayer.
     * Downloads grid once, applies all actions, uploads once.
     */
    async applyPendingActions() {
        if (!this.isMultiplayer) return;

        const tick = Math.floor(this.simTime);
        // Find ALL unapplied actions at or before current tick
        // (catches local actions queued slightly late)
        const unapplied = this.actionQueue.actions.filter(a => a.tick <= tick && !a.applied);

        if (unapplied.length === 0) return;

        // Download grid data once
        const currentData = await this.grid.download();

        // Save checkpoint BEFORE actions (using same downloaded data)
        this.checkpointBuffer.saveCheckpoint(tick, new Float32Array(currentData));

        // Sort by tick then playerId for deterministic ordering
        unapplied.sort((a, b) => a.tick - b.tick || a.playerId - b.playerId);

        // Apply all actions to the single downloaded buffer
        for (const action of unapplied) {
            this.actionApplier.applyAction(currentData, action.data, action.playerId);
            action.applied = true;
        }

        // Single upload back to GPU
        this.grid.uploadCurrent(currentData);
    }

    async simulationStep() {
        // Wait for sync in multiplayer
        if (this.waitingForSync) {
            if (performance.now() - this.waitingForSyncStartTime > this.config.syncWaitTimeout) {
                console.warn('Sync wait timeout, proceeding with local state');
                this.waitingForSync = false;
            } else {
                return;
            }
        }

        // Run GPU compute simulation step
        const gpu = GPU.get();
        const readTex = this.grid.getReadTexture();
        const writeTex = this.grid.getWriteTexture();

        // Update uniform buffer: [resX, resY, time, pad]
        const params = new Float32Array([
            this.config.gridSize, this.config.gridSize, this.simTime, 0
        ]);
        gpu.writeBuffer(this.simUniformBuffer, params);

        // Create bind group matching mining_game.wgsl bindings
        const bindGroup = this.simShader.createBindGroup([
            { binding: 0, resource: readTex.view },
            { binding: 1, resource: writeTex.view },
            { binding: 2, resource: { buffer: this.simUniformBuffer } }
        ]);

        // Dispatch compute shader with 8x8 workgroups
        const workgroups = Math.ceil(this.config.gridSize / 8);
        this.simShader.dispatch(bindGroup, workgroups, workgroups);

        this.grid.swap();
        this.simTime += 1.0;

        // Save checkpoint periodically
        if (this.isMultiplayer && this.rollbackManager.shouldSaveCheckpoint()) {
            await this.rollbackManager.saveCheckpoint();
        }
    }
    
    // ========================================================================
    // Network sync (set externally after construction)
    // ========================================================================
    
    setNetworkSync(networkSync) {
        this.networkSync = networkSync;
    }
    
    // ========================================================================
    // Lifecycle
    // ========================================================================
    
    start() {
        this.generateMap(this.mapSeed);
        this.winConditionManager.start();
        this.gameUI.updatePlayerIndicator();
    }
}

