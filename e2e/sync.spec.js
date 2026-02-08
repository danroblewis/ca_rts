import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const GRID_SIZE = 512;

async function setupRoom(browser) {
    const room = 'e2e-sync-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const ctx1 = await browser.newContext({});
    const ctx2 = await browser.newContext({});
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    await p1.goto(`/?room=${room}&player=1`);
    await p2.goto(`/?room=${room}&player=2`);

    await p1.waitForFunction(
        () => window.game?.isMultiplayer && window.game?.connectedPlayers?.size >= 2,
        { timeout: 15000 }
    );
    await p2.waitForFunction(
        () => window.game?.isMultiplayer && window.game?.connectedPlayers?.size >= 2,
        { timeout: 15000 }
    );

    return { p1, p2, ctx1, ctx2, room };
}

async function freezeAtTick(page, tick) {
    await page.evaluate((t) => {
        const game = window.game;
        // Store the true original only once so we can restore it later
        if (!game._origSimulationStep) {
            game._origSimulationStep = game.simulationStep.bind(game);
        }
        const orig = game._origSimulationStep;
        game.simulationStep = async function () {
            if (Math.floor(game.simTime) >= t) return;
            return orig();
        };
    }, tick);
}

async function unfreezeSimulation(page) {
    await page.evaluate(() => {
        const game = window.game;
        if (game._origSimulationStep) {
            game.simulationStep = game._origSimulationStep;
        }
    });
}

async function freezeBothAndWait(p1, p2, targetTick) {
    await freezeAtTick(p1, targetTick);
    await freezeAtTick(p2, targetTick);

    await p1.waitForFunction(
        (t) => Math.floor(window.game.simTime) >= t,
        targetTick,
        { timeout: 30000 }
    );
    await p2.waitForFunction(
        (t) => Math.floor(window.game.simTime) >= t,
        targetTick,
        { timeout: 30000 }
    );

    // Let pending network actions settle
    await p1.waitForTimeout(1000);
}

async function compareGrids(p1, p2) {
    const grid1 = await p1.evaluate(async () => Array.from(await window.game.grid.download()));
    const grid2 = await p2.evaluate(async () => Array.from(await window.game.grid.download()));

    let diffs = 0;
    let firstDiff = null;
    for (let i = 0; i < grid1.length; i++) {
        if (grid1[i] !== grid2[i]) {
            if (!firstDiff) firstDiff = { index: i, v1: grid1[i], v2: grid2[i] };
            diffs++;
        }
    }
    return { diffs, firstDiff };
}

/** Scan the grid for factory cell types (3 = P1, 7 = P2) and count unique centers. */
async function getFactoryCounts(page) {
    return await page.evaluate(async () => {
        const data = Array.from(await window.game.grid.download());
        const gridSize = 512;
        const seen = { 1: new Set(), 2: new Set() };

        for (let y = 0; y < gridSize; y++) {
            for (let x = 0; x < gridSize; x++) {
                const idx = (y * gridSize + x) * 4;
                const cellType = Math.round(data[idx]);
                if (cellType === 3 || cellType === 7) {
                    const cx = Math.round(data[idx + 2]);
                    const cy = Math.round(data[idx + 3]);
                    const key = `${cx},${cy}`;
                    if (cellType === 3) seen[1].add(key);
                    else seen[2].add(key);
                }
            }
        }
        return { p1: seen[1].size, p2: seen[2].size };
    });
}

