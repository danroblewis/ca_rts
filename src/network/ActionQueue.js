/**
 * ActionQueue - Stores game actions with their tick counts for rollback netcode.
 * 
 * Actions are stored in order by tick. When we need to replay from a checkpoint,
 * we can iterate through actions that happened after the checkpoint tick.
 * 
 * Local actions are applied immediately and stored.
 * Remote actions may arrive late and require rollback to apply correctly.
 */
export class ActionQueue {
    constructor() {
        // Actions sorted by tick
        // Each action: { tick, playerId, type, data, applied }
        this.actions = [];
        
        // Keep actions for this many ticks (for rollback capability)
        // At 60fps, 300 ticks = 5 seconds
        this.maxHistoryTicks = 300;
        
        // Confirmed tick - all players have processed up to this tick
        // Actions before this can be garbage collected
        this.confirmedTick = 0;
    }
    
    /**
     * Add an action to the queue.
     * @param {number} tick - The tick this action should be applied at
     * @param {number} playerId - Player who performed the action
     * @param {string} type - Action type (place_factory, demolish, unit_command, etc.)
     * @param {Object} data - Action data
     * @param {boolean} [applied=false] - Whether this action has been applied locally
     * @returns {Object} The action object
     */
    addAction(tick, playerId, type, data, applied = false) {
        const action = { tick, playerId, type, data, applied };
        
        // Insert in sorted order by tick
        let insertIdx = this.actions.length;
        for (let i = this.actions.length - 1; i >= 0; i--) {
            if (this.actions[i].tick <= tick) {
                insertIdx = i + 1;
                break;
            }
            if (i === 0) insertIdx = 0;
        }
        this.actions.splice(insertIdx, 0, action);
        
        return action;
    }
    
    /**
     * Check if a remote action requires rollback.
     * @param {number} actionTick - The tick of the remote action
     * @param {number} currentTick - Current simulation tick
     * @returns {boolean}
     */
    requiresRollback(actionTick, currentTick) {
        return actionTick < currentTick;
    }
    
    /**
     * Get all actions that should be applied between startTick (exclusive) and endTick (inclusive).
     * @param {number} startTick - Start tick (exclusive)
     * @param {number} endTick - End tick (inclusive)
     * @returns {Array}
     */
    getActionsInRange(startTick, endTick) {
        return this.actions.filter(a => a.tick > startTick && a.tick <= endTick);
    }
    
    /**
     * Get all actions at a specific tick.
     * @param {number} tick 
     * @returns {Array}
     */
    getActionsAtTick(tick) {
        return this.actions.filter(a => a.tick === tick);
    }
    
    /**
     * Mark an action as applied.
     * @param {Object} action 
     */
    markApplied(action) {
        action.applied = true;
    }
    
    /**
     * Reset applied status for all actions after a given tick.
     * Called when rolling back.
     * @param {number} tick 
     */
    resetAppliedAfter(tick) {
        for (const action of this.actions) {
            if (action.tick > tick) {
                action.applied = false;
            }
        }
    }
    
    /**
     * Update the confirmed tick and garbage collect old actions.
     * @param {number} tick 
     */
    setConfirmedTick(tick) {
        this.confirmedTick = tick;
        this.garbageCollect();
    }
    
    /**
     * Remove actions that are too old to be needed.
     */
    garbageCollect() {
        const cutoff = this.confirmedTick - this.maxHistoryTicks;
        this.actions = this.actions.filter(a => a.tick >= cutoff);
    }
    
    /**
     * Remove old applied actions that are before the oldest checkpoint.
     * These can never be replayed anyway since we can't rollback that far.
     * @param {number} oldestCheckpointTick - The tick of the oldest checkpoint we have
     */
    garbageCollectBeforeCheckpoint(oldestCheckpointTick) {
        const beforeCount = this.actions.length;
        // Only remove APPLIED actions that are before the oldest checkpoint
        this.actions = this.actions.filter(a => 
            a.tick >= oldestCheckpointTick || !a.applied
        );
        const removed = beforeCount - this.actions.length;
        if (removed > 0) {
            console.log(`[ActionQueue] Garbage collected ${removed} old actions before checkpoint tick ${oldestCheckpointTick}`);
        }
    }
    
    /**
     * Check if an action already exists (to avoid duplicates).
     * @param {number} tick 
     * @param {number} playerId 
     * @param {string} type 
     * @returns {boolean}
     */
    hasAction(tick, playerId, type) {
        return this.actions.some(a => 
            a.tick === tick && 
            a.playerId === playerId && 
            a.type === type
        );
    }
    
    /**
     * Get the oldest tick we have actions for.
     * @returns {number}
     */
    getOldestTick() {
        if (this.actions.length === 0) return Infinity;
        return this.actions[0].tick;
    }
    
    /**
     * Clear all actions.
     */
    clear() {
        this.actions = [];
        this.confirmedTick = 0;
    }
    
    /**
     * Get stats for debugging.
     * @returns {Object}
     */
    getStats() {
        return {
            count: this.actions.length,
            confirmedTick: this.confirmedTick,
            oldestTick: this.getOldestTick(),
            newestTick: this.actions.length > 0 ? this.actions[this.actions.length - 1].tick : -1
        };
    }
}

