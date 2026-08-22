/**
 * LockstepSync Unit Tests
 * Tests for network/LockstepSync.js
 * Pure JS, no GPU needed.
 */

import { runTest, assert, logSection } from './framework.js';
import { LockstepSync } from '../network/LockstepSync.js';

/**
 * Two lockstep clients connected by a simulated network with per-direction
 * latency (in "deliveries"). Each client runs its own tick loop: it simulates
 * a tick whenever canSimulate() holds. Returns the applied action log per
 * client so tests can check both applied the same actions at the same ticks.
 */
function makePair({ delay = 3, latency12 = 0, latency21 = 0 } = {}) {
    const a = new LockstepSync({ inputDelay: delay });
    const b = new LockstepSync({ inputDelay: delay });
    a.start(0, 1); b.start(0, 2);
    a.addPeer(2, 0); b.addPeer(1, 0);
    const inflight = [];   // { to, deliverAt, frames, from }
    let now = 0;
    const logA = [], logB = [];

    function send(from, to, frames, latency) {
        inflight.push({ from, to, frames, deliverAt: now + latency });
    }
    function deliver() {
        for (let i = inflight.length - 1; i >= 0; i--) {
            const m = inflight[i];
            if (m.deliverAt <= now) {
                m.to.receiveFrames(m.from.localPlayer, m.frames);
                inflight.splice(i, 1);
            }
        }
    }
    const stalls = { a: 0, b: 0 };
    function stepClient(c, other, latency, log, tickRef) {
        // Frames are emitted on the clock, whether or not we can simulate.
        const frames = c.emitFramesThrough(tickRef.tick + c.inputDelay);
        if (frames.length) send(c, other, frames, latency);
        if (!c.canSimulate(tickRef.tick)) { stalls[c === a ? 'a' : 'b']++; return false; }
        for (const { action, playerId } of c.actionsForTick(tickRef.tick)) {
            log.push({ tick: tickRef.tick, playerId, type: action.type, id: action.id });
        }
        tickRef.tick++;
        return true;
    }
    const ta = { tick: 0 }, tb = { tick: 0 };
    return {
        a, b, logA, logB, ta, tb, stalls,
        // advance "time" by one unit: each client attempts one tick, then deliver
        advance(n = 1, { stepA = true, stepB = true } = {}) {
            for (let i = 0; i < n; i++) {
                now++;
                deliver();
                if (stepA) stepClient(a, b, latency12, logA, ta);
                if (stepB) stepClient(b, a, latency21, logB, tb);
                deliver();
            }
        },
        resetStalls() { stalls.a = 0; stalls.b = 0; },
        flush() { now += 1000; deliver(); }
    };
}

function sameLog(logA, logB) {
    if (logA.length !== logB.length) return false;
    for (let i = 0; i < logA.length; i++) {
        const x = logA[i], y = logB[i];
        if (x.tick !== y.tick || x.playerId !== y.playerId || x.type !== y.type || x.id !== y.id) return false;
    }
    return true;
}

