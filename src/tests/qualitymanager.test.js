/**
 * QualityManager Unit Tests
 * Tests for rendering/QualityManager.js
 * Pure JS, no GPU needed. Uses a fake clock.
 */

import { runTest, assert, logSection } from './framework.js';
import { QualityManager, QUALITY_LEVELS } from '../rendering/QualityManager.js';

function makeManager(opts = {}) {
    let t = 0;
    const applied = [];
    const qm = new QualityManager({
        now: () => t,
        apply: (level, index, reason) => applied.push({ name: level.name, index, reason }),
        ...opts
    });
    return {
        qm, applied,
        /** advance `seconds`, feeding a sample every 0.5s */
        feed(seconds, sample) {
            const changes = [];
            for (let i = 0; i < seconds * 2; i++) {
                t += 500;
                const c = qm.sample(sample);
                if (c !== null) changes.push(c);
            }
            return changes;
        },
        time: () => t
    };
}

export async function runQualityManagerTests() {
    logSection('QualityManager - Ladder');

    await runTest('Quality: levels go from pretty/retina to flat/half-res', async () => {
        assert(QUALITY_LEVELS.length >= 7, 'at least 7 levels');
        assert(QUALITY_LEVELS[0].shader === 'metaball' && QUALITY_LEVELS[0].renderScale >= 1.5, 'top level is the full shader at retina scale');
        const last = QUALITY_LEVELS[QUALITY_LEVELS.length - 1];
        assert(last.shader === 'debug' && last.renderScale <= 0.5, 'bottom level is the flat shader at half res');
        // Cost must be monotonically non-increasing on each axis that matters
        for (let i = 1; i < QUALITY_LEVELS.length; i++) {
            const a = QUALITY_LEVELS[i - 1], b = QUALITY_LEVELS[i];
            const shaderRank = (l) => (l.shader === 'debug' ? 0 : 1) * 10 + l.quality;
            assert(shaderRank(b) <= shaderRank(a), `level ${i} is not fancier than level ${i - 1}`);
        }
    });

    await runTest('Quality: applies the initial level on construction', async () => {
        const m = makeManager();
        assert(m.applied.length === 1 && m.applied[0].index === 0 && m.applied[0].reason === 'init', 'init applied level 0');
        assert(m.qm.auto === true, 'auto by default');
    });

    logSection('QualityManager - Automatic adjustment');

    await runTest('Quality: steps down after sustained low fps, not on a single bad sample', async () => {
        const m = makeManager();
        assert(m.qm.sample({ fps: 30 }) === null, 'single low sample does nothing');
        m.feed(1, { fps: 30 });
        assert(m.qm.index === 0, 'still level 0 after 1s');
        const changes = m.feed(2, { fps: 30 });
        assert(changes.length === 1 && m.qm.index === 1, `stepped down once (${m.qm.index})`);
    });

    await runTest('Quality: keeps stepping down while fps stays low, respecting the cooldown', async () => {
        const m = makeManager({ cooldownMs: 3000, downHoldMs: 2000 });
        m.feed(30, { fps: 20 });
        assert(m.qm.index === QUALITY_LEVELS.length - 1, `reached the bottom (${m.qm.index})`);
        // At least cooldown between consecutive changes
        const h = m.qm.history;
        for (let i = 1; i < h.length; i++) assert(h[i].t - h[i - 1].t >= 3000, 'cooldown respected');
        // Never goes below the bottom
        m.feed(10, { fps: 20 });
        assert(m.qm.index === QUALITY_LEVELS.length - 1, 'stays at bottom');
    });

    await runTest('Quality: a short fps dip recovers before the hold time does not step down', async () => {
        const m = makeManager();
        m.feed(1.5, { fps: 40 });
        m.feed(1, { fps: 60 });
        m.feed(1.5, { fps: 40 });
        assert(m.qm.index === 0, 'no change from dips shorter than the hold time');
    });

    await runTest('Quality: steps up only after sustained good fps WITH GPU headroom', async () => {
        const m = makeManager({ initialLevel: 3 });
        m.feed(15, { fps: 60, gpuMs: 14 });
        assert(m.qm.index === 3, 'no step up without GPU headroom');
        const changes = m.feed(15, { fps: 60, gpuMs: 5 });
        assert(changes.length >= 1 && m.qm.index < 3, `stepped up with headroom (${m.qm.index})`);
    });

    await runTest('Quality: steps up when no GPU estimate is available and fps is good for long enough', async () => {
        const m = makeManager({ initialLevel: 2 });
        m.feed(12, { fps: 60 });
        assert(m.qm.index === 1, `stepped up once (${m.qm.index})`);
    });

    await runTest('Quality: a step up that causes low fps is reverted and that level is blocked', async () => {
        const m = makeManager({ initialLevel: 2 });
        m.feed(12, { fps: 60, gpuMs: 4 });
        assert(m.qm.index === 1, 'stepped up to 1');
        m.feed(4, { fps: 40, gpuMs: 20 });
        assert(m.qm.index === 2, `reverted to 2 (${m.qm.index})`);
        assert(m.qm.getState().blocked.includes(QUALITY_LEVELS[1].name), 'level 1 is blocked');
        // Good fps again for a long time: must NOT re-enter the blocked level
        m.feed(60, { fps: 60, gpuMs: 4 });
        assert(m.qm.index === 2, `stays at 2 while blocked (${m.qm.index})`);
        // After the block expires it may try again
        m.feed(90, { fps: 60, gpuMs: 4 });
        assert(m.qm.index < 2, `retries after the block expires (${m.qm.index})`);
        assert(m.qm.history.some(h => h.to === 1 && h.t >= 130000), 'stepped up to 1 only after the block expired');
    });

    await runTest('Quality: manual selection disables auto, "auto" re-enables it', async () => {
        const m = makeManager();
        m.qm.setManual('minimal');
        assert(m.qm.auto === false && m.qm.name === 'minimal', 'manual minimal');
        m.feed(30, { fps: 60, gpuMs: 2 });
        assert(m.qm.name === 'minimal', 'no automatic changes in manual mode');
        m.qm.setManual(0);
        m.feed(30, { fps: 20 });
        assert(m.qm.index === 0, 'manual ultra sticks even at low fps');
        m.qm.setManual('auto');
        m.feed(6, { fps: 20 });
        assert(m.qm.index > 0, 'auto mode steps down again');
    });

    await runTest('Quality: unknown manual level is ignored', async () => {
        const m = makeManager();
        m.qm.setManual('nonsense');
        m.qm.setManual(99);
        assert(m.qm.index === 0, 'unchanged');
    });

    await runTest('Quality: getState reports the level, mode and recent history', async () => {
        const m = makeManager();
        m.feed(3, { fps: 30 });
        const st = m.qm.getState();
        assert(st.index === 1 && st.name === QUALITY_LEVELS[1].name, 'index/name');
        assert(st.auto === true, 'auto');
        assert(st.history.length === 1 && st.history[0].from === 0 && st.history[0].to === 1, 'history entry');
        assert(st.lastSample.fps === 30, 'last sample');
    });
}
