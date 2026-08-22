import { runTest, assert, logSection } from './framework.js';
import { WinConditionManager } from '../game/WinConditionManager.js';
import { PLAYER_1, PLAYER_2 } from '../utils/GameUtils.js';

export async function runWinConditionManagerTests() {
    logSection('WinConditionManager - Initialization');

    await runTest('WinConditionManager initializes with default state', async () => {
        const manager = new WinConditionManager({
            countFactories: () => ({ [PLAYER_1]: 0, [PLAYER_2]: 0 }),
            getPlayerTotalFactoriesPlaced: () => ({ [PLAYER_1]: 0, [PLAYER_2]: 0 })
        });
        
        assert(manager.gameOver === false, 'gameOver should be false initially');
        assert(manager.winner === null, 'winner should be null initially');
        assert(manager.intervalId === null, 'intervalId should be null before start');
    });

    await runTest('WinConditionManager uses provided callbacks', async () => {
        let countCalled = false;
        let totalCalled = false;

        const manager = new WinConditionManager({
            countFactories: async () => { countCalled = true; return { [PLAYER_1]: 1, [PLAYER_2]: 1 }; },
            getPlayerTotalFactoriesPlaced: () => { totalCalled = true; return { [PLAYER_1]: 1, [PLAYER_2]: 1 }; }
        });

        await manager.check();
        assert(countCalled === true, 'countFactories should be called');
        assert(totalCalled === true, 'getPlayerTotalFactoriesPlaced should be called');
    });

    logSection('WinConditionManager - Win/Lose Detection');

    await runTest('check returns false when no factories placed', async () => {
        const manager = new WinConditionManager({
            countFactories: async () => ({ [PLAYER_1]: 0, [PLAYER_2]: 0 }),
            getPlayerTotalFactoriesPlaced: () => ({ [PLAYER_1]: 0, [PLAYER_2]: 0 })
        });

        const result = await manager.check();
        assert(result === false, 'check should return false');
        assert(manager.gameOver === false, 'gameOver should remain false');
    });

    await runTest('check returns false when factories still exist', async () => {
        const manager = new WinConditionManager({
            countFactories: async () => ({ [PLAYER_1]: 2, [PLAYER_2]: 1 }),
            getPlayerTotalFactoriesPlaced: () => ({ [PLAYER_1]: 3, [PLAYER_2]: 2 })
        });

        const result = await manager.check();
        assert(result === false, 'check should return false when factories exist');
        assert(manager.gameOver === false, 'gameOver should remain false');
    });

    await runTest('check detects Player 1 loss (all bases destroyed)', async () => {
        let gameOverWinner = null;

        const manager = new WinConditionManager({
            countFactories: async () => ({ [PLAYER_1]: 0, [PLAYER_2]: 1 }),
            getPlayerTotalFactoriesPlaced: () => ({ [PLAYER_1]: 2, [PLAYER_2]: 1 }),
            onGameOver: (winner) => { gameOverWinner = winner; }
        });

        const result = await manager.check();
        assert(result === true, 'check should return true when game ends');
        assert(manager.gameOver === true, 'gameOver should be true');
        assert(manager.winner === PLAYER_2, 'winner should be PLAYER_2');
        assert(gameOverWinner === PLAYER_2, 'onGameOver should be called with PLAYER_2');
    });

    await runTest('check detects Player 2 loss (all bases destroyed)', async () => {
        let gameOverWinner = null;

        const manager = new WinConditionManager({
            countFactories: async () => ({ [PLAYER_1]: 3, [PLAYER_2]: 0 }),
            getPlayerTotalFactoriesPlaced: () => ({ [PLAYER_1]: 3, [PLAYER_2]: 1 }),
            onGameOver: (winner) => { gameOverWinner = winner; }
        });

        const result = await manager.check();
        assert(result === true, 'check should return true when game ends');
        assert(manager.gameOver === true, 'gameOver should be true');
        assert(manager.winner === PLAYER_1, 'winner should be PLAYER_1');
        assert(gameOverWinner === PLAYER_1, 'onGameOver should be called with PLAYER_1');
    });

    await runTest('check does not trigger when only one player has placed factories', async () => {
        const manager = new WinConditionManager({
            countFactories: async () => ({ [PLAYER_1]: 0, [PLAYER_2]: 1 }),
            getPlayerTotalFactoriesPlaced: () => ({ [PLAYER_1]: 0, [PLAYER_2]: 1 })
        });

        const result = await manager.check();
        assert(result === false, 'check should return false (P1 never placed anything)');
        assert(manager.gameOver === false, 'gameOver should remain false');
    });

    await runTest('check does not trigger until both players have placed', async () => {
        // P1 placed 1 factory and it got destroyed, but P2 never placed - no game over
        const manager = new WinConditionManager({
            countFactories: async () => ({ [PLAYER_1]: 0, [PLAYER_2]: 0 }),
            getPlayerTotalFactoriesPlaced: () => ({ [PLAYER_1]: 1, [PLAYER_2]: 0 })
        });

        const result = await manager.check();
        assert(result === false, 'check should return false (P2 has not placed yet)');
        assert(manager.gameOver === false, 'gameOver should remain false');
    });

    await runTest('check is not fooled by a factory placed while the grid readback is in flight', async () => {
        // Regression: P2's first factory gets applied DURING the (slow) GPU
        // readback. The readback data predates it, but totalPlaced (read after
        // the await) already counts it -> used to be a false "P2 lost".
        const totals = { [PLAYER_1]: 1, [PLAYER_2]: 0 };
        let gameOverCalled = false;
        const manager = new WinConditionManager({
            countFactories: async () => {
                await new Promise(r => setTimeout(r, 20));
                totals[PLAYER_2] = 1;                       // applied mid-readback
                return { [PLAYER_1]: 1, [PLAYER_2]: 0 };    // stale snapshot
            },
            getPlayerTotalFactoriesPlaced: () => totals,
            onGameOver: () => { gameOverCalled = true; }
        });

        const result = await manager.check();
        assert(result === false, 'no game over from a stale snapshot');
        assert(!gameOverCalled, 'onGameOver not called');
        assert(manager.gameOver === false, 'gameOver stays false');
    });

    await runTest('check calls onFactoryCountsUpdated', async () => {
        let updatedCounts = null;

        const manager = new WinConditionManager({
            countFactories: async () => ({ [PLAYER_1]: 5, [PLAYER_2]: 3 }),
            getPlayerTotalFactoriesPlaced: () => ({ [PLAYER_1]: 5, [PLAYER_2]: 3 }),
            onFactoryCountsUpdated: (counts) => { updatedCounts = counts; }
        });

        await manager.check();
        assert(updatedCounts !== null, 'onFactoryCountsUpdated should be called');
        assert(updatedCounts[PLAYER_1] === 5, 'P1 count should be 5');
        assert(updatedCounts[PLAYER_2] === 3, 'P2 count should be 3');
    });

    await runTest('check does nothing after game is over', async () => {
        let callCount = 0;

        const manager = new WinConditionManager({
            countFactories: async () => { callCount++; return { [PLAYER_1]: 0, [PLAYER_2]: 1 }; },
            getPlayerTotalFactoriesPlaced: () => ({ [PLAYER_1]: 1, [PLAYER_2]: 1 })
        });

        await manager.check(); // First check triggers game over
        const beforeCount = callCount;

        await manager.check(); // Second check should do nothing
        assert(callCount === beforeCount, 'countFactories should not be called after game over');
    });

    logSection('WinConditionManager - State Management');

    await runTest('isGameOver returns correct state', async () => {
        const manager = new WinConditionManager({
            countFactories: async () => ({ [PLAYER_1]: 0, [PLAYER_2]: 1 }),
            getPlayerTotalFactoriesPlaced: () => ({ [PLAYER_1]: 1, [PLAYER_2]: 1 })
        });

        assert(manager.isGameOver() === false, 'isGameOver should be false initially');
        await manager.check();
        assert(manager.isGameOver() === true, 'isGameOver should be true after loss');
    });

    await runTest('getWinner returns correct winner', async () => {
        const manager = new WinConditionManager({
            countFactories: async () => ({ [PLAYER_1]: 0, [PLAYER_2]: 1 }),
            getPlayerTotalFactoriesPlaced: () => ({ [PLAYER_1]: 1, [PLAYER_2]: 1 })
        });

        assert(manager.getWinner() === null, 'getWinner should be null initially');
        await manager.check();
        assert(manager.getWinner() === PLAYER_2, 'getWinner should return PLAYER_2');
    });

    await runTest('reset clears game state', async () => {
        const manager = new WinConditionManager({
            countFactories: async () => ({ [PLAYER_1]: 0, [PLAYER_2]: 1 }),
            getPlayerTotalFactoriesPlaced: () => ({ [PLAYER_1]: 1, [PLAYER_2]: 1 })
        });

        await manager.check();
        assert(manager.gameOver === true, 'gameOver should be true');

        manager.reset();
        assert(manager.gameOver === false, 'gameOver should be false after reset');
        assert(manager.winner === null, 'winner should be null after reset');
    });

    await runTest('setGameOver forces game end', async () => {
        let gameOverWinner = null;
        
        const manager = new WinConditionManager({
            countFactories: () => ({ [PLAYER_1]: 1, [PLAYER_2]: 1 }),
            getPlayerTotalFactoriesPlaced: () => ({ [PLAYER_1]: 1, [PLAYER_2]: 1 }),
            onGameOver: (winner) => { gameOverWinner = winner; }
        });
        
        manager.setGameOver(PLAYER_1);
        assert(manager.gameOver === true, 'gameOver should be true');
        assert(manager.winner === PLAYER_1, 'winner should be PLAYER_1');
        assert(gameOverWinner === PLAYER_1, 'onGameOver should be called');
    });

    logSection('WinConditionManager - Interval Control');

    await runTest('start creates interval', async () => {
        const manager = new WinConditionManager({
            countFactories: () => ({ [PLAYER_1]: 1, [PLAYER_2]: 1 }),
            getPlayerTotalFactoriesPlaced: () => ({ [PLAYER_1]: 1, [PLAYER_2]: 1 }),
            checkInterval: 10000
        });
        
        manager.start();
        assert(manager.intervalId !== null, 'intervalId should be set');
        manager.stop(); // Clean up
    });

    await runTest('start is idempotent', async () => {
        const manager = new WinConditionManager({
            countFactories: () => ({ [PLAYER_1]: 1, [PLAYER_2]: 1 }),
            getPlayerTotalFactoriesPlaced: () => ({ [PLAYER_1]: 1, [PLAYER_2]: 1 }),
            checkInterval: 10000
        });
        
        manager.start();
        const firstId = manager.intervalId;
        manager.start();
        assert(manager.intervalId === firstId, 'intervalId should not change on second start');
        manager.stop();
    });

    await runTest('stop clears interval', async () => {
        const manager = new WinConditionManager({
            countFactories: () => ({ [PLAYER_1]: 1, [PLAYER_2]: 1 }),
            getPlayerTotalFactoriesPlaced: () => ({ [PLAYER_1]: 1, [PLAYER_2]: 1 }),
            checkInterval: 10000
        });
        
        manager.start();
        manager.stop();
        assert(manager.intervalId === null, 'intervalId should be null after stop');
    });
}

