/**
 * StatsTracker - Tracks and reports simulation and render performance
 * 
 * Handles:
 * - Simulation steps per second (TPS)
 * - Render frames per second (FPS)
 * - Potential TPS (how fast we could run)
 * - Periodic stats updates
 */

export class StatsTracker {
    /**
     * @param {Object} options
     * @param {number} [options.logInterval=1000] - How often to log stats (ms)
     * @param {number} [options.tpsUpdateInterval=500] - How often to update TPS display (ms)
     * @param {Function} options.onFpsUpdate - Called with (effectiveTps, targetTps, potentialTps, renderFps)
     * @param {Function} options.onTickUpdate - Called to update tick display
     */
    constructor(options = {}) {
        this.logInterval = options.logInterval ?? 1000;
        this.tpsUpdateInterval = options.tpsUpdateInterval ?? 500;
        this.onFpsUpdate = options.onFpsUpdate || (() => {});
        this.onTickUpdate = options.onTickUpdate || (() => {});
        
        // Simulation stats
        this.simStepCount = 0;
        this.lastLogTime = performance.now();
        
        // TPS calculation
        this.tpsCalcStepCount = 0;
        this.lastTpsCalcTime = performance.now();
        this.effectiveTicksPerSecond = 60;
        this.potentialTicksPerSecond = 60;
        this.targetTicksPerSecond = 60;
        
        // Frame time tracking for potential TPS
        this.tpsFrameTimeAccumulator = 0;
        this.tpsFrameCount = 0;
        
        // Render stats
        this.renderFrameCount = 0;
    }
    
    /**
     * Record a simulation step
     */
    recordSimStep() {
        this.simStepCount++;
        this.tpsCalcStepCount++;
    }
    
    /**
     * Record a render frame and its time
     * @param {number} frameTime - Time since last frame (ms)
     */
    recordRenderFrame(frameTime) {
        this.renderFrameCount++;
        if (frameTime > 0) {
            this.tpsFrameTimeAccumulator += frameTime;
            this.tpsFrameCount++;
        }
    }
    
    /**
     * Set the target TPS (from network sync)
     * @param {number} targetTps
     */
    setTargetTps(targetTps) {
        this.targetTicksPerSecond = Math.max(1, targetTps);
    }
    
    /**
     * Get current effective TPS
     * @returns {number}
     */
    getEffectiveTps() {
        return this.effectiveTicksPerSecond;
    }
    
    /**
     * Get potential TPS (how fast we could run)
     * @returns {number}
     */
    getPotentialTps() {
        return this.potentialTicksPerSecond;
    }
    
    /**
     * Get target TPS
     * @returns {number}
     */
    getTargetTps() {
        return this.targetTicksPerSecond;
    }
    
    /**
     * Update stats - call this every frame
     * @returns {{ shouldSendHeartbeat: boolean, shouldSendSync: boolean }}
     */
    update() {
        const now = performance.now();
        
        // Basic logging interval
        const elapsed = now - this.lastLogTime;
        if (elapsed >= this.logInterval) {
            // Could log here if needed
            this.simStepCount = 0;
            this.renderFrameCount = 0;
            this.lastLogTime = now;
        }
        
        // TPS calculation interval
        const tpsElapsed = now - this.lastTpsCalcTime;
        if (tpsElapsed >= this.tpsUpdateInterval) {
            // Calculate actual TPS
            const measuredTps = (this.tpsCalcStepCount / tpsElapsed) * 1000;
            this.effectiveTicksPerSecond = Math.max(1, measuredTps);
            this.tpsCalcStepCount = 0;
            
            // Calculate potential TPS from frame times
            if (this.tpsFrameCount > 0) {
                const avgFrameTime = this.tpsFrameTimeAccumulator / this.tpsFrameCount;
                this.potentialTicksPerSecond = Math.max(1, 1000 / avgFrameTime);
            }
            this.tpsFrameTimeAccumulator = 0;
            this.tpsFrameCount = 0;
            this.lastTpsCalcTime = now;
            
            // Notify listeners
            this.onFpsUpdate(
                this.effectiveTicksPerSecond,
                this.targetTicksPerSecond,
                this.potentialTicksPerSecond,
                this.potentialTicksPerSecond
            );
            this.onTickUpdate();
            
            return { tpsUpdated: true };
        }
        
        return { tpsUpdated: false };
    }
    
    /**
     * Reset all counters
     */
    reset() {
        this.simStepCount = 0;
        this.tpsCalcStepCount = 0;
        this.renderFrameCount = 0;
        this.tpsFrameTimeAccumulator = 0;
        this.tpsFrameCount = 0;
        this.lastLogTime = performance.now();
        this.lastTpsCalcTime = performance.now();
    }
}

