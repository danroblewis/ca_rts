/**
 * Graphics quality ladder e2e tests.
 *
 * The simulation is fixed-cost; rendering adapts. These tests use the
 * synthetic GPU load (window.setGpuLoad) to make the machine "slow" and
 * verify that the QualityManager steps down until the frame rate recovers,
 * in single player and for one constrained client in a lockstep game.
 */
import { test, expect } from '@playwright/test';
import { setupRoom, findSpots, installMeter, readMeter, getStats, expectInSync, countCellTypes } from './helpers.js';

async function measureFps(page, seconds = 2) {
    return page.evaluate(async (sec) => {
        let f = 0; const t0 = performance.now();
        const loop = () => { f++; if (performance.now() - t0 < sec * 1000) requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
        await new Promise(r => setTimeout(r, sec * 1000 + 50));
        return f / sec;
    }, seconds);
}

async function quality(page) {
    return page.evaluate(() => ({ name: window.qualityManager.name, index: window.qualityManager.index, auto: window.qualityManager.auto, history: window.qualityManager.getState().history }));
}

/**
 * Find a synthetic GPU load that makes the top level too slow (< maxFps)
 * while the bottom level still has headroom (>= minBottomFps). Returns null
 * if no such load exists on this machine (already too slow, or too fast).
 */
async function calibrateLoad(page, { maxFps = 45, minBottomFps = 55, log } = {}) {
    const bottom = await page.evaluate(() => window.qualityManager.levels.length - 1);
    for (const load of [200, 400, 800, 1500, 2500, 4000, 6000, 10000, 16000, 25000, 40000, 64000]) {
        await page.evaluate((n) => { window.setQuality(0); window.setGpuLoad(n); }, load);
        await page.waitForTimeout(1200);
        const top = await measureFps(page, 2);
        await page.evaluate((b) => window.setQuality(b), bottom);
        await page.waitForTimeout(1200);
        const low = await measureFps(page, 2);
        log?.(`gpuload ${load}: ultra ${top.toFixed(1)} fps, potato ${low.toFixed(1)} fps`);
        if (top < maxFps && low >= minBottomFps) return load;
        if (low < minBottomFps) break;   // load alone exceeds the frame budget
    }
    return null;
}

async function populate(page) {
    await page.waitForFunction(() => window.game && window.game.simTime > 5, { timeout: 30000 });
    const spots = await findSpots(page, { count: 20 });
    for (let i = 0; i < 10; i++) {
        await page.evaluate(([x, y, p]) => { window.game.switchPlayer(p); window.game.playerFactoryCounts[p] = 0; return window.game.handlePlaceFactory(x, y); }, [spots[i][0], spots[i][1], i % 2 ? 2 : 1]);
    }
    await page.evaluate(() => { for (let i = 0; i < 1500; i++) window.game.simulationStep(); });
}

test.describe('graphics quality ladder', () => {

    test('every quality level renders without errors; lower levels are cheaper', async ({ browser }) => {
        test.setTimeout(3 * 60 * 1000);
        const ctx = await browser.newContext({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 2 });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });
        await page.goto('/?seed=12345');
        await populate(page);

        const levels = await page.evaluate(() => window.qualityManager.levels.map(l => l.name));
        expect(levels.length).toBeGreaterThanOrEqual(5);
        const results = [];
        for (let i = 0; i < levels.length; i++) {
            await page.evaluate((i) => window.setQuality(i), i);
            await page.waitForTimeout(1000);
            const r = await page.evaluate(() => ({ name: window.qualityManager.name, canvas: [document.getElementById('canvas').width, document.getElementById('canvas').height], gpuMs: window.getSyncStats().gpuFrameMs, ui: document.getElementById('quality-current').textContent }));
            r.fps = await measureFps(page, 2);
            results.push(r);
            console.log(`level ${i} ${JSON.stringify(r)}`);
            expect(r.ui.toLowerCase(), 'UI shows the selected level').toContain(r.name);
        }
        expect(errors, 'no page/console errors').toEqual([]);
        // Top level uses a bigger backing store than the bottom one
        expect(results[0].canvas[0], 'ultra canvas wider than potato').toBeGreaterThan(results[results.length - 1].canvas[0]);
        // The flat shader levels must be comfortably fast on any machine
        expect(results[results.length - 1].fps, 'potato fps').toBeGreaterThanOrEqual(50);
        await ctx.close();
    });

    test('auto quality steps down under GPU load until the frame rate recovers', async ({ browser }) => {
        test.setTimeout(4 * 60 * 1000);
        const ctx = await browser.newContext({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 2 });
        const page = await ctx.newPage();
        await page.goto('/?seed=12345');
        await populate(page);

        const load = await calibrateLoad(page, { log: (m) => console.log(m) });
        test.skip(load === null, 'could not find a GPU load that makes ultra slow but leaves potato fast on this machine');
        console.log(`calibrated gpuload=${load}`);

        // Start at ultra in auto mode with the load applied
        await page.evaluate((n) => { window.setGpuLoad(n); window.setQuality(0); window.setQuality('auto'); }, load);
        const before = await measureFps(page, 2);
        expect(before, 'ultra is too slow under load').toBeLessThan(50);

        // Wait for adaptation: at most ~40s (2s hold + 3s cooldown per step)
        let fps = 0, q = null;
        for (let i = 0; i < 20; i++) {
            await page.waitForTimeout(2000);
            q = await quality(page);
            fps = await measureFps(page, 2);
            console.log(`t+${(i + 1) * 4}s quality=${q.name} fps=${fps.toFixed(1)}`);
            if (fps >= 55 && q.index > 0) break;
        }
        expect(q.auto, 'still in auto mode').toBe(true);
        expect(q.index, 'stepped down from ultra').toBeGreaterThan(0);
        expect(fps, 'frame rate recovered').toBeGreaterThanOrEqual(50);
        expect(q.history.length, 'at least one automatic change recorded').toBeGreaterThan(0);

        // Simulation kept its full tick rate throughout
        await installMeter(page);
        await page.waitForTimeout(3000);
        const m = await readMeter(page);
        expect(m.tps, 'simulation tick rate unaffected by render quality').toBeGreaterThanOrEqual(55);

        // Removing the load: the manager steps back up once it sees GPU headroom
        // (fps >= 58 and estimated GPU time < 9ms for 10s). On a machine whose GPU
        // is busy with other work there is no headroom, and staying put is correct.
        await page.evaluate(() => window.setGpuLoad(0));
        const idxBefore = q.index;
        let after = null, gpuMs = 0;
        for (let i = 0; i < 8; i++) {           // up to ~32s: 10s of headroom + cooldown, with slack
            await page.waitForTimeout(4000);
            after = await quality(page);
            gpuMs = await page.evaluate(() => window.getSyncStats().gpuFrameMs);
            if (after.index < idxBefore) break;
        }
        console.log(`after unloading: ${after.name} (gpu ${gpuMs.toFixed(1)}ms/frame)`);
        if (after.index < idxBefore) {
            expect(after.auto, 'still auto').toBe(true);
        } else {
            // Only acceptable when there is genuinely no headroom (GPU busy with other work)
            console.log('did not step up: no GPU headroom on this machine');
            expect(gpuMs, 'no headroom means GPU time near/above the step-up threshold').toBeGreaterThanOrEqual(8);
        }
        await ctx.close();
    });

    test('lockstep game with one resource-constrained client stays in sync at >= 50 fps', async ({ browser }) => {
        test.setTimeout(4 * 60 * 1000);
        const room = await setupRoom(browser, { viewport: { width: 1512, height: 982 }, deviceScaleFactor: 2, log: (m) => console.log(m) });
        const { p1, p2 } = room;

        // P2 is the slow machine: synthetic GPU load + 3ms of CPU work per frame
        const load = await calibrateLoad(p2, { minBottomFps: 50, log: (m) => console.log('P2 ' + m) });
        test.skip(load === null, 'could not calibrate a GPU load on this machine (two retina clients already saturate it)');
        await p2.evaluate((n) => { window.setGpuLoad(n); window.setCpuLoad(3); window.setQuality(0); window.setQuality('auto'); }, load);
        await p1.evaluate(() => { window.setQuality('auto'); });

        const spots = await findSpots(p1, { count: 20 });
        await installMeter(p1); await installMeter(p2);
        await p1.waitForTimeout(1000); await readMeter(p1); await readMeter(p2);

        const samples = [];
        for (let i = 0; i < 6; i++) {
            // interlaced actions
            await p1.evaluate(([x, y]) => window.game.handlePlaceFactory(x, y), spots[i * 2]);
            await p2.evaluate(([x, y]) => window.game.handlePlaceFactory(x, y), spots[i * 2 + 1]);
            await p1.waitForTimeout(8000);
            const [m1, m2, s1, s2, q2] = await Promise.all([readMeter(p1), readMeter(p2), getStats(p1), getStats(p2), quality(p2)]);
            const s = { t: (i + 1) * 8, fps1: +m1.fps.toFixed(1), fps2: +m2.fps.toFixed(1), tps1: +m1.tps.toFixed(1), tps2: +m2.tps.toFixed(1), tickDiff: Math.abs(s1.tick - s2.tick), delay: Math.max(s1.inputDelay, s2.inputDelay), hashBad: s1.hashMismatches + s2.hashMismatches, q2: q2.name };
            samples.push(s);
            console.log(JSON.stringify(s));
        }
        for (const s of samples) {
            expect(s.hashBad, 'no hash mismatches').toBe(0);
            expect(s.tickDiff, 'timelines locked').toBeLessThanOrEqual(s.delay + 4);
        }
        const last = samples[samples.length - 1];
        expect(last.fps1, 'unconstrained client fps').toBeGreaterThanOrEqual(50);
        expect(last.fps2, 'constrained client fps after adaptation').toBeGreaterThanOrEqual(50);
        expect(last.q2, 'constrained client lowered its quality').not.toBe('ultra');
        expect(last.tps2, 'constrained client still simulates at full rate').toBeGreaterThanOrEqual(55);
        await expectInSync(p1, p2);
        await room.ctx1.close(); await room.ctx2.close();
    });
});
