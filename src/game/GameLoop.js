/**
 * GameLoop - Orchestrates the game loop
 * 
 * Handles:
 * - Render loop via requestAnimationFrame
 * - Simulation stepping (sync and fast modes)
 * - Stats tracking (TPS/FPS)
 * - Network heartbeat
 */

import { Logger } from '../utils/Logger.js';

export class GameLoop {
    /**
     * @param {Object} options
     * @param {Game} options.game - The game instance
     * @param {Renderer} options.renderer - The renderer
     * @param {Object} options.config - Loop configuration
     */
    constructor(options) {
        this.game = options.game;
        this.renderer = options.renderer;
        this.config = options.config;
        
        // Timing
        this.lastRenderTime = 0;
        this.lastSimStepTime = 0;
        this.running = false;
        
        // Stats tracking (inline, no separate module needed)
        this.simStepCount = 0;
        this.tpsCalcStepCount = 0;
        this.tpsFrameTimeAccumulator = 0;
        this.tpsFrameCount = 0;
        this.lastTpsCalcTime = performance.now();
        this.effectiveTps = 60;
        this.potentialTps = 60;
        
        // Network heartbeat timing
        this.lastHeartbeatTime = 0;
        this.lastFullSyncTime = 0;
        
        // Bind the loop method
        this._loop = this._loop.bind(this);
    }
    
    /**
     * Start the game loop
     */
    start() {
        this.running = true;
        this.lastRenderTime = performance.now();
        this.lastTpsCalcTime = performance.now();
        requestAnimationFrame(this._loop);
        
        // If starting in fast mode, also start fast loop
        if (!this.game.syncWithRender) {
            this._fastLoop();
        }
    }
    
    /**
     * Stop the game loop
     */
    stop() {
        this.running = false;
    }
    
    /**
     * Get effective TPS (actual simulation speed)
     */
    getEffectiveTps() {
        return this.effectiveTps;
    }
    
    /**
     * Get potential TPS (how fast we could run)
     */
    getPotentialTps() {
        return this.potentialTps;
    }
    
    /**
     * Main render loop
     */
    _loop(now) {
        if (!this.running) return;
        
        // Track frame time for potential TPS
        if (this.lastRenderTime > 0) {
            const frameTime = now - this.lastRenderTime;
            this.tpsFrameTimeAccumulator += frameTime;
            this.tpsFrameCount++;
        }
        this.lastRenderTime = now;
        
        // Run simulation if in sync mode
        if (this.game.syncWithRender) {
            this._runSyncedSimulation(now);
        }
        
        // Update stats
        this._updateStats();
        
        // Update network (heartbeat, periodic sync)
        this._updateNetwork();
        
        // Update audio
        this.game.audioManager.update(this.game.grid.getReadTexture());
        
        // Render
        this.renderer.render();
        
        // Continue loop
        requestAnimationFrame(this._loop);
    }
    
    /**
     * Run simulation steps in sync mode
     */
    _runSyncedSimulation(now) {
        const game = this.game;
        const batchSize = this.config.syncSimBatchSize || 1;
        const tpsMargin = this.config.tpsMargin || 5;
        const maxStepsPerFrame = 3;
        
        // Calculate target frame time
        const effectiveTargetTps = game.isMultiplayer 
            ? Math.max(1, game.targetTicksPerSecond + tpsMargin) 
            : 999;
        const targetFrameTime = 1000 / effectiveTargetTps;
        
        // Initialize on first frame
        if (this.lastSimStepTime === 0) {
            this.lastSimStepTime = now;
        }
        
        if (!game.isMultiplayer) {
            // Single player: run every frame
            for (let i = 0; i < batchSize; i++) {
                game.simulationStep();
                this.simStepCount++;
                this.tpsCalcStepCount++;
            }
            this.lastSimStepTime = now;
        } else {
            // Multiplayer: throttle to target TPS
            let stepsTaken = 0;
            while ((now - this.lastSimStepTime) >= targetFrameTime && stepsTaken < maxStepsPerFrame) {
                for (let i = 0; i < batchSize; i++) {
                    game.simulationStep();
                    this.simStepCount++;
                    this.tpsCalcStepCount++;
                }
                this.lastSimStepTime += targetFrameTime;
                stepsTaken++;
            }
        }
    }
    
    /**
     * Fast simulation loop (runs via setTimeout)
     */
    _fastLoop() {
        if (this.game.syncWithRender || !this.running) return;
        
        const batchSize = this.config.simBatchSize || 10;
        
        for (let i = 0; i < batchSize; i++) {
            this.game.simulationStep();
            this.simStepCount++;
            this.tpsCalcStepCount++;
        }
        
        this._updateStats();
        
        setTimeout(() => this._fastLoop(), 0);
    }
    
    /**
     * Update TPS/FPS stats
     */
    _updateStats() {
        const now = performance.now();
        const tpsElapsed = now - this.lastTpsCalcTime;
        
        if (tpsElapsed >= 500) {
            // Calculate actual TPS
            this.effectiveTps = Math.max(1, (this.tpsCalcStepCount / tpsElapsed) * 1000);
            this.tpsCalcStepCount = 0;
            
            // Calculate potential TPS from frame times
            if (this.tpsFrameCount > 0) {
                const avgFrameTime = this.tpsFrameTimeAccumulator / this.tpsFrameCount;
                this.potentialTps = Math.max(1, 1000 / avgFrameTime);
            }
            this.tpsFrameTimeAccumulator = 0;
            this.tpsFrameCount = 0;
            this.lastTpsCalcTime = now;
            
            // Update UI
            this.game.gameUI.updateFpsDisplay(
                this.effectiveTps,
                this.game.targetTicksPerSecond,
                this.potentialTps,
                this.potentialTps
            );
            this.game.gameUI.updateTickDisplay();
        }
    }
    
    /**
     * Update network (heartbeat and periodic sync)
     */
    _updateNetwork() {
        const game = this.game;
        
        if (!game.isMultiplayer || !game.networkSync?.isConnected || game.isSpectator) {
            return;
        }
        
        const now = performance.now();
        const heartbeatInterval = this.config.heartbeatInterval || 1000;
        const fullSyncInterval = this.config.fullSyncInterval || 5000;
        
        // Send heartbeat
        if (now - this.lastHeartbeatTime >= heartbeatInterval) {
            if (this.potentialTps > 1) {
                game.networkSync.sendHeartbeat(this.potentialTps, Math.floor(game.simTime));
            }
            this.lastHeartbeatTime = now;
        }
        
        // Host sends periodic full sync
        if (game.networkSync.playerId === 1 && now - this.lastFullSyncTime >= fullSyncInterval) {
            const gridData = game.grid.download();
            game.networkSync.syncState(gridData, {
                type: 'periodic_sync',
                factoryCounts: { ...game.playerFactoryCounts },
                totalPlaced: { ...game.playerTotalFactoriesPlaced },
                factoriesPlaced: game.factoriesPlaced
            }, game.simTime);
            this.lastFullSyncTime = now;
            Logger.log('sync', `Sent periodic sync at tick ${Math.floor(game.simTime)}`);
        }
    }
    
    /**
     * Called when speed mode changes
     */
    onSpeedChange(syncWithRender) {
        this.game.syncWithRender = syncWithRender;
        
        // If switching to fast mode, start fast loop
        if (!syncWithRender) {
            this._fastLoop();
        }
    }
}