async function getGameState(page) {
    return await page.evaluate(async () => ({
        simTime: Math.floor(window.game.simTime),
        playerFactoryCounts: { ...window.game.playerFactoryCounts },
        playerTotalFactoriesPlaced: { ...window.game.playerTotalFactoriesPlaced },
        gameOver: window.game.winConditionManager.gameOver,
        winner: window.game.winConditionManager.winner,
    }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('two players stay in sync for 10 seconds', async ({ browser }) => {
    const { p1, p2, ctx1, ctx2 } = await setupRoom(browser);

    await p1.evaluate(async () => { await window.game.handlePlaceFactory(100, 100); });
    await p2.evaluate(async () => { await window.game.handlePlaceFactory(400, 400); });

    await p1.waitForTimeout(8000);

    const targetTick = await p1.evaluate(() => Math.floor(window.game.simTime)) + 120;
    await freezeBothAndWait(p1, p2, targetTick);

    const { diffs, firstDiff } = await compareGrids(p1, p2);
    expect(diffs, `Grids diverged: ${diffs} differences, first at index ${firstDiff?.index}`).toBe(0);

    await ctx1.close();
    await ctx2.close();
});

test('both factories replicate to opponent', async ({ browser }) => {
    const { p1, p2, ctx1, ctx2 } = await setupRoom(browser);

    await p1.evaluate(async () => { await window.game.handlePlaceFactory(100, 100); });
    await p2.evaluate(async () => { await window.game.handlePlaceFactory(400, 400); });

    // Wait past a periodic sync
    await p1.waitForTimeout(3000);

    const targetTick = await p1.evaluate(() => Math.floor(window.game.simTime)) + 60;
    await freezeBothAndWait(p1, p2, targetTick);

    // Count factories on both pages
    const countsOnP1 = await getFactoryCounts(p1);
    const countsOnP2 = await getFactoryCounts(p2);

    expect(countsOnP1.p1, 'P1 page should see 1 P1 factory').toBe(1);
    expect(countsOnP1.p2, 'P1 page should see 1 P2 factory').toBe(1);
    expect(countsOnP2.p1, 'P2 page should see 1 P1 factory').toBe(1);
    expect(countsOnP2.p2, 'P2 page should see 1 P2 factory').toBe(1);

    // playerFactoryCounts should match actual grid counts
    const stateP1 = await getGameState(p1);
    const stateP2 = await getGameState(p2);
    expect(stateP1.playerFactoryCounts[1], 'P1 tracked count for player 1').toBe(countsOnP1.p1);
    expect(stateP1.playerFactoryCounts[2], 'P1 tracked count for player 2').toBe(countsOnP1.p2);
    expect(stateP2.playerFactoryCounts[1], 'P2 tracked count for player 1').toBe(countsOnP2.p1);
    expect(stateP2.playerFactoryCounts[2], 'P2 tracked count for player 2').toBe(countsOnP2.p2);

    // No false game-over
    expect(stateP1.gameOver, 'P1 should not see game over').toBe(false);
    expect(stateP2.gameOver, 'P2 should not see game over').toBe(false);

    await ctx1.close();
    await ctx2.close();
});

test('rapid factory placement from both players', async ({ browser }) => {
    const { p1, p2, ctx1, ctx2 } = await setupRoom(browser);

    // Initial factories
    await p1.evaluate(async () => { await window.game.handlePlaceFactory(100, 100); });
    await p2.evaluate(async () => { await window.game.handlePlaceFactory(400, 400); });
    await p1.waitForTimeout(2000);

    // P1 rapid-fires 3 more factories
    await p1.evaluate(async () => {
        const coords = [[100, 200], [100, 300], [200, 100]];
        for (const [x, y] of coords) {
            await window.game.handlePlaceFactory(x, y);
            await new Promise(r => setTimeout(r, 50));
        }
    });

    // P2 rapid-fires 3 more factories
    await p2.evaluate(async () => {
        const coords = [[400, 300], [400, 200], [300, 400]];
        for (const [x, y] of coords) {
            await window.game.handlePlaceFactory(x, y);
            await new Promise(r => setTimeout(r, 50));
        }
    });

    await p1.waitForTimeout(5000);

    const targetTick = await p1.evaluate(() => Math.floor(window.game.simTime)) + 120;
    await freezeBothAndWait(p1, p2, targetTick);

    const { diffs, firstDiff } = await compareGrids(p1, p2);
    expect(diffs, `Grids diverged: ${diffs} differences, first at index ${firstDiff?.index}`).toBe(0);

    // Both pages must agree on factory counts
    const countsOnP1 = await getFactoryCounts(p1);
    const countsOnP2 = await getFactoryCounts(p2);

    // Some placements may fail validation (units may have spread to target cells),
    // but both sides must agree on whatever survived
    expect(countsOnP1.p1, 'Both pages agree on P1 factories').toBe(countsOnP2.p1);
    expect(countsOnP1.p2, 'Both pages agree on P2 factories').toBe(countsOnP2.p2);

    // At minimum the initial factory from each player should survive
    expect(countsOnP1.p1, 'P1 has at least 1 factory').toBeGreaterThanOrEqual(1);
    expect(countsOnP1.p2, 'P2 has at least 1 factory').toBeGreaterThanOrEqual(1);

    // Most placements should succeed — at least 3 of 4 each
    expect(countsOnP1.p1, 'P1 has at least 3 factories').toBeGreaterThanOrEqual(3);
    expect(countsOnP1.p2, 'P2 has at least 3 factories').toBeGreaterThanOrEqual(3);

    await ctx1.close();
    await ctx2.close();
});

test('simultaneous factory placement at nearly the same tick', async ({ browser }) => {
    const { p1, p2, ctx1, ctx2 } = await setupRoom(browser);

    // Both place concurrently — deterministic ordering via playerId must resolve
    await Promise.all([
        p1.evaluate(async () => { await window.game.handlePlaceFactory(100, 100); }),
        p2.evaluate(async () => { await window.game.handlePlaceFactory(400, 400); }),
    ]);

    // Wait for rollback resolution and replication
    await p1.waitForTimeout(5000);

    const targetTick = await p1.evaluate(() => Math.floor(window.game.simTime)) + 120;
    await freezeBothAndWait(p1, p2, targetTick);

    // Critical: grids must be identical — no divergence from same-tick ordering
    const { diffs, firstDiff } = await compareGrids(p1, p2);
    expect(diffs, `Grids diverged: ${diffs} differences, first at index ${firstDiff?.index}`).toBe(0);

    // Both pages must agree on factory counts (whatever the rollback settled on)
    const countsOnP1 = await getFactoryCounts(p1);
    const countsOnP2 = await getFactoryCounts(p2);
    expect(countsOnP1.p1, 'Both pages agree on P1 factories').toBe(countsOnP2.p1);
    expect(countsOnP1.p2, 'Both pages agree on P2 factories').toBe(countsOnP2.p2);

    // At least one factory must exist (game shouldn't silently lose everything)
    expect(countsOnP1.p1 + countsOnP1.p2, 'At least one factory survived').toBeGreaterThanOrEqual(1);

    await ctx1.close();
    await ctx2.close();
});

test('factory persists through opponent rollback', async ({ browser }) => {
    const { p1, p2, ctx1, ctx2 } = await setupRoom(browser);

    // P1 places factory
    await p1.evaluate(async () => { await window.game.handlePlaceFactory(100, 100); });

    // Wait for checkpoints to be saved after P1's factory
    await p1.waitForTimeout(3000);

    // P2 places factory (triggers rollback on P1)
    await p2.evaluate(async () => { await window.game.handlePlaceFactory(400, 400); });

    await p1.waitForTimeout(3000);

    const targetTick = await p1.evaluate(() => Math.floor(window.game.simTime)) + 60;
    await freezeBothAndWait(p1, p2, targetTick);

    // P1's factory must still exist on both grids
    const countsOnP1 = await getFactoryCounts(p1);
    const countsOnP2 = await getFactoryCounts(p2);

    expect(countsOnP1.p1, 'P1 page: P1 factory count >= 1').toBeGreaterThanOrEqual(1);
    expect(countsOnP2.p1, 'P2 page: P1 factory count >= 1').toBeGreaterThanOrEqual(1);
    expect(countsOnP1.p2, 'P1 page: P2 factory exists').toBeGreaterThanOrEqual(1);
    expect(countsOnP2.p2, 'P2 page: P2 factory exists').toBeGreaterThanOrEqual(1);

    // Grids must be identical
    const { diffs, firstDiff } = await compareGrids(p1, p2);
    expect(diffs, `Grids diverged: ${diffs} differences, first at index ${firstDiff?.index}`).toBe(0);

    await ctx1.close();
    await ctx2.close();
});

test('no false game-over for 30 seconds', async ({ browser }) => {
    const { p1, p2, ctx1, ctx2 } = await setupRoom(browser);

    await p1.evaluate(async () => { await window.game.handlePlaceFactory(100, 100); });
    await p2.evaluate(async () => { await window.game.handlePlaceFactory(400, 400); });

    // Let simulation run for 30 seconds (6+ periodic syncs, many win condition checks)
    await p1.waitForTimeout(30000);

    const targetTick = await p1.evaluate(() => Math.floor(window.game.simTime)) + 120;
    await freezeBothAndWait(p1, p2, targetTick);

    const stateP1 = await getGameState(p1);
    const stateP2 = await getGameState(p2);

    expect(stateP1.gameOver, 'P1 should not see game over').toBe(false);
    expect(stateP2.gameOver, 'P2 should not see game over').toBe(false);

    // Actual factory count >= 1 for both players on both pages
    const countsOnP1 = await getFactoryCounts(p1);
    const countsOnP2 = await getFactoryCounts(p2);

    expect(countsOnP1.p1, 'P1 page: P1 factories >= 1').toBeGreaterThanOrEqual(1);
    expect(countsOnP1.p2, 'P1 page: P2 factories >= 1').toBeGreaterThanOrEqual(1);
    expect(countsOnP2.p1, 'P2 page: P1 factories >= 1').toBeGreaterThanOrEqual(1);
    expect(countsOnP2.p2, 'P2 page: P2 factories >= 1').toBeGreaterThanOrEqual(1);

    const { diffs, firstDiff } = await compareGrids(p1, p2);
    expect(diffs, `Grids diverged: ${diffs} differences, first at index ${firstDiff?.index}`).toBe(0);

    await ctx1.close();
    await ctx2.close();
});

test('factory counts stay consistent across periodic syncs', async ({ browser }) => {
    const { p1, p2, ctx1, ctx2 } = await setupRoom(browser);

    // Place 2 factories each with 1s between
    await p1.evaluate(async () => { await window.game.handlePlaceFactory(100, 100); });
    await p1.waitForTimeout(1000);
    await p2.evaluate(async () => { await window.game.handlePlaceFactory(400, 400); });
    await p1.waitForTimeout(1000);
    await p1.evaluate(async () => { await window.game.handlePlaceFactory(100, 200); });
    await p1.waitForTimeout(1000);
    await p2.evaluate(async () => { await window.game.handlePlaceFactory(400, 300); });

    // Check at ~5s
    await p1.waitForTimeout(2000);

    let targetTick = await p1.evaluate(() => Math.floor(window.game.simTime)) + 60;
    await freezeBothAndWait(p1, p2, targetTick);

    let stateP1 = await getGameState(p1);
    let stateP2 = await getGameState(p2);
    let gridCountsP1 = await getFactoryCounts(p1);
    let gridCountsP2 = await getFactoryCounts(p2);

    // Both pages should agree on counts
    expect(stateP1.playerFactoryCounts[1], '5s: P1 tracked P1 count').toBe(stateP2.playerFactoryCounts[1]);
    expect(stateP1.playerFactoryCounts[2], '5s: P1 tracked P2 count').toBe(stateP2.playerFactoryCounts[2]);

    // Tracked counts should match actual grid
    expect(gridCountsP1.p1, '5s: P1 grid P1 matches tracked').toBe(stateP1.playerFactoryCounts[1]);
    expect(gridCountsP1.p2, '5s: P1 grid P2 matches tracked').toBe(stateP1.playerFactoryCounts[2]);
    expect(gridCountsP2.p1, '5s: P2 grid P1 matches tracked').toBe(stateP2.playerFactoryCounts[1]);
    expect(gridCountsP2.p2, '5s: P2 grid P2 matches tracked').toBe(stateP2.playerFactoryCounts[2]);

    // Unfreeze and let simulation continue
    await unfreezeSimulation(p1);
    await unfreezeSimulation(p2);

    await p1.waitForTimeout(5000);

    targetTick = await p1.evaluate(() => Math.floor(window.game.simTime)) + 60;
    await freezeBothAndWait(p1, p2, targetTick);

    stateP1 = await getGameState(p1);
    stateP2 = await getGameState(p2);
    gridCountsP1 = await getFactoryCounts(p1);
    gridCountsP2 = await getFactoryCounts(p2);

    expect(stateP1.playerFactoryCounts[1], '10s: P1 tracked P1 count').toBe(stateP2.playerFactoryCounts[1]);
    expect(stateP1.playerFactoryCounts[2], '10s: P1 tracked P2 count').toBe(stateP2.playerFactoryCounts[2]);
    expect(gridCountsP1.p1, '10s: P1 grid P1 matches tracked').toBe(stateP1.playerFactoryCounts[1]);
    expect(gridCountsP1.p2, '10s: P1 grid P2 matches tracked').toBe(stateP1.playerFactoryCounts[2]);
    expect(gridCountsP2.p1, '10s: P2 grid P1 matches tracked').toBe(stateP2.playerFactoryCounts[1]);
    expect(gridCountsP2.p2, '10s: P2 grid P2 matches tracked').toBe(stateP2.playerFactoryCounts[2]);

    await ctx1.close();
    await ctx2.close();
});

test('place factory during active rollback window', async ({ browser }) => {
    const { p1, p2, ctx1, ctx2 } = await setupRoom(browser);

    // P1 places first factory
    await p1.evaluate(async () => { await window.game.handlePlaceFactory(100, 100); });
    await p1.waitForTimeout(2000);

    // P2 places factory (triggers rollback on P1)
    await p2.evaluate(async () => { await window.game.handlePlaceFactory(400, 400); });

    // Shortly after, P1 places a second factory while P1 might still be processing rollback
    await p1.waitForTimeout(500);
    await p1.evaluate(async () => { await window.game.handlePlaceFactory(200, 200); });

    await p1.waitForTimeout(5000);

    const targetTick = await p1.evaluate(() => Math.floor(window.game.simTime)) + 120;
    await freezeBothAndWait(p1, p2, targetTick);

    // Critical: grids must be identical regardless of how many factories survived
    const { diffs, firstDiff } = await compareGrids(p1, p2);
    expect(diffs, `Grids diverged: ${diffs} differences, first at index ${firstDiff?.index}`).toBe(0);

    // Both pages must agree on factory counts
    const countsOnP1 = await getFactoryCounts(p1);
    const countsOnP2 = await getFactoryCounts(p2);

    // P1 should have at least the original factory, and P2 should have theirs
    expect(countsOnP1.p1, 'P1 page: P1 factories >= 1').toBeGreaterThanOrEqual(1);
    expect(countsOnP1.p2, 'P1 page: P2 factory').toBe(1);
    expect(countsOnP2.p1, 'P2 page: P1 factories >= 1').toBeGreaterThanOrEqual(1);
    expect(countsOnP2.p2, 'P2 page: P2 factory').toBe(1);
    // Both pages must agree on exact P1 factory count
    expect(countsOnP1.p1, 'Both pages agree on P1 factories').toBe(countsOnP2.p1);

    await ctx1.close();
    await ctx2.close();
});

test('demolish + place cycle stays in sync', async ({ browser }) => {
    const { p1, p2, ctx1, ctx2 } = await setupRoom(browser);

    // Both place factories
    await p1.evaluate(async () => { await window.game.handlePlaceFactory(100, 100); });
    await p2.evaluate(async () => { await window.game.handlePlaceFactory(400, 400); });
    await p1.waitForTimeout(2000);

    // P1 demolishes own factory at (100, 100)
    await p1.evaluate(async () => { await window.game.handleDemolish(100, 100); });
    await p1.waitForTimeout(2000);

    // P1 places new factory at (200, 200)
    await p1.evaluate(async () => { await window.game.handlePlaceFactory(200, 200); });
    await p1.waitForTimeout(3000);

    const targetTick = await p1.evaluate(() => Math.floor(window.game.simTime)) + 120;
    await freezeBothAndWait(p1, p2, targetTick);

    const { diffs, firstDiff } = await compareGrids(p1, p2);
    expect(diffs, `Grids diverged: ${diffs} differences, first at index ${firstDiff?.index}`).toBe(0);

    // P1 should have 1 factory (the new one), not the demolished one
    const countsOnP1 = await getFactoryCounts(p1);
    const countsOnP2 = await getFactoryCounts(p2);

    expect(countsOnP1.p1, 'P1 page: P1 factory count = 1').toBe(1);
    expect(countsOnP2.p1, 'P2 page: P1 factory count = 1').toBe(1);

    await ctx1.close();
    await ctx2.close();
});

// ---------------------------------------------------------------------------
// Latency injection helper
// ---------------------------------------------------------------------------

async function injectLatency(page, latencyMs, { jitter = 0.1 } = {}) {
    await page.evaluate(({ latency, jitterFrac }) => {
        const ns = window.game.networkSync;
        const ws = ns.ws;

        // Helper: jittered delay
        const delay = () => latency + (Math.random() * 2 - 1) * latency * jitterFrac;

        // Patch outgoing: send() and sendBinary()
        const origSend = ns.send.bind(ns);
        const origSendBinary = ns.sendBinary.bind(ns);
        ns.send = (msg) => setTimeout(() => origSend(msg), delay());
        ns.sendBinary = (buf) => setTimeout(() => origSendBinary(buf), delay());

        // Patch incoming: ws.onmessage
        const origOnMessage = ws.onmessage;
        ws.onmessage = (event) => setTimeout(() => origOnMessage(event), delay());
    }, { latency: latencyMs, jitterFrac: jitter });
}

// ---------------------------------------------------------------------------
// Latency stress tests
// ---------------------------------------------------------------------------

test.describe('latency stress tests', () => {
    test('factories replicate under 200ms latency', async ({ browser }) => {
        const { p1, p2, ctx1, ctx2 } = await setupRoom(browser);

        await injectLatency(p1, 200);
        await injectLatency(p2, 200);

        await p1.evaluate(async () => { await window.game.handlePlaceFactory(100, 100); });
        await p2.evaluate(async () => { await window.game.handlePlaceFactory(400, 400); });

        await p1.waitForTimeout(5000);

        const targetTick = await p1.evaluate(() => Math.floor(window.game.simTime)) + 120;
        await freezeBothAndWait(p1, p2, targetTick);

        const { diffs, firstDiff } = await compareGrids(p1, p2);
        expect(diffs, `Grids diverged: ${diffs} differences, first at index ${firstDiff?.index}`).toBe(0);

        const countsOnP1 = await getFactoryCounts(p1);
        const countsOnP2 = await getFactoryCounts(p2);

        expect(countsOnP1.p1, 'P1 page: P1 factory = 1').toBe(1);
        expect(countsOnP1.p2, 'P1 page: P2 factory = 1').toBe(1);
        expect(countsOnP2.p1, 'P2 page: P1 factory = 1').toBe(1);
        expect(countsOnP2.p2, 'P2 page: P2 factory = 1').toBe(1);

        const stateP1 = await getGameState(p1);
        const stateP2 = await getGameState(p2);
        expect(stateP1.gameOver, 'P1 no game over').toBe(false);
        expect(stateP2.gameOver, 'P2 no game over').toBe(false);

        await ctx1.close();
        await ctx2.close();
    });

    test('factories replicate under 500ms latency', async ({ browser }) => {
        const { p1, p2, ctx1, ctx2 } = await setupRoom(browser);

        await injectLatency(p1, 500);
        await injectLatency(p2, 500);

        await p1.evaluate(async () => { await window.game.handlePlaceFactory(100, 100); });
        await p2.evaluate(async () => { await window.game.handlePlaceFactory(400, 400); });

        await p1.waitForTimeout(8000);

        const targetTick = await p1.evaluate(() => Math.floor(window.game.simTime)) + 120;
        await freezeBothAndWait(p1, p2, targetTick);

        const { diffs, firstDiff } = await compareGrids(p1, p2);
        expect(diffs, `Grids diverged: ${diffs} differences, first at index ${firstDiff?.index}`).toBe(0);

        const countsOnP1 = await getFactoryCounts(p1);
        const countsOnP2 = await getFactoryCounts(p2);

        expect(countsOnP1.p1, 'P1 page: P1 factory = 1').toBe(1);
        expect(countsOnP1.p2, 'P1 page: P2 factory = 1').toBe(1);
        expect(countsOnP2.p1, 'P2 page: P1 factory = 1').toBe(1);
        expect(countsOnP2.p2, 'P2 page: P2 factory = 1').toBe(1);

        const stateP1 = await getGameState(p1);
        const stateP2 = await getGameState(p2);
        expect(stateP1.gameOver, 'P1 no game over').toBe(false);
        expect(stateP2.gameOver, 'P2 no game over').toBe(false);

        await ctx1.close();
        await ctx2.close();
    });

    test('rapid placement under 200ms latency', async ({ browser }) => {
        const { p1, p2, ctx1, ctx2 } = await setupRoom(browser);

        await injectLatency(p1, 200);
        await injectLatency(p2, 200);

        // Initial factories
        await p1.evaluate(async () => { await window.game.handlePlaceFactory(100, 100); });
        await p2.evaluate(async () => { await window.game.handlePlaceFactory(400, 400); });
        await p1.waitForTimeout(3000);

        // P1 rapid-fires 3 more factories
        await p1.evaluate(async () => {
            const coords = [[100, 200], [100, 300], [200, 100]];
            for (const [x, y] of coords) {
                await window.game.handlePlaceFactory(x, y);
                await new Promise(r => setTimeout(r, 50));
            }
        });

        // P2 rapid-fires 3 more factories
        await p2.evaluate(async () => {
            const coords = [[400, 300], [400, 200], [300, 400]];
            for (const [x, y] of coords) {
                await window.game.handlePlaceFactory(x, y);
                await new Promise(r => setTimeout(r, 50));
            }
        });

        await p1.waitForTimeout(8000);

        const targetTick = await p1.evaluate(() => Math.floor(window.game.simTime)) + 120;
        await freezeBothAndWait(p1, p2, targetTick);

        const { diffs, firstDiff } = await compareGrids(p1, p2);
        expect(diffs, `Grids diverged: ${diffs} differences, first at index ${firstDiff?.index}`).toBe(0);

        const countsOnP1 = await getFactoryCounts(p1);
        const countsOnP2 = await getFactoryCounts(p2);

        expect(countsOnP1.p1, 'Both pages agree on P1 factories').toBe(countsOnP2.p1);
        expect(countsOnP1.p2, 'Both pages agree on P2 factories').toBe(countsOnP2.p2);
        expect(countsOnP1.p1, 'P1 has at least 3 factories').toBeGreaterThanOrEqual(3);
        expect(countsOnP1.p2, 'P2 has at least 3 factories').toBeGreaterThanOrEqual(3);

        await ctx1.close();
        await ctx2.close();
    });

    test('asymmetric latency: P1=300ms, P2=50ms', async ({ browser }) => {
        const { p1, p2, ctx1, ctx2 } = await setupRoom(browser);

        await injectLatency(p1, 300);
        await injectLatency(p2, 50);

        await p1.evaluate(async () => { await window.game.handlePlaceFactory(100, 100); });
        await p2.evaluate(async () => { await window.game.handlePlaceFactory(400, 400); });

        await p1.waitForTimeout(6000);

        const targetTick = await p1.evaluate(() => Math.floor(window.game.simTime)) + 120;
        await freezeBothAndWait(p1, p2, targetTick);

        const { diffs, firstDiff } = await compareGrids(p1, p2);
        expect(diffs, `Grids diverged: ${diffs} differences, first at index ${firstDiff?.index}`).toBe(0);

        const countsOnP1 = await getFactoryCounts(p1);
        const countsOnP2 = await getFactoryCounts(p2);

        expect(countsOnP1.p1, 'P1 page: P1 factory = 1').toBe(1);
        expect(countsOnP1.p2, 'P1 page: P2 factory = 1').toBe(1);
        expect(countsOnP2.p1, 'P2 page: P1 factory = 1').toBe(1);
        expect(countsOnP2.p2, 'P2 page: P2 factory = 1').toBe(1);

        const stateP1 = await getGameState(p1);
        const stateP2 = await getGameState(p2);
        expect(stateP1.gameOver, 'P1 no game over').toBe(false);
        expect(stateP2.gameOver, 'P2 no game over').toBe(false);

        await ctx1.close();
        await ctx2.close();
    });

    test('no false game-over under 200ms latency for 30 seconds', async ({ browser }) => {
        const { p1, p2, ctx1, ctx2 } = await setupRoom(browser);

        await injectLatency(p1, 200);
        await injectLatency(p2, 200);

        await p1.evaluate(async () => { await window.game.handlePlaceFactory(100, 100); });
        await p2.evaluate(async () => { await window.game.handlePlaceFactory(400, 400); });

        // Let simulation run for 30 seconds under latency
        await p1.waitForTimeout(30000);

        const targetTick = await p1.evaluate(() => Math.floor(window.game.simTime)) + 120;
        await freezeBothAndWait(p1, p2, targetTick);

        const stateP1 = await getGameState(p1);
        const stateP2 = await getGameState(p2);

        expect(stateP1.gameOver, 'P1 should not see game over').toBe(false);
        expect(stateP2.gameOver, 'P2 should not see game over').toBe(false);

        const countsOnP1 = await getFactoryCounts(p1);
        const countsOnP2 = await getFactoryCounts(p2);

        expect(countsOnP1.p1, 'P1 page: P1 factories >= 1').toBeGreaterThanOrEqual(1);
        expect(countsOnP1.p2, 'P1 page: P2 factories >= 1').toBeGreaterThanOrEqual(1);
        expect(countsOnP2.p1, 'P2 page: P1 factories >= 1').toBeGreaterThanOrEqual(1);
        expect(countsOnP2.p2, 'P2 page: P2 factories >= 1').toBeGreaterThanOrEqual(1);

        const { diffs, firstDiff } = await compareGrids(p1, p2);
        expect(diffs, `Grids diverged: ${diffs} differences, first at index ${firstDiff?.index}`).toBe(0);

        await ctx1.close();
        await ctx2.close();
    });

    test('factory persists through rollback under 300ms latency', async ({ browser }) => {
        const { p1, p2, ctx1, ctx2 } = await setupRoom(browser);

        await injectLatency(p1, 300);
        await injectLatency(p2, 300);

        // P1 places factory
        await p1.evaluate(async () => { await window.game.handlePlaceFactory(100, 100); });

        // Wait for checkpoints to be saved after P1's factory
        await p1.waitForTimeout(5000);

        // P2 places factory (triggers rollback on P1)
        await p2.evaluate(async () => { await window.game.handlePlaceFactory(400, 400); });

        await p1.waitForTimeout(8000);

        const targetTick = await p1.evaluate(() => Math.floor(window.game.simTime)) + 120;
        await freezeBothAndWait(p1, p2, targetTick);

        const { diffs, firstDiff } = await compareGrids(p1, p2);
        expect(diffs, `Grids diverged: ${diffs} differences, first at index ${firstDiff?.index}`).toBe(0);

        const countsOnP1 = await getFactoryCounts(p1);
        const countsOnP2 = await getFactoryCounts(p2);

        expect(countsOnP1.p1, 'P1 page: P1 factory >= 1').toBeGreaterThanOrEqual(1);
        expect(countsOnP1.p2, 'P1 page: P2 factory >= 1').toBeGreaterThanOrEqual(1);
        expect(countsOnP2.p1, 'P2 page: P1 factory >= 1').toBeGreaterThanOrEqual(1);
        expect(countsOnP2.p2, 'P2 page: P2 factory >= 1').toBeGreaterThanOrEqual(1);

        await ctx1.close();
        await ctx2.close();
    });
});
