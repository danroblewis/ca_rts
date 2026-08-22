/**
 * Shared helpers for the two-browser e2e tests.
 */
import { expect } from '@playwright/test';

export const GRID_SIZE = 512;

/** Open two player pages in a fresh room and wait until both are in lockstep. */
export async function setupRoom(browser, { viewport = { width: 1280, height: 800 }, deviceScaleFactor = 1, consoleFilter = /DESYNC|Desync|pageerror/i, log = null } = {}) {
    const room = 'e2e-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const ctx1 = await browser.newContext({ viewport, deviceScaleFactor });
    const ctx2 = await browser.newContext({ viewport, deviceScaleFactor });
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();
    const errors = { p1: [], p2: [] };
    for (const [p, name] of [[p1, 'p1'], [p2, 'p2']]) {
        p.on('pageerror', e => { errors[name].push(e.message); log?.(`[${name} pageerror] ${e.message}`); });
        p.on('console', m => {
            const t = m.text();
            if (m.type() === 'error' && !/404/.test(t)) errors[name].push(t);
            if (consoleFilter.test(t)) log?.(`[${name}] ${t.slice(0, 200)}`);
        });
    }

    await p1.goto(`/?room=${room}&player=1`);
    await p1.waitForFunction(() => window.game?.isMultiplayer, { timeout: 15000 });
    await p2.goto(`/?room=${room}&player=2`);

    for (const p of [p1, p2]) {
        await p.waitForFunction(
            () => window.game?.isMultiplayer && window.game?.connectedPlayers?.size >= 2 && !window.game.waitingForSync,
            { timeout: 20000 }
        );
    }
    return { p1, p2, ctx1, ctx2, room, errors };
}

/** Freeze a page's simulation at a tick (keeps emitting frames so the peer can reach it too). */
export async function freezeAtTick(page, tick) {
    await page.evaluate((t) => {
        const game = window.game;
        if (!game._origSimulationStep) game._origSimulationStep = game.simulationStep.bind(game);
        const orig = game._origSimulationStep;
        game.simulationStep = function () {
            if (game.simTime >= t) return false;
            return orig();
        };
    }, tick);
}

export async function unfreeze(page) {
    await page.evaluate(() => {
        const game = window.game;
        if (game._origSimulationStep) game.simulationStep = game._origSimulationStep;
    });
}

/** Freeze both pages at the same tick and wait for both to reach it. */
export async function freezeBothAndWait(p1, p2, targetTick, timeout = 60000) {
    await freezeAtTick(p1, targetTick);
    await freezeAtTick(p2, targetTick);
    for (const p of [p1, p2]) {
        await p.waitForFunction((t) => window.game.simTime >= t, targetTick, { timeout });
    }
    await p1.waitForTimeout(300);
}

/** Download both grids and count differing floats. */
export async function compareGrids(p1, p2) {
    const [g1, g2] = await Promise.all([p1, p2].map(p => p.evaluate(async () => Array.from(await window.game.grid.download()))));
    let diffs = 0, firstDiff = null;
    for (let i = 0; i < g1.length; i++) {
        if (g1[i] !== g2[i]) { if (!firstDiff) firstDiff = { index: i, v1: g1[i], v2: g2[i] }; diffs++; }
    }
    return { diffs, firstDiff };
}

/** Count unique factory centers per player by scanning the grid. */
export async function getFactoryCounts(page) {
    return page.evaluate(async () => {
        const data = await window.game.grid.download();
        const N = 512;
        const seen = { 1: new Set(), 2: new Set() };
        for (let i = 0; i < data.length; i += 4) {
            const t = Math.round(data[i]);
            if (t === 3 || t === 7) seen[t === 3 ? 1 : 2].add(`${Math.round(data[i + 2])},${Math.round(data[i + 3])}`);
        }
        return { p1: seen[1].size, p2: seen[2].size };
    });
}

/** Count cells of each type. */
export async function countCellTypes(page) {
    return page.evaluate(async () => {
        const data = await window.game.grid.download();
        const counts = {};
        for (let i = 0; i < data.length; i += 4) { const t = Math.round(data[i]); counts[t] = (counts[t] || 0) + 1; }
        return { units: (counts[2] || 0) + (counts[5] || 0), factories: (counts[3] || 0) + (counts[7] || 0), resources: counts[1] || 0, walls: counts[4] || 0 };
    });
}

