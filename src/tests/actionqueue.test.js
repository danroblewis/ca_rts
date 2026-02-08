/**
 * ActionQueue Unit Tests
 * Tests for network/ActionQueue.js
 * Pure JS, no GPU needed.
 */

import { runTest, assert, logSection } from './framework.js';
import { ActionQueue } from '../network/ActionQueue.js';

export async function runActionQueueTests() {
    // ========================================================================
    // Insertion & Ordering
    // ========================================================================
    logSection('ActionQueue - Insertion & Ordering');

    await runTest('ActionQueue: single insert stores action correctly', async () => {
        const q = new ActionQueue();
        const action = q.addAction(5, 1, 'place_factory', { x: 10, y: 20 });
        assert(action.tick === 5, `tick should be 5, got ${action.tick}`);
        assert(action.playerId === 1, `playerId should be 1, got ${action.playerId}`);
        assert(action.type === 'place_factory', `type should be place_factory, got ${action.type}`);
        assert(action.data.x === 10, `data.x should be 10, got ${action.data.x}`);
        assert(action.data.y === 20, `data.y should be 20, got ${action.data.y}`);
        assert(q.actions.length === 1, `should have 1 action, got ${q.actions.length}`);
    });

    await runTest('ActionQueue: chronological inserts stay in order', async () => {
        const q = new ActionQueue();
        q.addAction(1, 1, 'a', {});
        q.addAction(2, 1, 'b', {});
        q.addAction(3, 1, 'c', {});
        assert(q.actions[0].tick === 1, 'first should be tick 1');
        assert(q.actions[1].tick === 2, 'second should be tick 2');
        assert(q.actions[2].tick === 3, 'third should be tick 3');
    });

    await runTest('ActionQueue: out-of-order inserts are sorted correctly', async () => {
        const q = new ActionQueue();
        q.addAction(10, 1, 'late', {});
        q.addAction(5, 2, 'early', {});
        q.addAction(7, 1, 'mid', {});
        assert(q.actions[0].tick === 5, `first should be tick 5, got ${q.actions[0].tick}`);
        assert(q.actions[1].tick === 7, `second should be tick 7, got ${q.actions[1].tick}`);
        assert(q.actions[2].tick === 10, `third should be tick 10, got ${q.actions[2].tick}`);
    });

    await runTest('ActionQueue: same-tick actions preserve insertion order', async () => {
        const q = new ActionQueue();
        q.addAction(5, 1, 'first', {});
        q.addAction(5, 2, 'second', {});
        q.addAction(5, 3, 'third', {});
        assert(q.actions[0].type === 'first', 'first inserted should be first');
        assert(q.actions[1].type === 'second', 'second inserted should be second');
        assert(q.actions[2].type === 'third', 'third inserted should be third');
    });

    await runTest('ActionQueue: addAction returns the action object', async () => {
        const q = new ActionQueue();
        const action = q.addAction(1, 1, 'test', { val: 42 });
        assert(action !== null && action !== undefined, 'should return an action');
        assert(action.data.val === 42, 'returned action should have correct data');
        assert(action === q.actions[0], 'returned action should be the same object in the queue');
    });

    await runTest('ActionQueue: tick 0 edge case works', async () => {
        const q = new ActionQueue();
        const action = q.addAction(0, 1, 'start', {});
        assert(action.tick === 0, 'tick should be 0');
        assert(q.actions.length === 1, 'should have 1 action');
        // Insert before tick 0 shouldn't be possible in practice, but check ordering
        q.addAction(1, 1, 'next', {});
        assert(q.actions[0].tick === 0, 'tick 0 should remain first');
    });

    await runTest('ActionQueue: applied flag defaults to false', async () => {
        const q = new ActionQueue();
        const a1 = q.addAction(1, 1, 'test', {});
        assert(a1.applied === false, 'default applied should be false');
        const a2 = q.addAction(2, 1, 'test', {}, true);
        assert(a2.applied === true, 'explicit true should be true');
    });

    // ========================================================================
    // Queries
    // ========================================================================
    logSection('ActionQueue - Queries');

    await runTest('ActionQueue: getActionsAtTick returns correct actions', async () => {
        const q = new ActionQueue();
        q.addAction(5, 1, 'a', {});
        q.addAction(5, 2, 'b', {});
        q.addAction(10, 1, 'c', {});
        const at5 = q.getActionsAtTick(5);
        assert(at5.length === 2, `should have 2 actions at tick 5, got ${at5.length}`);
        assert(at5[0].type === 'a', 'first action at tick 5');
        assert(at5[1].type === 'b', 'second action at tick 5');
    });

    await runTest('ActionQueue: getActionsAtTick returns empty for no match', async () => {
        const q = new ActionQueue();
        q.addAction(5, 1, 'a', {});
        const at10 = q.getActionsAtTick(10);
        assert(at10.length === 0, 'should have 0 actions at tick 10');
    });

    await runTest('ActionQueue: getActionsInRange exclusive start, inclusive end', async () => {
        const q = new ActionQueue();
        q.addAction(5, 1, 'a', {});
        q.addAction(10, 1, 'b', {});
        q.addAction(15, 1, 'c', {});
        q.addAction(20, 1, 'd', {});
        const range = q.getActionsInRange(5, 15);
        assert(range.length === 2, `should have 2 actions in range (5,15], got ${range.length}`);
        assert(range[0].tick === 10, 'first in range should be tick 10');
        assert(range[1].tick === 15, 'second in range should be tick 15');
    });

    await runTest('ActionQueue: getActionsInRange boundary - start tick excluded', async () => {
        const q = new ActionQueue();
        q.addAction(5, 1, 'boundary', {});
        const range = q.getActionsInRange(5, 10);
        assert(range.length === 0, `tick 5 should be excluded from (5,10], got ${range.length}`);
    });

    await runTest('ActionQueue: getActionsInRange boundary - end tick included', async () => {
        const q = new ActionQueue();
        q.addAction(10, 1, 'boundary', {});
        const range = q.getActionsInRange(5, 10);
        assert(range.length === 1, `tick 10 should be included in (5,10], got ${range.length}`);
    });

    await runTest('ActionQueue: hasAction positive match', async () => {
        const q = new ActionQueue();
        q.addAction(5, 1, 'place_factory', { x: 1, y: 1 });
        assert(q.hasAction(5, 1, 'place_factory') === true, 'should find the action');
    });

    await runTest('ActionQueue: hasAction negative - wrong tick/player/type', async () => {
        const q = new ActionQueue();
        q.addAction(5, 1, 'place_factory', {});
        assert(q.hasAction(6, 1, 'place_factory') === false, 'wrong tick should not match');
        assert(q.hasAction(5, 2, 'place_factory') === false, 'wrong player should not match');
        assert(q.hasAction(5, 1, 'demolish') === false, 'wrong type should not match');
    });

    // ========================================================================
    // Applied Status
    // ========================================================================
    logSection('ActionQueue - Applied Status');

    await runTest('ActionQueue: markApplied sets applied to true', async () => {
        const q = new ActionQueue();
        const action = q.addAction(5, 1, 'test', {});
        assert(action.applied === false, 'should start unapplied');
        q.markApplied(action);
        assert(action.applied === true, 'should be applied after markApplied');
    });

    await runTest('ActionQueue: resetAppliedAfter resets actions after tick', async () => {
        const q = new ActionQueue();
        q.addAction(5, 1, 'a', {}, true);
        q.addAction(10, 1, 'b', {}, true);
        q.addAction(15, 1, 'c', {}, true);
        q.resetAppliedAfter(10);
        assert(q.actions[0].applied === true, 'tick 5 should stay applied');
        assert(q.actions[1].applied === true, 'tick 10 should stay applied (boundary)');
        assert(q.actions[2].applied === false, 'tick 15 should be reset');
    });

    await runTest('ActionQueue: resetAppliedAfter with tick -1 resets all', async () => {
        const q = new ActionQueue();
        q.addAction(0, 1, 'a', {}, true);
        q.addAction(5, 1, 'b', {}, true);
        q.resetAppliedAfter(-1);
        assert(q.actions[0].applied === false, 'tick 0 should be reset');
        assert(q.actions[1].applied === false, 'tick 5 should be reset');
    });

    // ========================================================================
    // Garbage Collection
    // ========================================================================
    logSection('ActionQueue - Garbage Collection');

    await runTest('ActionQueue: setConfirmedTick removes old actions', async () => {
        const q = new ActionQueue();
        q.addAction(5, 1, 'old', {});
        q.addAction(100, 1, 'recent', {});
        q.addAction(400, 1, 'new', {});
        // confirmedTick=400, maxHistoryTicks=300, cutoff=100
        q.setConfirmedTick(400);
        assert(q.actions.length === 2, `should keep 2 actions (tick>=100), got ${q.actions.length}`);
        assert(q.actions[0].tick === 100, 'first remaining should be tick 100');
        assert(q.confirmedTick === 400, 'confirmedTick should be updated');
    });

    await runTest('ActionQueue: garbageCollectBeforeCheckpoint preserves unapplied', async () => {
        const q = new ActionQueue();
        q.addAction(5, 1, 'applied-old', {}, true);
        q.addAction(8, 1, 'unapplied-old', {}, false);
        q.addAction(15, 1, 'after-checkpoint', {}, true);
        q.garbageCollectBeforeCheckpoint(10);
        // tick 5 applied before checkpoint -> removed
        // tick 8 unapplied before checkpoint -> preserved
        // tick 15 after checkpoint -> preserved
        assert(q.actions.length === 2, `should keep 2 actions, got ${q.actions.length}`);
        assert(q.actions[0].tick === 8, 'unapplied old action should be preserved');
        assert(q.actions[1].tick === 15, 'action after checkpoint should be preserved');
    });

    await runTest('ActionQueue: garbageCollectBeforeCheckpoint preserves at/after checkpoint tick', async () => {
        const q = new ActionQueue();
        q.addAction(10, 1, 'at-checkpoint', {}, true);
        q.addAction(11, 1, 'after-checkpoint', {}, true);
        q.garbageCollectBeforeCheckpoint(10);
        assert(q.actions.length === 2, `should keep both actions at/after checkpoint, got ${q.actions.length}`);
    });

    // ========================================================================
    // Utility
    // ========================================================================
    logSection('ActionQueue - Utility');

    await runTest('ActionQueue: getOldestTick returns Infinity when empty', async () => {
        const q = new ActionQueue();
        assert(q.getOldestTick() === Infinity, `should be Infinity, got ${q.getOldestTick()}`);
    });

    await runTest('ActionQueue: clear resets all state', async () => {
        const q = new ActionQueue();
        q.addAction(5, 1, 'test', {});
        q.setConfirmedTick(100);
        q.clear();
        assert(q.actions.length === 0, 'actions should be empty');
        assert(q.confirmedTick === 0, 'confirmedTick should be 0');
    });

    await runTest('ActionQueue: getStats returns correct values', async () => {
        const q = new ActionQueue();
        q.addAction(5, 1, 'a', {});
        q.addAction(10, 1, 'b', {});
        q.addAction(15, 1, 'c', {});
        q.setConfirmedTick(3);
        const stats = q.getStats();
        assert(stats.count === 3, `count should be 3, got ${stats.count}`);
        assert(stats.confirmedTick === 3, `confirmedTick should be 3, got ${stats.confirmedTick}`);
        assert(stats.oldestTick === 5, `oldestTick should be 5, got ${stats.oldestTick}`);
        assert(stats.newestTick === 15, `newestTick should be 15, got ${stats.newestTick}`);
    });
}
