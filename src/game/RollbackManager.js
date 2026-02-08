import { Logger } from '../utils/Logger.js';

/**
 * RollbackManager - Orchestrates rollback netcode for multiplayer synchronization.
 * 
 * This module wraps CheckpointBuffer and ActionQueue to handle:
 * - Saving periodic checkpoints
 * - Storing local and remote actions
 * - Detecting when rollback is needed
 * - Performing rollback and replay
 * 
 * Uses dependency injection via callbacks to avoid circular dependencies
 * with the simulation loop and grid management.
 */
export class RollbackManager {
    /**
     * Create a RollbackManager.
     * @param {Object} options - Configuration options
     * @param {Object} options.checkpointBuffer - CheckpointBuffer instance
     * @param {Object} options.actionQueue - ActionQueue instance
     * @param {Function} options.getGridData - () => Float32Array - get current grid data
     * @param {Function} options.uploadGridData - (data) => void - upload grid data
     * @param {Function} options.getCurrentTick - () => number - get current sim tick
     * @param {Function} options.setTick - (tick) => void - set sim tick
     * @param {Function} options.simulationStep - () => void - run one simulation step
     * @param {Function} options.applyAction - (action, playerId) => void - apply an action
     */
    constructor(options) {
        this.checkpointBuffer = options.checkpointBuffer;
        this.actionQueue = options.actionQueue;
        
        // Callbacks for external operations (avoids circular dependencies)
        this.getGridData = options.getGridData;
        this.uploadGridData = options.uploadGridData;
        this.getCurrentTick = options.getCurrentTick;
        this.setTick = options.setTick;
        this.simulationStep = options.simulationStep;
        this.applyAction = options.applyAction;
        
        // Statistics for debugging
        this.stats = {
            rollbackCount: 0,
            totalRollbackTime: 0,
            totalSimStepsReplayed: 0,
            totalActionsReplayed: 0
        };
    }
    
    /**
     * Check if a checkpoint should be saved at the current tick.
     * Called from the simulation loop.
     * @returns {boolean}
     */
    shouldSaveCheckpoint() {
        const tick = this.getCurrentTick();
        return this.checkpointBuffer.shouldSaveCheckpoint(tick);
    }
    
    /**
     * Save a checkpoint at the current tick.
     * Called from the simulation loop after a simulation step.
     * NOTE: Async because grid download is async in WebGPU.
     */
    async saveCheckpoint() {
        const tick = this.getCurrentTick();
        const gridData = await this.getGridData();
        this.checkpointBuffer.saveCheckpoint(tick, gridData);

        // Garbage collect old applied actions
        const oldestCheckpointTick = this.checkpointBuffer.getOldestTick();
        this.actionQueue.garbageCollectBeforeCheckpoint(oldestCheckpointTick);
    }
    
    /**
     * Store a local action in the queue.
     * Called when the local player performs an action.
     * @param {Object} action - The action data
     * @param {number} playerId - The player who performed the action
     * @returns {Object} The stored action
     */
    storeLocalAction(action, playerId) {
        const tick = this.getCurrentTick();
        const storedAction = this.actionQueue.addAction(tick, playerId, action.type, action, true);
        Logger.log('action', `Stored local action: ${action.type} at tick ${tick}`);
        return storedAction;
    }
    
    /**
     * Process an incoming remote action.
     * Determines if rollback is needed and handles accordingly.
     * @param {Object} action - The action data
     * @param {number} playerId - The player who performed the action
     * @param {number} actionTick - The tick when the action was performed
     */
    async processRemoteAction(action, playerId, actionTick) {
        const currentTick = this.getCurrentTick();
        const tickDelta = currentTick - actionTick;

        Logger.log('network', `Received: ${action.type} from P${playerId} at tick ${actionTick} (we're at ${currentTick}, delta=${tickDelta})`);

        if (actionTick <= currentTick) {
            // Action is in the past - need to rollback and replay
            await this.rollbackAndReplay(actionTick, action, playerId);
        } else {
            // Action is in the future - queue it for later
            this.actionQueue.addAction(actionTick, playerId, action.type, action, false);
            Logger.log('network', `Queued future action for tick ${actionTick}`);
        }
    }
    