export async function getGameState(page) {
    return page.evaluate(() => ({
        simTime: window.game.simTime,
        playerFactoryCounts: { ...window.game.playerFactoryCounts },
        playerTotalFactoriesPlaced: { ...window.game.playerTotalFactoriesPlaced },
        gameOver: window.game.winConditionManager.gameOver,
        winner: window.game.winConditionManager.winner,
        waitingForSync: window.game.waitingForSync
    }));
}

/** Sync/perf stats exposed by main.js. */
export async function getStats(page) {
    return page.evaluate(() => window.getSyncStats());
}

/**
 * Install a frame/tick meter. readMeter() returns stats since the last read:
 * fps, tps, longest frame gap, count of frames > 33ms.
 */
export async function installMeter(page) {
    await page.evaluate(() => {
        const m = window.__meter = { frames: 0, t0: performance.now(), tick0: window.game.simTime, last: 0, maxGap: 0, longFrames: 0 };
        const loop = (t) => {
            m.frames++;
            if (m.last) { const gap = t - m.last; if (gap > m.maxGap) m.maxGap = gap; if (gap > 33) m.longFrames++; }
            m.last = t;
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    });
}

export async function readMeter(page) {
    return page.evaluate(() => {
        const m = window.__meter;
        const now = performance.now();
        const el = (now - m.t0) / 1000;
        const r = { fps: m.frames / el, tps: (window.game.simTime - m.tick0) / el, maxGap: m.maxGap, longFrames: m.longFrames, seconds: el };
        m.frames = 0; m.t0 = now; m.tick0 = window.game.simTime; m.maxGap = 0; m.longFrames = 0;
        return r;
    });
}

/**
 * Find factory-placeable spots near resources (same on both pages since the
 * map is seeded). Returns [[x,y], ...] spread across the map.
 */
export async function findSpots(page, { count = 40, minResources = 30, step = 9 } = {}) {
    return page.evaluate(({ count, minResources, step }) => {
        // Use the pristine map (same seed) so spots don't depend on the current state
        const N = 512;
        const data = new Float32Array(N * N * 4);
        window.game.mapGenerator.generate(data, window.game.mapSeed);
        const spots = [];
        for (let y = 30; y < N - 30 && spots.length < count; y += step) {
            for (let x = 30; x < N - 30 && spots.length < count; x += step) {
                let ok = true;
                for (let dy = -3; dy <= 3 && ok; dy++) for (let dx = -3; dx <= 3 && ok; dx++) if (Math.round(data[((y + dy) * N + x + dx) * 4]) !== 0) ok = false;
                if (!ok) continue;
                let res = 0;
                for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) if (Math.round(data[((y + dy) * N + x + dx) * 4]) === 1) res++;
                if (res >= minResources) spots.push([x, y]);
            }
        }
        // spread: take every k-th so both players get spots all over the map
        return spots;
    }, { count, minResources, step });
}

/** Inject symmetric send/receive latency (with jitter) into a page's WebSocket. */
export async function injectLatency(page, latencyMs, { jitter = 0.1 } = {}) {
    await page.evaluate(({ latency, jitterFrac }) => {
        const ns = window.game.networkSync;
        const ws = ns.ws;
        const delay = () => latency + (Math.random() * 2 - 1) * latency * jitterFrac;
        const origSend = ns.send.bind(ns);
        const origSendBinary = ns.sendBinary.bind(ns);
        ns.send = (msg) => setTimeout(() => origSend(msg), delay());
        ns.sendBinary = (buf) => setTimeout(() => origSendBinary(buf), delay());
        const origOnMessage = ws.onmessage;
        ws.onmessage = (event) => setTimeout(() => origOnMessage(event), delay());
    }, { latency: latencyMs, jitterFrac: jitter });
}

/** Assert both pages agree on the grid at a common tick, and report. */
export async function expectInSync(p1, p2, { extraTicks = 60 } = {}) {
    const ticks = await Promise.all([p1, p2].map(p => p.evaluate(() => window.game.simTime)));
    const target = Math.max(...ticks) + extraTicks;
    await freezeBothAndWait(p1, p2, target);
    const { diffs, firstDiff } = await compareGrids(p1, p2);
    expect(diffs, `Grids diverged at tick ${target}: ${diffs} differing values, first at index ${firstDiff?.index} (${firstDiff?.v1} vs ${firstDiff?.v2})`).toBe(0);
    const [c1, c2] = await Promise.all([getFactoryCounts(p1), getFactoryCounts(p2)]);
    expect(c1, 'factory counts agree').toEqual(c2);
    await unfreeze(p1); await unfreeze(p2);
    return { tick: target, counts: c1 };
}
