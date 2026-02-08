/**
 * RollbackManager Unit Tests
 * Tests for game/RollbackManager.js
 */

import { runTest, assert, logSection } from './framework.js';
import { RollbackManager } from '../game/RollbackManager.js';

// Mock CheckpointBuffer for testing
class MockCheckpointBuffer {
    constructor() {
        this.checkpoints = [];
        this.lastCheckpointTick = -Infinity;
        this.checkpointInterval = 10;
    }
    
    shouldSaveCheckpoint(tick) {
        return tick - this.lastCheckpointTick >= this.checkpointInterval;
    }
    
    saveCheckpoint(tick, data) {
        this.checkpoints.push({
            tick,
            cpuData: new Float32Array(data)
        });
        this.lastCheckpointTick = tick;
    }
    
    findCheckpointBefore(targetTick) {
        let best = null;
        for (const cp of this.checkpoints) {
            if (cp.tick < targetTick) {
                if (!best || cp.tick > best.tick) {
                    best = cp;
                }
            }
        }
        return best;
    }
    
    getOldestTick() {
        if (this.checkpoints.length === 0) return Infinity;
        return this.checkpoints[0].tick;
    }
    
    getNewestTick() {
        if (this.checkpoints.length === 0) return -Infinity;
        return this.checkpoints[this.checkpoints.length - 1].tick;
    }
    
    getCheckpoints() {
        return this.checkpoints;
    }
    
    clear() {
        this.checkpoints = [];
        this.lastCheckpointTick = -Infinity;
    }
}

// Mock ActionQueue for testing
class MockActionQueue {
    constructor() {
        this.actions = [];
    }
    