export async function runLockstepSyncTests() {
    logSection('LockstepSync - Frames');

    await runTest('Lockstep: emitFramesThrough emits one frame per tick, contiguous', async () => {
        const s = new LockstepSync({ inputDelay: 2 });
        s.start(10, 1);
        const f = s.emitFramesThrough(12);
        assert(f.length === 3, `expected 3 frames, got ${f.length}`);
        assert(f[0].tick === 10 && f[2].tick === 12, 'ticks 10..12');
        assert(s.sentThrough === 12, 'sentThrough updated');
        assert(s.emitFramesThrough(12).length === 0, 'no re-emission');
        assert(s.emitFramesThrough(11).length === 0, 'never goes backwards');
    });

    await runTest('Lockstep: local action rides in the next emitted frame only', async () => {
        const s = new LockstepSync({ inputDelay: 3 });
        s.start(0, 1);
        s.emitFramesThrough(3);
        const t = s.scheduleLocal({ type: 'place_factory', id: 'a' });
        assert(t === 4, `scheduled tick should be 4, got ${t}`);
        const f = s.emitFramesThrough(6);
        assert(f[0].tick === 4 && f[0].actions.length === 1, 'action in frame 4');
        assert(f[1].actions.length === 0 && f[2].actions.length === 0, 'later frames empty');
        assert(s.actionsForTick(4).length === 1, 'actionsForTick(4) has it');
        assert(s.actionsForTick(5).length === 0, 'actionsForTick(5) empty');
    });

    await runTest('Lockstep: canSimulate gates on every peer\'s contiguous frames', async () => {
        const s = new LockstepSync({ inputDelay: 2 });
        s.start(0, 1);
        s.addPeer(2, 0);
        assert(!s.canSimulate(0), 'no peer frames yet');
        s.receiveFrames(2, [{ tick: 0, actions: [] }, { tick: 1, actions: [] }]);
        assert(s.canSimulate(1), 'ticks 0,1 present');
        assert(!s.canSimulate(2), 'tick 2 missing');
        s.receiveFrames(2, [{ tick: 3, actions: [] }]);   // out of order
        assert(!s.canSimulate(2), 'gap at 2 still blocks');
        assert(!s.canSimulate(3), 'gap blocks 3 too');
        s.receiveFrames(2, [{ tick: 2, actions: [] }]);
        assert(s.canSimulate(3), 'gap filled: 3 available');
        assert(s.simulatableThrough() === 3, 'simulatableThrough = 3');
    });

    await runTest('Lockstep: duplicate / re-sent frames are ignored', async () => {
        const s = new LockstepSync({ inputDelay: 2 });
        s.start(0, 1);
        s.addPeer(2, 0);
        s.receiveFrames(2, [{ tick: 0, actions: [{ type: 'x' }] }]);
        s.receiveFrames(2, [{ tick: 0, actions: [] }]);
        assert(s.actionsForTick(0).length === 1, 'first copy wins');
        assert(s.stats.framesReceived === 1, 'counted once');
    });

    await runTest('Lockstep: actionsForTick orders by player id then issue order', async () => {
        const s = new LockstepSync({ inputDelay: 0 });
        s.start(0, 2);
        s.addPeer(1, 0);
        s.scheduleLocal({ type: 'a', id: 1 });
        s.scheduleLocal({ type: 'b', id: 2 });
        s.emitFramesThrough(0);
        s.receiveFrames(1, [{ tick: 0, actions: [{ type: 'c', id: 3 }] }]);
        const acts = s.actionsForTick(0);
        assert(acts.length === 3, '3 actions');
        assert(acts[0].playerId === 1 && acts[0].action.id === 3, 'P1 first');
        assert(acts[1].action.id === 1 && acts[2].action.id === 2, 'P2 actions in issue order');
    });

    await runTest('Lockstep: missingFor reports first missing tick per peer', async () => {
        const s = new LockstepSync({ inputDelay: 2 });
        s.start(5, 1);
        s.addPeer(2, 5);
        s.addPeer(3, 5);
        s.receiveFrames(2, [{ tick: 5, actions: [] }, { tick: 6, actions: [] }]);
        const m = s.missingFor(8);
        assert(m.length === 2, 'two peers missing');
        const p2 = m.find(x => x.player === 2), p3 = m.find(x => x.player === 3);
        assert(p2.fromTick === 7, `P2 from 7, got ${p2.fromTick}`);
        assert(p3.fromTick === 5, `P3 from 5, got ${p3.fromTick}`);
    });

    await runTest('Lockstep: removePeer stops gating but keeps their future frames', async () => {
        const s = new LockstepSync({ inputDelay: 1 });
        s.start(0, 1);
        s.addPeer(2, 0);
        s.receiveFrames(2, [{ tick: 0, actions: [] }, { tick: 1, actions: [{ type: 'late', id: 9 }] }]);
        s.removePeer(2);
        assert(s.canSimulate(50), 'no gating after removal');
        assert(s.actionsForTick(1).length === 1, 'their tick-1 action still applies');
    });

    await runTest('Lockstep: gc drops old frames only', async () => {
        const s = new LockstepSync({ inputDelay: 0, historyTicks: 10 });
        s.start(0, 1);
        s.addPeer(2, 0);
        s.emitFramesThrough(30);
        s.receiveFrames(2, Array.from({ length: 31 }, (_, t) => ({ tick: t, actions: [] })));
        s.gc(30);
        assert(!s.ownFrames.has(19) && s.ownFrames.has(20), 'own frames < 20 dropped');
        assert(!s.peerFrames.get(2).has(19) && s.peerFrames.get(2).has(20), 'peer frames < 20 dropped');
        assert(s.canSimulate(30), 'gating unaffected');
    });

    await runTest('Lockstep: start() after snapshot keeps peer frames beyond the snapshot tick', async () => {
        const s = new LockstepSync({ inputDelay: 2 });
        s.start(0, 2);
        s.addPeer(1, 0);
        s.receiveFrames(1, [{ tick: 100, actions: [] }, { tick: 101, actions: [] }, { tick: 102, actions: [] }]);
        assert(!s.canSimulate(100), 'gap before 100 blocks');
        s.start(100, 2);
        assert(s.canSimulate(102), 'after restart at 100 the frames count');
        assert(!s.canSimulate(103), '103 missing');
        assert(s.sentThrough === 99, 'own frames restart at 100');
    });

    await runTest('Lockstep: importFrames ignores own frames, stores peers\'', async () => {
        const s = new LockstepSync({ inputDelay: 2 });
        s.start(10, 2);
        s.addPeer(1, 10);
        s.importFrames([
            { playerId: 2, tick: 10, actions: [{ type: 'mine' }] },
            { playerId: 1, tick: 10, actions: [] },
            { playerId: 1, tick: 11, actions: [{ type: 'theirs' }] }
        ]);
        assert(s.ownFrames.size === 0, 'own frames untouched');
        assert(s.canSimulate(11), 'peer frames 10,11 present');
        assert(s.actionsForTick(11)[0].action.type === 'theirs', 'peer action imported');
    });

    logSection('LockstepSync - Two clients');

    await runTest('Lockstep: two clients, no latency, apply identical actions at identical ticks', async () => {
        const p = makePair({ delay: 3 });
        p.advance(5);
        const expectedTick = p.ta.tick + 3;
        const scheduled = p.a.scheduleLocal({ type: 'place_factory', id: 'a1' });
        assert(scheduled === expectedTick, `scheduled at current tick + delay (${scheduled} vs ${expectedTick})`);
        p.advance(2);
        p.b.scheduleLocal({ type: 'demolish', id: 'b1' });
        p.advance(20);
        assert(p.logA.length === 2, `A applied 2 actions, got ${p.logA.length}`);
        assert(sameLog(p.logA, p.logB), 'logs identical');
        assert(p.logA[0].tick === expectedTick, `A's action applied at tick ${expectedTick}, got ${p.logA[0].tick}`);
        assert(Math.abs(p.ta.tick - p.tb.tick) <= 1, 'ticks aligned');
    });

    await runTest('Lockstep: latency below the input delay never stalls', async () => {
        const p = makePair({ delay: 4, latency12: 2, latency21: 2 });
        p.advance(5);            // handshake: first frames in flight
        p.resetStalls();
        const a0 = p.ta.tick, b0 = p.tb.tick;
        p.advance(200);
        assert(p.ta.tick === a0 + 200 && p.tb.tick === b0 + 200, `both advanced 200 ticks (${p.ta.tick - a0}, ${p.tb.tick - b0})`);
        assert(p.stalls.a === 0 && p.stalls.b === 0, `no stalls (${p.stalls.a}, ${p.stalls.b})`);
    });

    await runTest('Lockstep: latency above the input delay stalls but stays consistent', async () => {
        const p = makePair({ delay: 2, latency12: 6, latency21: 6 });
        for (let i = 0; i < 100; i++) {
            if (i % 10 === 0) p.a.scheduleLocal({ type: 'a', id: i });
            if (i % 7 === 0) p.b.scheduleLocal({ type: 'b', id: i });
            p.advance(1);
        }
        p.flush();
        p.advance(50);
        assert(p.stalls.a > 0, 'A stalled at least once');
        assert(p.ta.tick > 60 && p.tb.tick > 60, `progress despite latency (${p.ta.tick}, ${p.tb.tick})`);
        const n = Math.min(p.logA.length, p.logB.length);
        assert(n > 15, `actions applied: ${n}`);
        assert(sameLog(p.logA.slice(0, n), p.logB.slice(0, n)), 'identical logs');
    });

    await runTest('Lockstep: asymmetric latency and a slow peer keep ticks within delay', async () => {
        const p = makePair({ delay: 5, latency12: 1, latency21: 8 });
        for (let i = 0; i < 300; i++) {
            // B only steps every other unit: a "slow" machine
            p.advance(1, { stepB: i % 2 === 0 });
            if (i % 17 === 0) p.a.scheduleLocal({ type: 'a', id: i });
            if (i % 23 === 0) p.b.scheduleLocal({ type: 'b', id: i });
            assert(p.ta.tick - p.tb.tick <= p.a.inputDelay + 1, `A never runs more than delay ahead (${p.ta.tick} vs ${p.tb.tick})`);
        }
        p.flush();
        p.advance(40);
        const n = Math.min(p.logA.length, p.logB.length);
        assert(n > 20, `actions applied: ${n}`);
        assert(sameLog(p.logA.slice(0, n), p.logB.slice(0, n)), 'identical logs');
    });

    await runTest('Lockstep: reordered delivery (jitter) is handled', async () => {
        const a = new LockstepSync({ inputDelay: 3 });
        const b = new LockstepSync({ inputDelay: 3 });
        a.start(0, 1); b.start(0, 2); a.addPeer(2, 0); b.addPeer(1, 0);
        // A emits 20 frames, delivered to B in shuffled order
        const frames = a.emitFramesThrough(19);
        const shuffled = [...frames].sort(() => Math.random() - 0.5);
        for (const f of shuffled) b.receiveFrames(1, [f]);
        assert(b.canSimulate(19), 'all 20 present after reordering');
        assert(!b.canSimulate(20), 'tick 20 missing');
    });

    await runTest('Lockstep: changing inputDelay on the fly keeps frames monotonic', async () => {
        const p = makePair({ delay: 3 });
        p.advance(10);
        p.a.inputDelay = 10;
        p.advance(5);
        p.a.inputDelay = 2;
        p.advance(30);
        // own frames must be contiguous from 0..sentThrough
        for (let t = 0; t <= p.a.sentThrough; t++) assert(p.a.ownFrames.has(t), `A frame ${t} exists`);
        assert(sameLog(p.logA, p.logB), 'logs identical');
    });

    logSection('LockstepSync - Hash exchange');

    await runTest('Lockstep: matching hashes are reported as match', async () => {
        const s = new LockstepSync();
        s.start(0, 1); s.addPeer(2, 0);
        assert(s.recordLocalHash(60, 123) === null, 'no peer hash yet');
        const r = s.receivePeerHash(2, 60, 123);
        assert(r && r.mismatch === false && r.tick === 60, 'match');
        assert(s.hashMatches === 1 && s.hashMismatches === 0, 'counted');
    });

    await runTest('Lockstep: mismatching hashes are reported in either arrival order', async () => {
        const s = new LockstepSync();
        s.start(0, 1); s.addPeer(2, 0);
        assert(s.receivePeerHash(2, 60, 1) === null, 'peer first: not comparable yet');
        const r = s.recordLocalHash(60, 2);
        assert(r && r.mismatch === true, 'mismatch detected');
        assert(s.hashMismatches === 1, 'counted');
    });

    await runTest('Lockstep: hashes from non-peers are ignored', async () => {
        const s = new LockstepSync();
        s.start(0, 1); s.addPeer(2, 0);
        s.recordLocalHash(60, 5);
        assert(s.receivePeerHash(3, 60, 6) === null, 'player 3 not a peer');
    });
}
