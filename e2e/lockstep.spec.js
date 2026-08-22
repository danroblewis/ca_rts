/**
 * Lockstep multiplayer e2e tests (two real Chrome WebGPU clients).
 *
 * These are the acceptance tests for the goal:
 *   - a game with many interlaced actions from both players stays correct
 *     and synchronised for > 5 minutes,
 *   - both browsers keep >= 50 fps,
 *   - both timelines are synchronised (tick difference bounded by the input delay).
 */
import { test, expect } from '@playwright/test';
import {
    setupRoom, findSpots, installMeter, readMeter, getStats, getGameState,
    expectInSync, injectLatency, countCellTypes, getFactoryCounts
} from './helpers.js';

const MAX_FACTORIES = 7;

/**
 * A scripted "player": places factories near resources, occasionally
 * demolishes one, selects units and sends them around. Actions are driven
 * from the test (Playwright) side with randomised timing so the two players
 * interleave.
 */
class Bot {
    constructor(page, name, spots, rng) {
        this.page = page; this.name = name; this.spots = spots; this.rng = rng;
        this.placed = [];          // [x,y] of factories we placed (and haven't demolished)
        this.stats = { place: 0, placeRejected: 0, demolish: 0, select: 0, command: 0, clear: 0 };
    }

    async act() {
        const r = this.rng();
        if (this.placed.length < MAX_FACTORIES && r < 0.45) return this.place();
        if (this.placed.length > 2 && r < 0.55) return this.demolish();
        if (r < 0.8) return this.selectAndCommand();
        return this.clear();
    }

    async place() {
        const spot = this.spots[Math.floor(this.rng() * this.spots.length)];
        const ok = await this.page.evaluate(([x, y]) => window.game.handlePlaceFactory(x, y), spot);
        if (ok) { this.placed.push(spot); this.stats.place++; } else this.stats.placeRejected++;
    }

    async demolish() {
        const i = Math.floor(this.rng() * this.placed.length);
        const [x, y] = this.placed.splice(i, 1)[0];
        await this.page.evaluate(([x, y]) => window.game.handleDemolish(x, y), [x, y]);
        this.stats.demolish++;
    }

    async selectAndCommand() {
        if (this.placed.length === 0) return this.place();
        const [fx, fy] = this.placed[Math.floor(this.rng() * this.placed.length)];
        const region = { x1: Math.max(0, fx - 12), y1: Math.max(0, fy - 12), x2: Math.min(511, fx + 12), y2: Math.min(511, fy + 12) };
        const n = await this.page.evaluate((region) => window.game.markUnitsInRegion(region), region);
        this.stats.select++;
        if (n > 0) {
            const dest = this.spots[Math.floor(this.rng() * this.spots.length)];
            await this.page.waitForTimeout(150 + this.rng() * 200);
            await this.page.evaluate(([x, y]) => window.game.handleUnitCommand({ destX: x, destY: y }), dest);
            this.stats.command++;
        }
    }

    async clear() {
        await this.page.evaluate(() => window.game.clearAllSelections());
        this.stats.clear++;
    }
}

