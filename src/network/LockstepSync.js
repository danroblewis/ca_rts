/**
 * LockstepSync - deterministic input-delay lockstep for the CA simulation.
 *
 * Model
 * -----
 * Every player emits one "input frame" per simulation tick:
 *     { tick, actions: [...] }
 * The frame for tick T is emitted when the player is about to simulate tick
 * T - inputDelay, so it has `inputDelay` ticks of slack to reach the peers.
 * A player may simulate tick T only once it holds the frame for T from every
 * peer (frames are per-tick and contiguous, so "holding tick T" means holding
 * every frame up to T). Both peers therefore apply exactly the same actions at
 * exactly the same ticks to exactly the same state, and the GPU simulation is
 * deterministic, so the timelines never diverge. There is no prediction, no
 * rollback and no periodic state snapshotting.
 *
 * Local actions are never applied immediately: they are attached to the next
 * frame to be emitted (tick >= current + inputDelay) and applied when that
 * tick is simulated, on every client alike.
 *
 * Divergence safety net
 * ---------------------
 * Clients periodically exchange a hash of their state at a given tick. A
 * mismatch (which should only ever happen on hardware with non-identical
 * float behaviour) is reported so the game can request a fresh snapshot from
 * the host. See Game.js for the recovery path.
 *
 * This class is pure bookkeeping: it sends nothing and touches no GPU state.
 */
export class LockstepSync {
    /**
     * @param {Object} [options]
     * @param {number} [options.inputDelay=6] - ticks between scheduling and applying a local action
     * @param {number} [options.historyTicks=1800] - how many ticks of frames to retain
     * @param {number} [options.hashHistory=64] - how many hash records to retain
     */
    constructor(options = {}) {
        this.inputDelay = options.inputDelay ?? 6;
        this.historyTicks = options.historyTicks ?? 1800;
        this.hashHistory = options.hashHistory ?? 64;

        this.localPlayer = null;
        this.peers = new Set();

        // Outgoing
        this.sentThrough = -1;            // highest tick with an emitted own frame
        this.ownFrames = new Map();       // tick -> actions[]
        this.pendingLocalActions = [];

        // Incoming
        this.peerFrames = new Map();      // player -> Map(tick -> actions[])
        this.peerConfirmed = new Map();   // player -> highest contiguous tick received

        // Hash exchange
        this.localHashes = new Map();     // tick -> hash
        this.peerHashes = new Map();      // player -> Map(tick -> hash)
        this.hashMismatches = 0;
        this.hashMatches = 0;

        this.stats = { framesSent: 0, framesReceived: 0, stalls: 0 };
    }

    // ------------------------------------------------------------------------
    // Setup
    // ------------------------------------------------------------------------

    /**
     * (Re)start at a tick: own frames start at `tick`, peers are expected to
     * provide frames from `tick` onwards. Keeps already-received peer frames
     * (a snapshot may have included future frames).
     */
    start(tick, localPlayer = this.localPlayer) {
        this.localPlayer = localPlayer;
        this.sentThrough = tick - 1;
        this.ownFrames.clear();
        this.pendingLocalActions = [];
        this.localHashes.clear();
        for (const p of this.peers) {
            this._recomputeConfirmed(p, tick - 1);
        }
    }

    /**
     * Add a peer that must provide frames from `fromTick` onwards.
     */
    addPeer(player, fromTick) {
        if (player === this.localPlayer) return;
        this.peers.add(player);
        if (!this.peerFrames.has(player)) this.peerFrames.set(player, new Map());
        if (!this.peerHashes.has(player)) this.peerHashes.set(player, new Map());
        this._recomputeConfirmed(player, fromTick - 1);
    }

    removePeer(player) {
        this.peers.delete(player);
        // Keep their frames: any future frames they already sent still apply.
    }

    hasPeer(player) {
        return this.peers.has(player);
    }

    // ------------------------------------------------------------------------
    // Outgoing frames
    // ------------------------------------------------------------------------

    /**
     * Queue a local action. It will be carried by the next emitted frame.
     * @returns {number} the tick the action will (at the earliest) apply at
     */
    scheduleLocal(action) {
        this.pendingLocalActions.push(action);
        return this.sentThrough + 1;
    }

    /**
     * Emit own frames for every tick up to and including `throughTick`.
     * Pending local actions ride in the first emitted frame.
     * @returns {Array<{tick:number, actions:Array}>} frames to send to peers
     */
    emitFramesThrough(throughTick) {
        const frames = [];
        while (this.sentThrough < throughTick) {
            const tick = this.sentThrough + 1;
            const actions = this.pendingLocalActions.length ? this.pendingLocalActions : [];
            this.pendingLocalActions = [];
            this.ownFrames.set(tick, actions);
            frames.push({ tick, actions });
            this.sentThrough = tick;
            this.stats.framesSent++;
        }
        return frames;
    }

    /** Own frames with tick >= fromTick (for snapshots / re-sends). */
    ownFramesSince(fromTick) {
        const out = [];
        for (const [tick, actions] of this.ownFrames) {
            if (tick >= fromTick) out.push({ playerId: this.localPlayer, tick, actions });
        }
        out.sort((a, b) => a.tick - b.tick);
        return out;
    }

    /** All known frames (own + peers) with tick >= fromTick. */
    allFramesSince(fromTick) {
        const out = this.ownFramesSince(fromTick);
        for (const [player, frames] of this.peerFrames) {
            for (const [tick, actions] of frames) {
                if (tick >= fromTick) out.push({ playerId: player, tick, actions });
            }
        }
        out.sort((a, b) => a.tick - b.tick || a.playerId - b.playerId);
        return out;
    }

    // ------------------------------------------------------------------------
    // Incoming frames
    // ------------------------------------------------------------------------