    addAction(tick, playerId, type, data, applied = false) {
        const action = { tick, playerId, type, data, applied };
        // Insert in sorted order
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
    
    hasAction(tick, playerId, type) {
        return this.actions.some(a => 
            a.tick === tick && 
            a.playerId === playerId && 
            a.type === type
        );
    }
    
    resetAppliedAfter(tick) {
        for (const action of this.actions) {
            if (action.tick > tick) {
                action.applied = false;
            }
        }
    }
    
    getActionsInRange(startTick, endTick) {
        return this.actions.filter(a => a.tick > startTick && a.tick <= endTick);
    }
    
    getActionsAtTick(tick) {
        return this.actions.filter(a => a.tick === tick);
    }
    
    garbageCollectBeforeCheckpoint(oldestCheckpointTick) {
        this.actions = this.actions.filter(a => 
            a.tick >= oldestCheckpointTick || !a.applied
        );
    }
    
    getOldestTick() {
        if (this.actions.length === 0) return Infinity;
        return this.actions[0].tick;
    }
    
    clear() {
        this.actions = [];
    }
}

// Test fixture helper
function createTestRollbackManager() {
    const checkpointBuffer = new MockCheckpointBuffer();
    const actionQueue = new MockActionQueue();
    
    // Mock game state
    let currentTick = 0;
    let gridData = new Float32Array(100); // Simple test grid
    const appliedActions = [];
    let simStepsRun = 0;
    
    const manager = new RollbackManager({
        checkpointBuffer,
        actionQueue,
        getGridData: async () => gridData,
        uploadGridData: (data) => { gridData = new Float32Array(data); },
        getCurrentTick: () => currentTick,
        setTick: (tick) => { currentTick = tick; },
        simulationStep: () => { currentTick += 1; simStepsRun++; },
        applyAction: async (action, playerId) => { appliedActions.push({ action, playerId }); }
    });
    
    return {
        manager,
        checkpointBuffer,
        actionQueue,
        getCurrentTick: () => currentTick,
        setTick: (tick) => { currentTick = tick; },
        getGridData: () => gridData,
        setGridData: (data) => { gridData = data; },
        getAppliedActions: () => appliedActions,
        getSimStepsRun: () => simStepsRun,
        clearAppliedActions: () => { appliedActions.length = 0; },
        resetSimSteps: () => { simStepsRun = 0; }
    };
}

export async function runRollbackManagerTests() {
    logSection('RollbackManager - Initialization');
    
    await runTest('RollbackManager initializes with callbacks', async () => {
        const { manager } = createTestRollbackManager();
        assert(manager !== null, 'Manager should exist');
        assert(manager.checkpointBuffer !== null, 'Should have checkpointBuffer');
        assert(manager.actionQueue !== null, 'Should have actionQueue');
    });
    
    await runTest('RollbackManager has initial empty stats', async () => {
        const { manager } = createTestRollbackManager();
        const stats = manager.getStats();
        assert(stats.rollbackCount === 0, 'Should have 0 rollbacks initially');
        assert(stats.totalRollbackTime === 0, 'Should have 0 rollback time initially');
    });
    
    logSection('RollbackManager - Checkpoints');
    
    await runTest('shouldSaveCheckpoint returns true at interval', async () => {
        const { manager, setTick } = createTestRollbackManager();
        
        // At tick 0, should need first checkpoint
        assert(manager.shouldSaveCheckpoint() === true, 'Should save first checkpoint');
        
        // After saving, should wait for interval
        await manager.saveCheckpoint();
        assert(manager.shouldSaveCheckpoint() === false, 'Should not save immediately after');
        
        // Advance to interval
        setTick(10);
        assert(manager.shouldSaveCheckpoint() === true, 'Should save at interval');
    });
    
    await runTest('saveCheckpoint stores grid data', async () => {
        const { manager, checkpointBuffer, setGridData, setTick } = createTestRollbackManager();
        
        // Set some grid data
        const testData = new Float32Array(100);
        testData[0] = 42;
        testData[99] = 99;
        setGridData(testData);
        setTick(50);
        
        await manager.saveCheckpoint();
        
        assert(checkpointBuffer.checkpoints.length === 1, 'Should have one checkpoint');
        assert(checkpointBuffer.checkpoints[0].tick === 50, 'Checkpoint should be at tick 50');
        assert(checkpointBuffer.checkpoints[0].cpuData[0] === 42, 'Should store first value');
        assert(checkpointBuffer.checkpoints[0].cpuData[99] === 99, 'Should store last value');
    });
    
    await runTest('saveInitialCheckpoint saves at given tick', async () => {
        const { manager, checkpointBuffer, setTick } = createTestRollbackManager();
        
        setTick(100);
        await manager.saveInitialCheckpoint(100);
        
        assert(checkpointBuffer.checkpoints.length === 1, 'Should have one checkpoint');
        assert(checkpointBuffer.checkpoints[0].tick === 100, 'Checkpoint should be at tick 100');
    });
    
    logSection('RollbackManager - Local Actions');
    
    await runTest('storeLocalAction adds to queue with current tick', async () => {
        const { manager, actionQueue, setTick } = createTestRollbackManager();
        
        setTick(42);
        const action = { type: 'place_factory', x: 10, y: 20 };
        const stored = manager.storeLocalAction(action, 1);
        
        assert(actionQueue.actions.length === 1, 'Should have one action');
        assert(stored.tick === 42, 'Action should be at tick 42');
        assert(stored.playerId === 1, 'Action should be from player 1');
        assert(stored.type === 'place_factory', 'Action type should match');
        assert(stored.applied === true, 'Local actions should be marked applied');
    });
    
    await runTest('storeLocalAction preserves action data', async () => {
        const { manager, actionQueue, setTick } = createTestRollbackManager();
        
        setTick(10);
        const action = { type: 'unit_command', targetX: 100, targetY: 200 };
        manager.storeLocalAction(action, 2);
        
        assert(actionQueue.actions[0].data.targetX === 100, 'Should preserve targetX');
        assert(actionQueue.actions[0].data.targetY === 200, 'Should preserve targetY');
    });
    
    logSection('RollbackManager - Remote Actions');
    
    await runTest('processRemoteAction queues future actions', async () => {
        const { manager, actionQueue, setTick } = createTestRollbackManager();
        
        setTick(10);
        const action = { type: 'place_factory', x: 5, y: 5 };
        await manager.processRemoteAction(action, 2, 15); // Action at tick 15, we're at 10
        
        assert(actionQueue.actions.length === 1, 'Should have one action');
        assert(actionQueue.actions[0].tick === 15, 'Action should be at tick 15');
        assert(actionQueue.actions[0].applied === false, 'Future action should not be applied');
    });
    
    await runTest('processRemoteAction triggers rollback for past actions', async () => {
        const { manager, setTick, getAppliedActions } = createTestRollbackManager();
        
        // Save a checkpoint at tick 10
        setTick(10);
        await manager.saveCheckpoint();
        
        // Advance to tick 20
        setTick(20);
        
        // Receive action from tick 15 (in the past)
        const action = { type: 'place_factory', x: 5, y: 5 };
        await manager.processRemoteAction(action, 2, 15);

        // Should have applied the action during rollback
        const applied = getAppliedActions();
        assert(applied.length >= 1, 'Should have applied at least one action');
        assert(applied[0].action.type === 'place_factory', 'Should have applied the factory action');
    });
    
    logSection('RollbackManager - Rollback and Replay');
    
    await runTest('rollbackAndReplay restores checkpoint and runs simulation', async () => {
        const { 
            manager, setTick, 
            setGridData, getCurrentTick, resetSimSteps, getSimStepsRun 
        } = createTestRollbackManager();
        
        // Save checkpoint at tick 5
        setTick(5);
        const checkpointData = new Float32Array(100);
        checkpointData[0] = 555;
        setGridData(checkpointData);
        await manager.saveCheckpoint();
        
        // Advance to tick 15
        setTick(15);
        resetSimSteps();
        
        // Trigger rollback to tick 10
        const action = { type: 'demolish', x: 10, y: 10 };
        await manager.rollbackAndReplay(10, action, 2);

        // Should have replayed simulation steps
        const simSteps = getSimStepsRun();
        assert(simSteps === 10, `Should have run 10 sim steps, got ${simSteps}`);
        assert(getCurrentTick() === 15, 'Should be back at tick 15');
    });
    
    await runTest('rollbackAndReplay applies actions at correct ticks', async () => {
        const { 
            manager, setTick, 
            clearAppliedActions, getAppliedActions 
        } = createTestRollbackManager();
        
        // Save checkpoint at tick 0
        setTick(0);
        await manager.saveCheckpoint();
        
        // Add a local action at tick 5
        setTick(5);
        const localAction = { type: 'place_factory', x: 1, y: 1 };
        manager.storeLocalAction(localAction, 1);
        
        // Advance to tick 10
        setTick(10);
        clearAppliedActions();
        
        // Receive remote action at tick 3
        const remoteAction = { type: 'place_factory', x: 50, y: 50 };
        await manager.rollbackAndReplay(3, remoteAction, 2);

        // Both actions should have been applied
        const applied = getAppliedActions();
        assert(applied.length === 2, `Should have applied 2 actions, got ${applied.length}`);
    });
    
    await runTest('rollbackAndReplay handles no checkpoint fallback', async () => {
        const { manager, setTick, getAppliedActions, clearAppliedActions } = createTestRollbackManager();
        
        // No checkpoints saved, at tick 10
        setTick(10);
        clearAppliedActions();
        
        // Receive action from tick 5
        const action = { type: 'place_factory', x: 5, y: 5 };
        await manager.rollbackAndReplay(5, action, 2);

        // Should still apply the action (fallback behavior)
        const applied = getAppliedActions();
        assert(applied.length === 1, 'Should have applied the action as fallback');
        assert(applied[0].action.type === 'place_factory', 'Should have applied the factory action');
    });
    
    await runTest('rollbackAndReplay updates stats', async () => {
        const { manager, setTick } = createTestRollbackManager();
        
        setTick(0);
        await manager.saveCheckpoint();
        setTick(10);
        
        const action = { type: 'demolish', x: 1, y: 1 };
        await manager.rollbackAndReplay(5, action, 2);

        const stats = manager.getStats();
        assert(stats.rollbackCount === 1, 'Should have 1 rollback');
        assert(stats.totalSimStepsReplayed === 10, `Should have 10 sim steps replayed, got ${stats.totalSimStepsReplayed}`);
    });
    
    logSection('RollbackManager - Clear and Reset');
    
    await runTest('clear removes all checkpoints and actions', async () => {
        const { manager, checkpointBuffer, actionQueue, setTick } = createTestRollbackManager();
        
        // Add some data
        setTick(10);
        await manager.saveCheckpoint();
        manager.storeLocalAction({ type: 'test' }, 1);
        
        assert(checkpointBuffer.checkpoints.length === 1, 'Should have checkpoint before clear');
        assert(actionQueue.actions.length === 1, 'Should have action before clear');
        
        // Clear
        manager.clear();
        
        assert(checkpointBuffer.checkpoints.length === 0, 'Checkpoints should be cleared');
        assert(actionQueue.actions.length === 0, 'Actions should be cleared');
    });
    
    await runTest('getStats returns comprehensive statistics', async () => {
        const { manager, setTick } = createTestRollbackManager();
        
        setTick(10);
        await manager.saveCheckpoint();
        manager.storeLocalAction({ type: 'test' }, 1);
        
        const stats = manager.getStats();
        assert(stats.rollbackCount !== undefined, 'Should have rollbackCount');
        assert(stats.checkpointCount !== undefined, 'Should have checkpointCount');
        assert(stats.actionQueueSize !== undefined, 'Should have actionQueueSize');
        assert(stats.checkpointCount === 1, 'Should have 1 checkpoint');
        assert(stats.actionQueueSize === 1, 'Should have 1 action');
    });
}
