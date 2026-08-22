/**
 * NetworkManager - Manages multiplayer networking
 *
 * Encapsulates:
 * - Network event handlers (connection, join/leave, snapshots, input frames,
 *   hash exchange, gap recovery)
 * - Matchmaking (join, watch, toggle multiplayer)
 * - URL state management for room/player
 *
 * Lockstep flow (see LockstepSync.js):
 * - On join, the joiner waits for a snapshot from the host. The host adds the
 *   joiner as a peer (which makes it stall at its current tick T), snapshots
 *   the state at T together with every input frame it knows for ticks >= T,
 *   and sends it. The joiner applies the snapshot, starts emitting frames at
 *   T, and both proceed in lockstep.
 * - Every simulated tick emits an input frame (Game.onFramesEmitted) which is
 *   relayed to all peers.
 * - Every `hashInterval` ticks the clients exchange a state hash; on mismatch
 *   the non-host requests a fresh snapshot.
 * - If a client is stalled for more than a second it asks the missing peer
 *   to re-send frames (covers join races / reconnects).
 */

import { PLAYER_1, PLAYER_2 } from '../utils/GameUtils.js';
import { MatchmakingDialog } from '../ui/MatchmakingDialog.js';
import { Logger } from '../utils/Logger.js';

const MIN_INPUT_DELAY = 6;      // ticks (100ms at 60tps)
const MAX_INPUT_DELAY = 90;     // ticks (1.5s)

export class NetworkManager {
    /**
     * @param {Object} options
     * @param {Object} options.networkSync - The NetworkSync instance
     * @param {Object} options.game - The Game instance
     * @param {Object} options.gameLoop - The GameLoop instance
     * @param {Object} options.networkIndicator - The NetworkIndicator UI component
     * @param {Object} options.speedToggle - The SpeedToggle UI component
     * @param {Object} options.config - Network configuration
     * @param {boolean} options.isOnLocalhost - Whether running on localhost
     */
    constructor(options) {
        this.networkSync = options.networkSync;
        this.game = options.game;
        this.gameLoop = options.gameLoop;
        this.networkIndicator = options.networkIndicator;
        this.speedToggle = options.speedToggle;
        this.config = options.config || {};
        this.isOnLocalhost = options.isOnLocalhost ?? true;

        this.roomId = options.initialRoomId || `game-${this.game.mapSeed}`;
        this.matchmakingDialog = null;

        this.adaptiveInputDelay = this.config.adaptiveInputDelay ?? true;
        this.lastStateRequestTime = 0;
        this.lastInputRequestTime = new Map();   // player -> time
        this.stalledSince = 0;
        this.stats = { snapshotsSent: 0, snapshotsReceived: 0, inputRequests: 0, stateRequests: 0, resends: 0 };

        this._bindNetworkEvents();
        this._bindGameEvents();
    }

    get isHost() {
        const ns = this.networkSync;
        return ns.playerId !== null && ns.hostId === ns.playerId;
    }

    // ========================================================================
    // Game -> network
    // ========================================================================

    _bindGameEvents() {
        const game = this.game;
        const ns = this.networkSync;

        game.onFramesEmitted = (frames) => {
            if (game.isMultiplayer && ns.isConnected && !game.isSpectator && game.lockstep.peers.size > 0) {
                ns.sendInputs(frames);
            }
        };

        game.onLocalHash = (tick, hash) => {
            if (game.isMultiplayer && ns.isConnected && !game.isSpectator) {
                ns.sendHash(tick, hash);
            }
        };

        game.onDesync = (tick) => {
            Logger.error('sync', `Desync at tick ${tick}`);
            if (!this.isHost) this._requestStateFromHost('desync');
        };
    }

    // ========================================================================
    // Network -> game
    // ========================================================================