    /**
     * Store frames received from a peer (any order, duplicates ignored).
     */
    receiveFrames(player, frames) {
        if (player === this.localPlayer) return;
        let map = this.peerFrames.get(player);
        if (!map) { map = new Map(); this.peerFrames.set(player, map); }
        for (const f of frames) {
            if (!map.has(f.tick)) {
                map.set(f.tick, f.actions || []);
                this.stats.framesReceived++;
            }
        }
        if (this.peerConfirmed.has(player)) {
            this._advanceConfirmed(player);
        }
    }

    /**
     * Import frames from a snapshot: { playerId, tick, actions } records for
     * any player. Own frames are ignored (we are the authority on those).
     */
    importFrames(records) {
        const byPlayer = new Map();
        for (const r of records) {
            if (r.playerId === this.localPlayer) continue;
            if (!byPlayer.has(r.playerId)) byPlayer.set(r.playerId, []);
            byPlayer.get(r.playerId).push(r);
        }
        for (const [player, frames] of byPlayer) this.receiveFrames(player, frames);
    }

    _recomputeConfirmed(player, baseline) {
        const current = this.peerConfirmed.get(player);
        // A baseline only ever lowers the requirement if we have no record yet.
        this.peerConfirmed.set(player, current === undefined ? baseline : Math.max(current, baseline));
        this._advanceConfirmed(player);
    }

    _advanceConfirmed(player) {
        const map = this.peerFrames.get(player);
        if (!map) return;
        let confirmed = this.peerConfirmed.get(player);
        while (map.has(confirmed + 1)) confirmed++;
        this.peerConfirmed.set(player, confirmed);
    }

    // ------------------------------------------------------------------------
    // Simulation gating
    // ------------------------------------------------------------------------

    /** Can tick `tick` be simulated (all peer frames for it present)? */
    canSimulate(tick) {
        for (const p of this.peers) {
            if ((this.peerConfirmed.get(p) ?? -1) < tick) {
                return false;
            }
        }
        return true;
    }

    /** Highest tick that can currently be simulated (Infinity with no peers). */
    simulatableThrough() {
        let through = Infinity;
        for (const p of this.peers) {
            through = Math.min(through, this.peerConfirmed.get(p) ?? -1);
        }
        return through;
    }

    /** Peers whose frames for `tick` are missing, with the first missing tick. */
    missingFor(tick) {
        const out = [];
        for (const p of this.peers) {
            const c = this.peerConfirmed.get(p) ?? -1;
            if (c < tick) out.push({ player: p, fromTick: c + 1 });
        }
        return out;
    }

    /**
     * Actions to apply at `tick`, in deterministic order: by player id, then
     * by the order the player issued them.
     * @returns {Array<{action:Object, playerId:number}>}
     */
    actionsForTick(tick) {
        const players = [];
        if (this.localPlayer !== null) players.push(this.localPlayer);
        for (const p of this.peers) players.push(p);
        // Peers that left may still have frames for this tick.
        for (const p of this.peerFrames.keys()) if (!players.includes(p)) players.push(p);
        players.sort((a, b) => a - b);

        const out = [];
        for (const p of players) {
            const frames = p === this.localPlayer ? this.ownFrames : this.peerFrames.get(p);
            const actions = frames?.get(tick);
            if (!actions) continue;
            for (const action of actions) {
                // The frame owner is the default actor; an explicit action.player
                // (single-player "switch player" debugging, spectator tools) wins.
                const playerId = (action.player === 1 || action.player === 2) ? action.player : p;
                out.push({ action, playerId });
            }
        }
        return out;
    }

    // ------------------------------------------------------------------------
    // Hash exchange
    // ------------------------------------------------------------------------

    recordLocalHash(tick, hash) {
        this.localHashes.set(tick, hash);
        this._trimHashes(this.localHashes);
        return this._compareHashesAt(tick);
    }

    /**
     * @returns {null | {tick, mismatch:boolean}} when the tick is comparable
     */
    receivePeerHash(player, tick, hash) {
        let map = this.peerHashes.get(player);
        if (!map) { map = new Map(); this.peerHashes.set(player, map); }
        map.set(tick, hash);
        this._trimHashes(map);
        return this._compareHashesAt(tick);
    }

    _compareHashesAt(tick) {
        const local = this.localHashes.get(tick);
        if (local === undefined) return null;
        let compared = false;
        let mismatch = false;
        for (const [player, map] of this.peerHashes) {
            if (!this.peers.has(player)) continue;
            const h = map.get(tick);
            if (h === undefined) continue;
            compared = true;
            if (h !== local) mismatch = true;
        }
        if (!compared) return null;
        if (mismatch) this.hashMismatches++; else this.hashMatches++;
        return { tick, mismatch };
    }

    _trimHashes(map) {
        while (map.size > this.hashHistory) {
            const oldest = Math.min(...map.keys());
            map.delete(oldest);
        }
    }

    // ------------------------------------------------------------------------
    // Housekeeping
    // ------------------------------------------------------------------------

    /** Drop frames older than currentTick - historyTicks. */
    gc(currentTick) {
        const cutoff = currentTick - this.historyTicks;
        for (const tick of this.ownFrames.keys()) if (tick < cutoff) this.ownFrames.delete(tick);
        for (const map of this.peerFrames.values()) {
            for (const tick of map.keys()) if (tick < cutoff) map.delete(tick);
        }
    }

    getStats() {
        const confirmed = {};
        for (const [p, t] of this.peerConfirmed) confirmed[p] = t;
        return {
            ...this.stats,
            inputDelay: this.inputDelay,
            sentThrough: this.sentThrough,
            peers: [...this.peers],
            peerConfirmed: confirmed,
            hashMatches: this.hashMatches,
            hashMismatches: this.hashMismatches
        };
    }
}
