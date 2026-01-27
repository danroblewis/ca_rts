/**
 * RollbackManager.js - Rollback netcode management
 * 
 * Handles checkpoint saving, action queuing, and rollback/replay logic
 * for deterministic multiplayer synchronization.
 */

import { Logger } from '../utils/Logger.js';
import { CheckpointBuffer } from '../gpu/CheckpointBuffer.js';
import { ActionQueue } from './ActionQueue.js';

export class RollbackManager {
    /**
     * Create a rollback manager.
     * 
     * @param {Object} config - Configuration
     * @param {number} config.gridSize - Grid size for checkpoints
     * @param {number} config.checkpointInterval - Ticks between checkpoints
     * @param {number} config.maxCheckpoints - Maximum checkpoints to keep
     */
    constructor(config = {}) {
        this.gridSize = config.gridSize || 512;
        this.checkpointInterval = config.checkpointInterval || 10;
        this.maxCheckpoints = config.maxCheckpoints || 30;
        
        // Create checkpoint buffer and action queue
        this.checkpointBuffer = new CheckpointBuffer(this.gridSize, this.gridSize, {
            maxCheckpoints: this.maxCheckpoints
        });
        this.actionQueue = new ActionQueue();
        
        // Tick of last checkpoint
        this.lastCheckpointTick = 0;
        
        // Callbacks
        this.callbacks = {
            onApplyAction: null,    // (action, playerId) => void
            onSimulationStep: null, // () => void - run one simulation step
            onRestoreGrid: null,    // (gridData) => void - restore grid state
            onDownloadGrid: null,   // () => Float32Array - download current grid
        };
        
        // Stats
        this.stats = {
            rollbackCount: 0,
            totalRollbackTicks: 0,
            lastRollbackTime: 0
        };
    }
    
    /**
     * Set a callback.
     */
    on(event, callback) {
        if (this.callbacks.hasOwnProperty(event)) {
            this.callbacks[event] = callback;
        }
    }
    
    /**
     * Check if a checkpoint should be saved at this tick.
     */
    shouldSaveCheckpoint(currentTick) {
        return currentTick - this.lastCheckpointTick >= this.checkpointInterval;
    }
    
    /**
     * Save a checkpoint at the current tick.
     * 
     * @param {number} tick - Current tick
     * @param {Float32Array} gridData - Current grid state (optional, will download if not provided)
     */
    saveCheckpoint(tick, gridData = null) {
        if (!gridData && this.callbacks.onDownloadGrid) {
            gridData = this.callbacks.onDownloadGrid();
        }
        
        if (gridData) {
            this.checkpointBuffer.saveCheckpoint(tick, gridData);
            this.lastCheckpointTick = tick;
            Logger.log('checkpoint', `Saved checkpoint at tick ${tick}`);
        }
    }
    
    /**
     * Add a local action to the queue.
     * 
     * @param {number} tick - Tick when action occurred
     * @param {number} playerId - Player who performed the action
     * @param {string} type - Action type
     * @param {Object} data - Action data
     */
    addLocalAction(tick, playerId, type, data) {
        this.actionQueue.addAction(tick, playerId, type, data, true);  // Applied = true for local actions
        Logger.log('action', `Local action: ${type} at tick ${tick} by P${playerId}`);
    }
    
    /**
     * Handle a remote action received from the network.
     * 
     * @param {number} actionTick - Tick when action occurred
     * @param {number} playerId - Player who performed the action
     * @param {Object} action - Action data
     * @param {number} currentTick - Current local tick
     */
    handleRemoteAction(actionTick, playerId, action, currentTick) {
        Logger.log('network', `Remote action: ${action.type} from P${playerId} at tick ${actionTick} (current: ${currentTick})`);
        
        if (actionTick <= currentTick) {
            // Action is in the past - need to rollback and replay
            return this.rollbackAndReplay(actionTick, action, playerId, currentTick);
        } else {
            // Action is in the future - queue it for later
            this.actionQueue.addAction(actionTick, playerId, action.type, action, false);
            Logger.log('network', `Queued future action for tick ${actionTick}`);
            return { rollbackPerformed: false, newTick: currentTick };
        }
    }
    
    /**
     * Apply any pending actions at the current tick.
     * 
     * @param {number} currentTick - Current tick
     */
    applyPendingActions(currentTick) {
        const pendingActions = this.actionQueue.getActionsAtTick(currentTick);
        
        for (const action of pendingActions) {
            if (!action.applied && this.callbacks.onApplyAction) {
                Logger.log('action', `Applying pending ${action.type} at tick ${currentTick} for P${action.playerId}`);
                this.callbacks.onApplyAction(action.data, action.playerId);
                action.applied = true;
            }
        }
    }
    
