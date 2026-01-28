/**
 * SimulationScheduler - Controls when simulation steps run
 * 
 * Handles:
 * - Sync mode (one step per render frame)
 * - Fast mode (multiple steps per frame)
 * - Multiplayer TPS throttling
 */

export class SimulationScheduler {
    /**
     * @param {Object} options
     * @param {number} [options.batchSize=1] - Steps per batch
     * @param {number} [options.tpsMargin=5] - Extra TPS margin for speedup
     * @param {number} [options.maxStepsPerFrame=3] - Max catchup steps per frame
     * @param {Function} options.simulationStep - () => void
     * @param {Function} options.getTargetTps - () => number
     * @param {Function} options.isMultiplayer - () => boolean
     */
    constructor(options) {
        this.batchSize = options.batchSize ?? 1;
        this.tpsMargin = options.tpsMargin ?? 5;
        this.maxStepsPerFrame = options.maxStepsPerFrame ?? 3;
        this.simulationStep = options.simulationStep;
        this.getTargetTps = options.getTargetTps;
        this.isMultiplayer = options.isMultiplayer;
        
        this.lastSimStepTime = 0;
        this.syncWithRender = true;
    }
    
    /**
     * Set sync mode
     * @param {boolean} sync - true for synced (normal speed), false for fast mode
     */
    setSyncMode(sync) {
        this.syncWithRender = sync;
    }
    
    /**
     * Run simulation steps based on current mode and timing
     * Called each render frame
     * @param {number} now - Current time (performance.now())
     */
    runFrame(now) {
        if (!this.syncWithRender) {
            // Fast mode runs in its own loop, not here
            return;
        }
        
        const isMP = this.isMultiplayer();
        const targetTps = this.getTargetTps();
        
        // In multiplayer, throttle to target TPS with margin
        const effectiveTargetTps = isMP ? Math.max(1, targetTps + this.tpsMargin) : 999;
        const targetFrameTime = 1000 / effectiveTargetTps;
        
        // Initialize lastSimStepTime on first frame
        if (this.lastSimStepTime === 0) {
            this.lastSimStepTime = now;
        }
        
        if (!isMP) {
            // Single player: run every frame
            for (let i = 0; i < this.batchSize; i++) {
                this.simulationStep();
            }
            this.lastSimStepTime = now;
        } else {
            // Multiplayer: throttle to target TPS, run multiple steps if behind
            let stepsTaken = 0;
            while ((now - this.lastSimStepTime) >= targetFrameTime && stepsTaken < this.maxStepsPerFrame) {
                for (let i = 0; i < this.batchSize; i++) {
                    this.simulationStep();
                }
                this.lastSimStepTime += targetFrameTime;
                stepsTaken++;
            }
        }
    }
    
    /**
     * Reset scheduler state (e.g., after sync)
     */
    reset() {
        this.lastSimStepTime = 0;
    }
}