    /**
     * Rollback to a checkpoint and replay simulation with actions.
     * This is called when a remote action arrives from the past.
     * 
     * @param {number} targetTick - The tick we need to go back to
     * @param {Object} incomingAction - The new action that triggered rollback
     * @param {number} incomingPlayerId - The player who performed the incoming action
     */
    async rollbackAndReplay(targetTick, incomingAction, incomingPlayerId) {
        const currentTick = this.getCurrentTick();
        const rollbackStart = performance.now();
        
        Logger.log('rollback', `=== ROLLBACK START ===`);
        Logger.log('rollback', `Trigger: ${incomingAction.type} from Player ${incomingPlayerId} at tick ${targetTick}`);
        Logger.log('rollback', `Current tick: ${currentTick}, Target tick: ${targetTick}, Delta: ${currentTick - targetTick} ticks`);
        
        // Add the incoming action to the queue FIRST
        if (!this.actionQueue.hasAction(targetTick, incomingPlayerId, incomingAction.type)) {
            this.actionQueue.addAction(targetTick, incomingPlayerId, incomingAction.type, incomingAction, false);
        }
        
        // Debug: show all actions in queue
        Logger.log('rollback', `Queue has ${this.actionQueue.actions.length} actions`);
        
        // Find the OLDEST UNAPPLIED action that needs replaying
        const unappliedActions = this.actionQueue.actions.filter(a => !a.applied);
        const oldestUnappliedTick = unappliedActions.length > 0 
            ? Math.min(...unappliedActions.map(a => a.tick)) 
            : targetTick;
        const rollbackToTick = Math.min(targetTick, oldestUnappliedTick);
        Logger.log('rollback', `Unapplied: ${unappliedActions.length}, oldest=${oldestUnappliedTick}, rollbackTo=${rollbackToTick}`);
        
        // Find the best checkpoint before ALL actions that need replaying
        const checkpoint = this.checkpointBuffer.findCheckpointBefore(rollbackToTick);
        if (!checkpoint) {
            Logger.error('rollback', `No checkpoint found before tick ${rollbackToTick}, oldest: ${this.checkpointBuffer.getOldestTick()}`);
            // Fallback: just apply the action directly without rollback
            await this.applyAction(incomingAction, incomingPlayerId);
            return;
        }

        Logger.log('checkpoint', `Using checkpoint at tick ${checkpoint.tick} (target: ${rollbackToTick})`);

        // Verify checkpoint is strictly BEFORE the rollback target
        if (checkpoint.tick >= rollbackToTick) {
            Logger.error('rollback', `Checkpoint at ${checkpoint.tick} is NOT before target ${rollbackToTick}!`);
            await this.applyAction(incomingAction, incomingPlayerId);
            return;
        }
        
        // Restore from checkpoint
        const restoreStart = performance.now();
        this.uploadGridData(checkpoint.cpuData);
        const tickBeforeReplay = this.getCurrentTick();
        this.setTick(checkpoint.tick);
        const restoreTime = performance.now() - restoreStart;
        Logger.log('checkpoint', `Restored to tick ${checkpoint.tick} in ${restoreTime.toFixed(1)}ms`);
        
        // Reset applied status for ALL actions at or after checkpoint tick
        this.actionQueue.resetAppliedAfter(checkpoint.tick - 1);
        
        // Get ALL actions that need to be replayed
        const actionsToReplay = this.actionQueue.getActionsInRange(checkpoint.tick - 1, currentTick);
        Logger.log('rollback', `Replaying ${actionsToReplay.length} actions from tick ${checkpoint.tick} to ${currentTick}`);
        
        // Count simulation steps for debugging
        let simStepsRun = 0;
        let actionsApplied = 0;
        
        // Replay simulation from checkpoint to current tick
        const replayStart = performance.now();
        while (this.getCurrentTick() < currentTick) {
            // Apply all actions that should happen at this tick
            const tickNow = Math.floor(this.getCurrentTick());
            const actionsAtTick = actionsToReplay.filter(a => a.tick === tickNow);
            for (const action of actionsAtTick) {
                if (!action.applied) {
                    Logger.log('action', `Replay: ${action.type} at tick ${tickNow} for P${action.playerId}`);
                    await this.applyAction(action.data, action.playerId);
                    action.applied = true;
                    actionsApplied++;
                }
            }
            
            // Run simulation step (this increments simTime via callback)
            this.simulationStep();
            simStepsRun++;
        }
        
        // Apply any actions at the final tick
        const finalTick = Math.floor(this.getCurrentTick());
        const finalActions = actionsToReplay.filter(a => a.tick === finalTick);
        for (const action of finalActions) {
            if (!action.applied) {
                Logger.log('action', `Final: ${action.type} at tick ${finalTick} for P${action.playerId}`);
                await this.applyAction(action.data, action.playerId);
                action.applied = true;
                actionsApplied++;
            }
        }
        
        const replayTime = performance.now() - replayStart;
        const totalTime = performance.now() - rollbackStart;
        
        Logger.log('rollback', `=== ROLLBACK COMPLETE ===`);
        Logger.log('rollback', `Sim steps: ${simStepsRun}, Actions applied: ${actionsApplied}`);
        Logger.log('rollback', `Tick: ${tickBeforeReplay} -> ${checkpoint.tick} -> ${Math.floor(this.getCurrentTick())}`);
        Logger.log('rollback', `Time: restore=${restoreTime.toFixed(1)}ms, replay=${replayTime.toFixed(1)}ms, total=${totalTime.toFixed(1)}ms`);
        
        // Update statistics
        this.stats.rollbackCount++;
        this.stats.totalRollbackTime += totalTime;
        this.stats.totalSimStepsReplayed += simStepsRun;
        this.stats.totalActionsReplayed += actionsApplied;
    }
    
    /**
     * Clear all rollback state (checkpoints and actions).
     * Called when receiving initial state sync.
     */
    clear() {
        this.checkpointBuffer.clear();
        this.actionQueue.clear();
        Logger.log('rollback', 'Cleared rollback state');
    }
    
    /**
     * Save an initial checkpoint after receiving state sync.
     * @param {number} tick - The tick to save at
     */
    async saveInitialCheckpoint(tick) {
        const gridData = await this.getGridData();
        this.checkpointBuffer.saveCheckpoint(tick, gridData);
        Logger.log('checkpoint', `Saved initial checkpoint at tick ${tick}`);
    }
    
    /**
     * Get statistics for debugging.
     * @returns {Object}
     */
    getStats() {
        return {
            ...this.stats,
            checkpointCount: this.checkpointBuffer.getCheckpoints().length,
            oldestCheckpointTick: this.checkpointBuffer.getOldestTick(),
            newestCheckpointTick: this.checkpointBuffer.getNewestTick(),
            actionQueueSize: this.actionQueue.actions.length,
            oldestActionTick: this.actionQueue.getOldestTick()
        };
    }
}