    _bindNetworkEvents() {
        const ns = this.networkSync;
        const game = this.game;

        ns.onConnectionChange = (connected) => {
            if (!connected) {
                game.leaveMultiplayer();
            }
            this._updateIndicator();
        };

        ns.onSpectating = (spectatorId, serverMapSeed, serverConnectedPlayers) => {
            Logger.log('network', `Joined as Spectator ${spectatorId}`);
            game.isSpectator = true;
            game.isMultiplayer = true;

            if (serverMapSeed !== undefined && serverMapSeed !== game.mapSeed) {
                game.generateMap(serverMapSeed);
            }
            game.enterMultiplayer(0);
            game.currentPlayer = PLAYER_1;
            if (serverConnectedPlayers?.length) {
                for (const pid of serverConnectedPlayers) {
                    game.connectedPlayers.add(pid);
                    game.lockstep.addPeer(pid, game.simTime);
                }
                game.waitingForSync = true;
                game.waitingForSyncStartTime = performance.now();
            }

            this._updateURL({ room: this.roomId, spectator: 'true', player: null });
            this._updateIndicator();
            game.gameUI.updatePlayerIndicator();
        };

        ns.onRestart = (newMapSeed) => {
            const url = new URL(window.location);
            url.searchParams.set('seed', newMapSeed);
            window.location.href = url.toString();
        };

        ns.onSpeedSync = (serverTargetTps, slowestPlayer, tickCounts, targetTick, leaderPlayer) => {
            // Lockstep keeps the timelines aligned by itself; only update the UI.
            if (targetTick > 0 && ns.playerId) {
                game.gameUI.setTargetTick(targetTick, leaderPlayer);
            }
        };

        ns.onPlayerJoined = (playerId, isHost, serverMapSeed, serverConnectedPlayers) => {
            Logger.log('network', `Player joined: ${playerId}`);

            if (playerId === ns.playerId) {
                // It's us.
                const others = (serverConnectedPlayers || []).filter(p => p !== playerId);
                game.connectedPlayers.add(playerId);
                for (const p of others) game.connectedPlayers.add(p);

                if (serverMapSeed !== undefined && serverMapSeed !== game.mapSeed) {
                    game.generateMap(serverMapSeed);
                    game.playerFactoryCounts[PLAYER_1] = 0;
                    game.playerFactoryCounts[PLAYER_2] = 0;
                    game.playerTotalFactoriesPlaced[PLAYER_1] = 0;
                    game.playerTotalFactoriesPlaced[PLAYER_2] = 0;
                    game.factoriesPlaced = 0;
                }

                game.enterMultiplayer(playerId);
                game.gameUI.updatePlayerIndicator();

                if (others.length > 0) {
                    for (const p of others) game.lockstep.addPeer(p, game.simTime);
                    if (this.isHost) {
                        // We are the authority (e.g. the previous host left):
                        // bring the others onto our timeline.
                        game.waitingForSync = false;
                        this._sendSnapshot('host_joined', null);
                    } else {
                        // Others are mid-game: wait for the host's snapshot.
                        game.waitingForSync = true;
                        game.waitingForSyncStartTime = performance.now();
                        this._requestStateFromHost('join');
                    }
                } else {
                    game.waitingForSync = false;
                }

                this._updateURL({ room: this.roomId, player: playerId, seed: serverMapSeed });
                if (this.adaptiveInputDelay) ns.sendPing();
            } else {
                // A remote player joined. Gate on their frames from now on; the
                // host sends them a snapshot at exactly this tick.
                game.connectedPlayers.add(playerId);
                game.lockstep.addPeer(playerId, game.simTime);
                if (this.isHost) {
                    this._sendSnapshot('player_joined', playerId);
                }
            }
            this._updateIndicator();
        };

        ns.onPlayerLeft = (playerId) => {
            game.connectedPlayers.delete(playerId);
            game.lockstep.removePeer(playerId);
            if (game.waitingForSync && this.isHost) {
                // Nobody left to send us a snapshot; we are the authority now.
                game.waitingForSync = false;
            }
            this._updateIndicator();
        };

        ns.onStateReceived = (syncData) => {
            this._handleStateReceived(syncData);
        };

        ns.onStateRequested = (requestingPlayerId) => {
            if (this.isHost) {
                // null requester = a spectator joined: target spectators only so
                // in-sync players don't jump timelines.
                this._sendSnapshot('requested', requestingPlayerId ?? 'spectators');
            }
        };

        ns.onInputsReceived = (playerId, frames) => {
            game.lockstep.receiveFrames(playerId, frames);
            if (!game.connectedPlayers.has(playerId)) {
                // Frames can arrive before player_joined; remember the player.
                game.connectedPlayers.add(playerId);
            }
        };

        ns.onHashReceived = (playerId, tick, hash) => {
            game.receivePeerHash(playerId, tick, hash);
            this._updateInputDelay();
        };

        ns.onInputsRequested = (requestingPlayerId, fromTick) => {
            const frames = game.lockstep.ownFramesSince(fromTick)
                .map(f => ({ tick: f.tick, actions: f.actions }));
            if (frames.length) {
                this.stats.resends++;
                ns.sendInputs(frames);
            }
        };

        ns.onPong = () => this._updateInputDelay();

        // Legacy rollback-era action messages are ignored.
        ns.onActionReceived = () => {};
    }

