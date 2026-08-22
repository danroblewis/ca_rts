/**
 * GameLoop - Orchestrates the game loop
 *
 * Handles:
 * - Render loop via requestAnimationFrame
 * - Fixed-timestep simulation pacing (targetTicksPerSecond) with bounded
 *   catch-up, gated by lockstep input availability in multiplayer
 * - Fast mode (many ticks per frame, single player)
 * - Stats tracking (TPS/FPS) and the periodic network heartbeat
 *
 * The frame path is fully synchronous: nothing here awaits the GPU.
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
        this.networkManager = options.networkManager || null;

        // Dynamic resolution: step down the render scale when the GPU can't
        // keep up (the 512x512 CA doesn't need retina pixels).
        this.setRenderScale = options.setRenderScale || null;
        this.renderScales = this.config.renderScales || [1.5, 1.0, 0.75, 0.5];
        this.renderScaleIndex = 0;
        this.renderScale = this.renderScales[0];
        this.lowFpsSince = 0;

        // Timing
        this.lastRenderTime = 0;
        this.tickAccumulator = 0;        // ms of simulation time owed
        this.maxStepsPerFrame = this.config.maxStepsPerFrame ?? 4;
        this.running = false;

        // Stats tracking
        this.simStepCount = 0;
        this.tpsCalcStepCount = 0;
        this.tpsFrameTimeAccumulator = 0;
        this.tpsFrameCount = 0;
        this.lastTpsCalcTime = performance.now();
        this.effectiveTps = 60;
        this.potentialTps = 60;
        this.frameTimes = [];            // recent frame times (ms) for p95 etc.

        // Network heartbeat timing
        this.lastHeartbeatTime = 0;

        // Auto perf mode: switch to performance mode if FPS < 55 for 5+ seconds
        this.lowFpsStart = 0;
        this.autoPerfTriggered = false;

        this._loop = this._loop.bind(this);
    }

    start() {
        this.running = true;
        this.lastRenderTime = performance.now();
        this.lastTpsCalcTime = performance.now();
        requestAnimationFrame(this._loop);

        if (!this.game.syncWithRender) {
            this._fastLoop();
        }
    }

    stop() {
        this.running = false;
    }

    getEffectiveTps() {
        return this.effectiveTps;
    }

    getPotentialTps() {
        return this.potentialTps;
    }

    /**
     * Main render loop
     */
    _loop(now) {
        if (!this.running) return;

        const frameTime = this.lastRenderTime > 0 ? now - this.lastRenderTime : 0;
        this.lastRenderTime = now;
        this.tpsFrameTimeAccumulator += frameTime;
        this.tpsFrameCount++;
        this.frameTimes.push(frameTime);
        if (this.frameTimes.length > 300) this.frameTimes.shift();

        if (this.game.syncWithRender) {
            this._runSyncedSimulation(frameTime);
        }

        this._updateStats();
        this._updateNetwork();

        if (this.game.audioManager.isInitialized()) {
            this.game.audioManager.update(this.game.grid.getReadTexture());
        }

        this.renderer.render();

        requestAnimationFrame(this._loop);
    }

    /**
     * Run simulation steps for this frame (fixed timestep with catch-up).
     */
    _runSyncedSimulation(frameTime) {
        const game = this.game;
        const tps = Math.max(1, game.targetTicksPerSecond || 60);
        const tickMs = 1000 / tps;

        // Owe at most a frame-budget of catch-up; a long hitch must not turn
        // into a burst of dozens of ticks.
        this.tickAccumulator += Math.min(frameTime, tickMs * this.maxStepsPerFrame);

        let steps = 0;
        while (this.tickAccumulator >= tickMs && steps < this.maxStepsPerFrame) {
            if (!game.simulationStep()) {
                // Stalled (waiting for peer inputs / initial sync): don't
                // accumulate debt while blocked.
                this.tickAccumulator = Math.min(this.tickAccumulator, tickMs);
                break;
            }
            this.tickAccumulator -= tickMs;
            steps++;
            this.simStepCount++;
            this.tpsCalcStepCount++;
        }
        if (steps === this.maxStepsPerFrame) {
            // Still behind after a full catch-up: drop the remainder so we
            // don't try to run faster than the wall clock forever.
            this.tickAccumulator = Math.min(this.tickAccumulator, tickMs);
        }
    }

    /**
     * Fast simulation loop (single player "fast" speed toggle).
     */
    _fastLoop() {
        if (this.game.syncWithRender || !this.running) return;

        const batchSize = this.config.simBatchSize || 10;
        for (let i = 0; i < batchSize; i++) {
            if (!this.game.simulationStep()) break;
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
            this.effectiveTps = Math.max(0, (this.tpsCalcStepCount / tpsElapsed) * 1000);
            this.tpsCalcStepCount = 0;

            if (this.tpsFrameCount > 0) {
                const avgFrameTime = this.tpsFrameTimeAccumulator / this.tpsFrameCount;
                this.potentialTps = Math.max(1, 1000 / avgFrameTime);
            }
            this.tpsFrameTimeAccumulator = 0;
            this.tpsFrameCount = 0;
            this.lastTpsCalcTime = now;

            this.game.gameUI.updateFpsDisplay(
                this.effectiveTps,
                this.game.targetTicksPerSecond,
                this.potentialTps,
                this.potentialTps
            );
            this.game.gameUI.updateTickDisplay();

            // Dynamic resolution: FPS < 55 for 3+ seconds -> lower the render scale
            if (this.setRenderScale) {
                if (this.potentialTps < 55) {
                    if (this.lowFpsSince === 0) {
                        this.lowFpsSince = now;
                    } else if (now - this.lowFpsSince > 3000 && this.renderScaleIndex < this.renderScales.length - 1) {
                        this.renderScaleIndex++;
                        this.renderScale = this.renderScales[this.renderScaleIndex];
                        this.setRenderScale(this.renderScale);
                        this.lowFpsSince = 0;
                        console.log(`Render scale lowered to ${this.renderScale} (FPS was ${Math.round(this.potentialTps)})`);
                    }
                } else {
                    this.lowFpsSince = 0;
                }
            }

            // Auto perf mode: if FPS < 55 for 5+ seconds, switch to performance mode
            if (!this.autoPerfTriggered && !this.game.performanceMode) {
                if (this.potentialTps < 55) {
                    if (this.lowFpsStart === 0) {
                        this.lowFpsStart = now;
                    } else if (now - this.lowFpsStart > 5000) {
                        this.autoPerfTriggered = true;
                        const perfToggle = document.getElementById('perf-toggle');
                        if (perfToggle) {
                            perfToggle.checked = true;
                            perfToggle.dispatchEvent(new Event('change'));
                        } else {
                            this.game.performanceMode = true;
                            this.game.showMinimap = false;
                        }
                        console.log(`Auto-switched to performance mode (FPS was ${Math.round(this.potentialTps)} for 5+ seconds)`);
                    }
                } else {
                    this.lowFpsStart = 0;
                }
            }
        }
    }

    /**
     * Update network (heartbeat)
     */
    _updateNetwork() {
        const game = this.game;
        if (!game.isMultiplayer || !game.networkSync?.isConnected || game.isSpectator) {
            return;
        }

        const now = performance.now();
        const heartbeatInterval = this.config.heartbeatInterval || 1000;
        if (now - this.lastHeartbeatTime >= heartbeatInterval) {
            game.networkSync.sendHeartbeat(this.effectiveTps, Math.floor(game.simTime));
            this.networkManager?.onHeartbeat?.();
            this.lastHeartbeatTime = now;
        }
    }

    /**
     * Called when speed mode changes
     */
    onSpeedChange(syncWithRender) {
        this.game.syncWithRender = syncWithRender;
        if (!syncWithRender) {
            this._fastLoop();
        }
    }

    /**
     * Frame time statistics for the last ~5 seconds.
     */
    getFrameStats() {
        const ft = [...this.frameTimes].sort((a, b) => a - b);
        if (ft.length === 0) return { avg: 0, p95: 0, max: 0, fps: 0 };
        const avg = ft.reduce((a, b) => a + b, 0) / ft.length;
        return {
            avg,
            p95: ft[Math.floor(ft.length * 0.95)],
            max: ft[ft.length - 1],
            fps: 1000 / avg
        };
    }
}