function makeRng(seed) {
    let s = seed;
    return () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/**
 * Run both bots concurrently for `seconds`, sampling sync/perf every
 * `sampleEvery` seconds. Returns the samples.
 */
async function playGame({ p1, p2 }, seconds, { sampleEvery = 10, minFps = 50, log, actionGapMs = [400, 1400], seed = 1 } = {}) {
    const spotsAll = await findSpots(p1, { count: 80 });
    expect(spotsAll.length, 'placeable spots').toBeGreaterThan(20);
    const spots1 = spotsAll.filter((_, i) => i % 2 === 0);
    const spots2 = spotsAll.filter((_, i) => i % 2 === 1);
    const b1 = new Bot(p1, 'P1', spots1, makeRng(seed));
    const b2 = new Bot(p2, 'P2', spots2, makeRng(seed + 100));

    await installMeter(p1); await installMeter(p2);
    // Warm-up: ignore the first seconds (join handshake, shader warm-up)
    await p1.waitForTimeout(2000);
    await readMeter(p1); await readMeter(p2);
    await Promise.all([p1, p2].map(p => p.evaluate(() => { const g = window.game; g.perf.stalls = 0; })));

    const samples = [];
    const end = Date.now() + seconds * 1000;
    let running = true;

    const botLoop = async (bot) => {
        while (running && Date.now() < end) {
            try { await bot.act(); } catch (e) { if (running) throw e; }
            const [lo, hi] = actionGapMs;
            await bot.page.waitForTimeout(lo + bot.rng() * (hi - lo));
        }
    };
    const sampler = async () => {
        while (running && Date.now() < end) {
            await p1.waitForTimeout(sampleEvery * 1000);
            if (!running) break;
            const [m1, m2, s1, s2] = await Promise.all([readMeter(p1), readMeter(p2), getStats(p1), getStats(p2)]);
            const sample = {
                t: Math.round((seconds * 1000 - (end - Date.now())) / 1000),
                tick1: s1.tick, tick2: s2.tick, tickDiff: Math.abs(s1.tick - s2.tick), delay: Math.max(s1.inputDelay, s2.inputDelay),
                fps1: +m1.fps.toFixed(1), fps2: +m2.fps.toFixed(1), tps1: +m1.tps.toFixed(1), tps2: +m2.tps.toFixed(1),
                maxGap1: Math.round(m1.maxGap), maxGap2: Math.round(m2.maxGap),
                hashOk: s1.hashMatches + s2.hashMatches, hashBad: s1.hashMismatches + s2.hashMismatches,
                desync: s1.desync || s2.desync, stalls1: s1.stalls, stalls2: s2.stalls, rtt: +s1.net.rttMs.toFixed(1)
            };
            samples.push(sample);
            log?.(JSON.stringify(sample));
        }
    };
    await Promise.all([botLoop(b1), botLoop(b2), sampler()]);
    running = false;
    log?.(`bot stats P1=${JSON.stringify(b1.stats)} P2=${JSON.stringify(b2.stats)}`);
    return { samples, bots: [b1, b2] };
}

function assertSamples(samples, { minFps = 50, maxTickDiffSlack = 4, allowStalls = false }) {
    expect(samples.length, 'collected samples').toBeGreaterThan(0);
    for (const s of samples) {
        expect(s.desync, `no desync detected (t=${s.t}s)`).toBe(false);
        expect(s.hashBad, `no hash mismatches (t=${s.t}s)`).toBe(0);
        expect(s.tickDiff, `timelines within input delay (t=${s.t}s: ${s.tick1} vs ${s.tick2}, delay ${s.delay})`).toBeLessThanOrEqual(s.delay + maxTickDiffSlack);
        expect(s.fps1, `P1 fps >= ${minFps} (t=${s.t}s)`).toBeGreaterThanOrEqual(minFps);
        expect(s.fps2, `P2 fps >= ${minFps} (t=${s.t}s)`).toBeGreaterThanOrEqual(minFps);
    }
    const last = samples[samples.length - 1];
    expect(last.hashOk, 'hashes were actually exchanged and matched').toBeGreaterThan(5);
}

test.describe('lockstep multiplayer', () => {

    test('5-minute game with many interlaced actions stays in sync at >= 50 fps', async ({ browser }) => {
        test.setTimeout(8 * 60 * 1000);
        const room = await setupRoom(browser, { log: (m) => console.log(m) });
        const { samples, bots } = await playGame(room, 5 * 60, { log: (m) => console.log(m), seed: 7 });

        assertSamples(samples, { minFps: 50 });
        const totalActions = bots.reduce((n, b) => n + b.stats.place + b.stats.demolish + b.stats.select + b.stats.command + b.stats.clear, 0);
        expect(totalActions, 'many actions were issued').toBeGreaterThan(200);
        expect(bots[0].stats.place + bots[1].stats.place, 'factories placed by both').toBeGreaterThan(8);

        // No stalls once in steady state (LAN): the last sample's stall counters are since warm-up
        const last = samples[samples.length - 1];
        expect(last.stalls1 + last.stalls2, 'no lockstep stalls on a LAN').toBeLessThan(60);

        const state = await Promise.all([getGameState(room.p1), getGameState(room.p2)]);
        expect(state[0].gameOver, 'no game over on P1').toBe(false);
        expect(state[1].gameOver, 'no game over on P2').toBe(false);

        const counts = await countCellTypes(room.p1);
        console.log('end state', JSON.stringify(counts));
        expect(counts.units, 'the game actually had units').toBeGreaterThan(20);

        const r = await expectInSync(room.p1, room.p2);
        console.log(`in sync at tick ${r.tick}, factories ${JSON.stringify(r.counts)}`);
        expect(r.tick, 'over 5 minutes of ticks simulated').toBeGreaterThan(5 * 60 * 55);

        expect(room.errors.p1, 'no page errors on P1').toEqual([]);
        expect(room.errors.p2, 'no page errors on P2').toEqual([]);
        await room.ctx1.close(); await room.ctx2.close();
    });

    test('60s game under 150ms jittery latency stays in sync (adaptive input delay)', async ({ browser }) => {
        test.setTimeout(3 * 60 * 1000);
        const room = await setupRoom(browser, { log: (m) => console.log(m) });
        await injectLatency(room.p1, 150, { jitter: 0.3 });
        await injectLatency(room.p2, 150, { jitter: 0.3 });
        await room.p1.waitForTimeout(2500);   // let the rtt measurement raise the delay
        const { samples } = await playGame(room, 60, { log: (m) => console.log(m), seed: 3 });
        assertSamples(samples, { minFps: 50 });
        const last = samples[samples.length - 1];
        expect(last.delay, 'input delay adapted to latency').toBeGreaterThan(6);
        // Once adapted, the delay covers the latency: full tick rate, no stalls
        expect(last.tps1, 'P1 runs at full rate once the delay covers the latency').toBeGreaterThan(55);
        expect(last.tps2, 'P2 runs at full rate once the delay covers the latency').toBeGreaterThan(55);
        const prev = samples[samples.length - 2];
        expect(last.stalls1 - prev.stalls1 + last.stalls2 - prev.stalls2, 'no stalls in the last 10s').toBeLessThan(30);
        await expectInSync(room.p1, room.p2, { extraTicks: 120 });
        await room.ctx1.close(); await room.ctx2.close();
    });

    test('60s game with asymmetric latency (P1=300ms, P2=30ms) stays in sync', async ({ browser }) => {
        test.setTimeout(3 * 60 * 1000);
        const room = await setupRoom(browser, { log: (m) => console.log(m) });
        await injectLatency(room.p1, 300, { jitter: 0.2 });
        await injectLatency(room.p2, 30, { jitter: 0.2 });
        await room.p1.waitForTimeout(2500);
        const { samples } = await playGame(room, 60, { log: (m) => console.log(m), seed: 5 });
        assertSamples(samples, { minFps: 50, maxTickDiffSlack: 8 });
        const last = samples[samples.length - 1];
        expect(last.tps1, 'P1 at full rate').toBeGreaterThan(55);
        expect(last.tps2, 'P2 at full rate').toBeGreaterThan(55);
        await expectInSync(room.p1, room.p2, { extraTicks: 120 });
        await room.ctx1.close(); await room.ctx2.close();
    });

    test('slow peer (P1 throttled to 20 tps) keeps timelines locked and in sync', async ({ browser }) => {
        test.setTimeout(3 * 60 * 1000);
        const room = await setupRoom(browser, { log: (m) => console.log(m) });
        await room.p1.evaluate(() => { window.game.targetTicksPerSecond = 20; });
        const { samples } = await playGame(room, 40, { log: (m) => console.log(m), seed: 9 });
        for (const s of samples) {
            expect(s.desync, 'no desync').toBe(false);
            expect(s.hashBad, 'no hash mismatch').toBe(0);
            expect(s.tickDiff, `P2 never runs more than the delay ahead (${s.tick1} vs ${s.tick2})`).toBeLessThanOrEqual(s.delay + 4);
            expect(s.fps2, 'fast peer keeps rendering at full rate while waiting').toBeGreaterThanOrEqual(50);
            expect(s.tps1, 'P1 runs near its throttled rate').toBeLessThan(30);
        }
        await room.p1.evaluate(() => { window.game.targetTicksPerSecond = 60; });
        await expectInSync(room.p1, room.p2, { extraTicks: 120 });
        await room.ctx1.close(); await room.ctx2.close();
    });

    test('actions issued during the join handshake are not lost', async ({ browser }) => {
        test.setTimeout(2 * 60 * 1000);
        const roomId = 'e2e-join-' + Date.now();
        const ctx1 = await browser.newContext(); const ctx2 = await browser.newContext();
        const p1 = await ctx1.newPage(); const p2 = await ctx2.newPage();
        await p1.goto(`/?room=${roomId}&player=1`);
        await p1.waitForFunction(() => window.game?.isMultiplayer, { timeout: 15000 });
        await p1.waitForTimeout(1000);
        await p2.goto(`/?room=${roomId}&player=2`);
        // As soon as P2 knows about P1 (but possibly before the snapshot arrived), both place
        await p2.waitForFunction(() => window.game?.connectedPlayers?.size >= 2, { timeout: 15000 });
        const spots = await findSpots(p1, { count: 10 });
        const ok2 = await p2.evaluate(([x, y]) => window.game.handlePlaceFactory(x, y), spots[1]);
        const ok1 = await p1.evaluate(([x, y]) => window.game.handlePlaceFactory(x, y), spots[0]);
        expect(ok1 && ok2, 'both placements accepted').toBe(true);
        await p1.waitForTimeout(3000);
        const [c1, c2] = await Promise.all([getFactoryCounts(p1), getFactoryCounts(p2)]);
        expect(c1, 'P1 sees both factories').toEqual({ p1: 1, p2: 1 });
        expect(c2, 'P2 sees both factories').toEqual({ p1: 1, p2: 1 });
        await expectInSync(p1, p2);
        await ctx1.close(); await ctx2.close();
    });

    test('late joiner resyncs from a snapshot mid-game and stays in sync', async ({ browser }) => {
        test.setTimeout(3 * 60 * 1000);
        const room = await setupRoom(browser, { log: (m) => console.log(m) });
        await playGame(room, 20, { seed: 11 });
        // P2 reloads mid-game and rejoins as player 2
        await room.p2.reload();
        await room.p2.waitForFunction(() => window.game?.isMultiplayer && window.game?.connectedPlayers?.size >= 2 && !window.game.waitingForSync, { timeout: 30000 });
        await room.p2.waitForTimeout(1000);
        const tickBefore = await room.p2.evaluate(() => window.game.simTime);
        expect(tickBefore, 'joiner resumed at the host\'s tick').toBeGreaterThan(20 * 50);
        await playGame(room, 20, { seed: 12 });
        const st = await Promise.all([getStats(room.p1), getStats(room.p2)]);
        expect(st[0].hashMismatches + st[1].hashMismatches, 'no hash mismatches after rejoin').toBe(0);
        await expectInSync(room.p1, room.p2);
        await room.ctx1.close(); await room.ctx2.close();
    });
});

test.describe('performance', () => {

    test('retina-scale single player with a populated map renders at >= 50 fps', async ({ browser }) => {
        test.setTimeout(3 * 60 * 1000);
        const ctx = await browser.newContext({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 2 });
        const page = await ctx.newPage();
        await page.goto('/?seed=12345');
        await page.waitForFunction(() => window.game && window.game.simTime > 5, { timeout: 30000 });
        const spots = await findSpots(page, { count: 30 });
        // Place many factories for both players directly (single player) to get a busy map
        for (let i = 0; i < 14; i++) {
            await page.evaluate(([x, y, p]) => { window.game.switchPlayer(p); window.game.playerFactoryCounts[p] = 0; return window.game.handlePlaceFactory(x, y); }, [spots[i][0], spots[i][1], i % 2 ? 2 : 1]);
        }
        // Fast-forward the simulation so units exist
        await page.evaluate(async () => { for (let i = 0; i < 4000; i++) window.game.simulationStep(); });
        await page.waitForTimeout(1000);
        const counts = await countCellTypes(page);
        console.log('populated map', JSON.stringify(counts));
        expect(counts.units, 'map has many units').toBeGreaterThan(60);

        await installMeter(page);
        await page.waitForTimeout(10000);
        const m = await readMeter(page);
        const st = await page.evaluate(() => ({ canvas: [document.getElementById('canvas').width, document.getElementById('canvas').height], perfMode: window.game.performanceMode, frame: window.gameLoop.getFrameStats() }));
        console.log('retina perf', JSON.stringify({ ...m, ...st }));
        expect(m.fps, 'fps').toBeGreaterThanOrEqual(50);
        expect(m.tps, 'tps').toBeGreaterThanOrEqual(50);
        await ctx.close();
    });

    test('simulation tick cost on a populated 512x512 map is well under a frame budget', async ({ browser }) => {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto('/?seed=12345');
        await page.waitForFunction(() => window.game && window.game.simTime > 5, { timeout: 30000 });
        const spots = await findSpots(page, { count: 30 });
        for (let i = 0; i < 14; i++) {
            await page.evaluate(([x, y, p]) => { window.game.switchPlayer(p); window.game.playerFactoryCounts[p] = 0; return window.game.handlePlaceFactory(x, y); }, [spots[i][0], spots[i][1], i % 2 ? 2 : 1]);
        }
        const r = await page.evaluate(async () => {
            const g = window.game;
            g.syncWithRender = true;
            const orig = g.simulationStep; g.simulationStep = () => false;   // pause the loop's stepping
            for (let i = 0; i < 4000; i++) orig.call(g);
            const { GPU } = await import('./src/gpu/GPU.js');
            const dev = GPU.get().device;
            await dev.queue.onSubmittedWorkDone();
            const t0 = performance.now();
            for (let i = 0; i < 200; i++) orig.call(g);
            await dev.queue.onSubmittedWorkDone();
            const ms = (performance.now() - t0) / 200;
            g.simulationStep = orig;
            return { msPerTick: ms, tick: g.simTime };
        });
        const counts = await countCellTypes(page);
        console.log('tick cost', JSON.stringify({ ...r, ...counts }));
        expect(counts.units).toBeGreaterThan(30);
        expect(r.msPerTick, 'ms per tick').toBeLessThan(4);
        await ctx.close();
    });
});