    /**
     * Size the input delay for the client -> server -> client path: half of
     * our round trip plus half of the slowest peer's, with a jitter margin.
     * Until a peer has reported, assume it is as far from the server as we are.
     */
    _updateInputDelay() {
        const game = this.game;
        const ns = this.networkSync;
        if (!this.adaptiveInputDelay || !ns.rttPeakMs) return;
        const tickMs = 1000 / Math.max(1, game.targetTicksPerSecond || 60);
        let peerRtt = ns.rttPeakMs;
        for (const p of game.lockstep.peers) {
            const r = ns.peerRttMs[p];
            if (r !== undefined) peerRtt = Math.max(peerRtt, r);
        }
        const oneWayMs = ns.rttPeakMs / 2 + peerRtt / 2;
        const delay = Math.ceil((oneWayMs + 25) / tickMs) + 2;
        const clamped = Math.max(MIN_INPUT_DELAY, Math.min(MAX_INPUT_DELAY, delay));
        if (clamped !== game.multiplayerInputDelay) {
            Logger.log('network', `Input delay ${game.multiplayerInputDelay} -> ${clamped} ticks (rtt ${ns.rttPeakMs.toFixed(0)}ms, peer ${peerRtt.toFixed(0)}ms)`);
        }
        game.multiplayerInputDelay = clamped;
        if (game.isMultiplayer) game.lockstep.inputDelay = clamped;
    }

    /**
     * Called once per heartbeat (~1s) from the GameLoop: stall watchdog + ping.
     */
    onHeartbeat() {
        const game = this.game;
        const ns = this.networkSync;
        if (!game.isMultiplayer || !ns.isConnected) return;

        if (this.adaptiveInputDelay) ns.sendPing();

        const stalled = !game.waitingForSync && !game.lockstep.canSimulate(game.simTime);
        const now = performance.now();
        if (stalled) {
            if (this.stalledSince === 0) this.stalledSince = now;
            if (now - this.stalledSince > 1000) {
                for (const { player, fromTick } of game.lockstep.missingFor(game.simTime)) {
                    const last = this.lastInputRequestTime.get(player) || 0;
                    if (now - last > 1000) {
                        Logger.warn('sync', `Stalled at tick ${game.simTime}: requesting frames from P${player} since ${fromTick}`);
                        this.stats.inputRequests++;
                        ns.requestInputs(player, fromTick);
                        this.lastInputRequestTime.set(player, now);
                    }
                }
            }
        } else {
            this.stalledSince = 0;
        }

        // Waiting for the initial snapshot for too long: ask the host again.
        if (game.waitingForSync && now - game.waitingForSyncStartTime > 3000) {
            this._requestStateFromHost('join timeout');
            game.waitingForSyncStartTime = now;
        }
    }

    // ========================================================================
    // Snapshots
    // ========================================================================

    async _sendSnapshot(reason, targetPlayerId = null) {
        const game = this.game;
        const ns = this.networkSync;
        if (!ns.isConnected) return;
        const snapshot = await game.createSnapshot();
        if (!ns.isConnected) return;
        this.stats.snapshotsSent++;
        ns.syncState(snapshot.gridData, {
            type: 'snapshot',
            reason,
            targetPlayerId
        }, snapshot.tick, {
            counters: snapshot.counters,
            frames: snapshot.frames,
            hostId: ns.playerId
        });
        Logger.log('sync', `Sent snapshot at tick ${snapshot.tick} (${reason}, ${snapshot.frames.length} frames)`);
    }

    _requestStateFromHost(reason) {
        const now = performance.now();
        if (now - this.lastStateRequestTime < 3000) return;
        this.lastStateRequestTime = now;
        this.stats.stateRequests++;
        Logger.warn('sync', `Requesting snapshot from host (${reason})`);
        this.networkSync.requestState();
    }