    /**
     * Rollback to a checkpoint and replay simulation with actions.
     * 
     * @param {number} targetTick - The tick we need to go back to
     * @param {Object} incomingAction - The new action that triggered rollback
     * @param {number} incomingPlayerId - The player who performed the incoming action
     * @param {number} currentTick - Current local tick
     * @returns {{rollbackPerformed: boolean, newTick: number}}
     */
    rollbackAndReplay(targetTick, incomingAction, incomingPlayerId, currentTick) {
        const rollbackStart = performance.now();
        
        Logger.log('rollback', `=== ROLLBACK START ===`);
        Logger.log('rollback', `Trigger: ${incomingAction.type} from P${incomingPlayerId} at tick ${targetTick}`);
        Logger.log('rollback', `Current tick: ${currentTick}, Target tick: ${targetTick}, Delta: ${currentTick - targetTick} ticks`);
        
        // Add the incoming action to the queue FIRST
        if (!this.actionQueue.hasAction(targetTick, incomingPlayerId, incomingAction.type)) {
            this.actionQueue.addAction(targetTick, incomingPlayerId, incomingAction.type, incomingAction, false);
        }
        
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
            // Fallback: apply action to current state (may cause desyncs)
            if (this.callbacks.onApplyAction) {
                this.callbacks.onApplyAction(incomingAction, incomingPlayerId);
            }
            return { rollbackPerformed: false, newTick: currentTick };
        }
        
        Logger.log('checkpoint', `Using checkpoint at tick ${checkpoint.tick} (target: ${rollbackToTick})`);
        
        // Verify checkpoint is strictly BEFORE the rollback target
        if (checkpoint.tick >= rollbackToTick) {
            Logger.error('rollback', `Checkpoint at ${checkpoint.tick} is NOT before target ${rollbackToTick}!`);
            if (this.callbacks.onApplyAction) {
                this.callbacks.onApplyAction(incomingAction, incomingPlayerId);
            }
            return { rollbackPerformed: false, newTick: currentTick };
        }
        
        // Restore from checkpoint
        const restoreStart = performance.now();
        if (this.callbacks.onRestoreGrid) {
            this.callbacks.onRestoreGrid(checkpoint.cpuData);
        }
        let simTime = checkpoint.tick;
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
        while (simTime < currentTick) {
            // Apply all actions that should happen at this tick
            const actionsAtTick = actionsToReplay.filter(a => a.tick === Math.floor(simTime));
            for (const action of actionsAtTick) {
                if (!action.applied && this.callbacks.onApplyAction) {
                    Logger.log('action', `Replay: ${action.type} at tick ${Math.floor(simTime)} for P${action.playerId}`);
                    this.callbacks.onApplyAction(action.data, action.playerId);
                    action.applied = true;
                    actionsApplied++;
                }
            }
            
            // Run simulation step
            if (this.callbacks.onSimulationStep) {
                this.callbacks.onSimulationStep();
            }
            simTime += 1;
            simStepsRun++;
        }
        
        // Apply any actions at the final tick
        const finalActions = actionsToReplay.filter(a => a.tick === currentTick);
        for (const action of finalActions) {
            if (!action.applied && this.callbacks.onApplyAction) {
                Logger.log('action', `Final: ${action.type} at tick ${Math.floor(simTime)} for P${action.playerId}`);
                this.callbacks.onApplyAction(action.data, action.playerId);
                action.applied = true;
                actionsApplied++;
            }
        }
        
        const replayTime = performance.now() - replayStart;
        const totalTime = performance.now() - rollbackStart;
        
        // Update stats
        this.stats.rollbackCount++;
        this.stats.totalRollbackTicks += simStepsRun;
        this.stats.lastRollbackTime = totalTime;
        
        Logger.log('rollback', `=== ROLLBACK COMPLETE ===`);
        Logger.log('rollback', `Sim steps: ${simStepsRun}, Actions applied: ${actionsApplied}`);
        Logger.log('rollback', `Tick: ${currentTick} -> ${checkpoint.tick} -> ${simTime}`);
        Logger.log('rollback', `Time: restore=${restoreTime.toFixed(1)}ms, replay=${replayTime.toFixed(1)}ms, total=${totalTime.toFixed(1)}ms`);
        
        return { rollbackPerformed: true, newTick: simTime };
    }
    
    /**
     * Garbage collect old actions that are before our oldest checkpoint.
     */
    garbageCollect() {
        const oldestCheckpoint = this.checkpointBuffer.getOldestTick();
        if (oldestCheckpoint > 0) {
            this.actionQueue.garbageCollectBeforeCheckpoint(oldestCheckpoint);
        }
    }
    
    /**
     * Clear all state (for game reset or new player joining).
     */
    clear() {
        this.checkpointBuffer.clear();
        this.actionQueue.clear();
        this.lastCheckpointTick = 0;
        Logger.log('rollback', 'Cleared checkpoint buffer and action queue');
    }
    
    /**
     * Get statistics.
     */
    getStats() {
        return {
            ...this.stats,
            checkpointCount: this.checkpointBuffer.getCheckpointCount(),
            actionCount: this.actionQueue.actions.length,
            oldestCheckpointTick: this.checkpointBuffer.getOldestTick()
        };
    }
}