    /**
     * Handle a received snapshot (binary sync message).
     */
    _handleStateReceived(syncData) {
        const game = this.game;
        const ns = this.networkSync;

        // Only the host's snapshots are authoritative.
        if (ns.hostId !== null && syncData.playerId !== ns.hostId && !game.isSpectator) {
            Logger.warn('sync', `Ignoring snapshot from non-host P${syncData.playerId}`);
            return;
        }
        if (!syncData.gridState || syncData.gridState.length === 0) return;

        // Targeting: null = everyone, 'spectators' = spectators only, number = that
        // player. An in-sync player ignores snapshots meant for someone else.
        const target = syncData.action?.targetPlayerId;
        if (!game.isSpectator && target !== null && target !== undefined && target !== ns.playerId) {
            if (target === 'spectators' || (!game.waitingForSync && !game.desyncDetected)) {
                Logger.log('sync', `Ignoring snapshot targeted at ${target}`);
                return;
            }
        }

        this.stats.snapshotsReceived++;
        game.applySnapshot({
            tick: syncData.simTime,
            gridData: syncData.gridState,
            counters: syncData.counters || null,
            frames: syncData.frames || []
        });

        // Make sure all current players are peers (frames may have arrived first)
        for (const pid of game.connectedPlayers) {
            if (pid !== ns.playerId && !game.lockstep.hasPeer(pid)) {
                game.lockstep.addPeer(pid, syncData.simTime);
            }
        }
    }

    // ========================================================================
    // UI helpers
    // ========================================================================

    _updateIndicator() {
        const game = this.game;

        this.networkIndicator.update(game.isMultiplayer, game.isSpectator, game.connectedPlayers);

        if (game.isMultiplayer && !this.isOnLocalhost) {
            this.speedToggle.hide();
            this.speedToggle.forceSyncMode();
            this.gameLoop.onSpeedChange(true);
        } else if (!game.isMultiplayer) {
            this.speedToggle.show();
        }
    }

    _updateURL(params) {
        const url = new URL(window.location);

        for (const [key, value] of Object.entries(params)) {
            if (value === null || value === undefined) {
                url.searchParams.delete(key);
            } else {
                url.searchParams.set(key, value);
            }
        }

        window.history.replaceState({}, '', url);
    }

    /**
     * Kept for callers that used to wait for remote action processing.
     */
    waitForPendingActions() {
        return Promise.resolve();
    }

    // ========================================================================
    // Public API - Matchmaking
    // ========================================================================

    async joinRoom(roomIdToJoin) {
        this.roomId = roomIdToJoin;
        this.game.waitingForSync = true;
        this.game.waitingForSyncStartTime = performance.now();
        await this.networkSync.connect(
            `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`,
            roomIdToJoin,
            null,
            false
        );
    }

    async watchRoom(roomIdToWatch) {
        this.roomId = roomIdToWatch;
        this.game.isSpectator = true;
        await this.networkSync.connect(
            `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`,
            roomIdToWatch,
            null,
            true
        );
    }

    async toggleMultiplayer() {
        if (this.game.isMultiplayer) {
            this.networkSync.disconnect();
        } else {
            if (!this.matchmakingDialog) {
                this.matchmakingDialog = new MatchmakingDialog(this.networkSync, {
                    onJoinRoom: (roomId) => this.joinRoom(roomId),
                    onWatchRoom: (roomId) => this.watchRoom(roomId),
                    onCreateRoom: (roomId) => this.joinRoom(roomId)
                });
            }
            await this.matchmakingDialog.show();
        }
    }

    async autoConnect(roomParam, playerParam, spectatorParam) {
        if (!roomParam) return;

        const requestedPlayerId = playerParam ? parseInt(playerParam) : null;

        if (spectatorParam) {
            await this.watchRoom(this.roomId).catch(console.error);
        } else if (playerParam) {
            this.game.waitingForSync = true;
            this.game.waitingForSyncStartTime = performance.now();
            await this.networkSync.connect(
                `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`,
                this.roomId,
                requestedPlayerId,
                false
            ).catch(console.error);
        }
    }

    getRoomId() {
        return this.roomId;
    }

    setRoomId(roomId) {
        this.roomId = roomId;
    }

    getStats() {
        return { ...this.stats, isHost: this.isHost, rttMs: this.networkSync.rttMs };
    }
}
