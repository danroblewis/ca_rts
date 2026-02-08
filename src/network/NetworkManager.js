/**
 * NetworkManager - Manages multiplayer networking
 * 
 * Encapsulates:
 * - Network event handlers (connection, sync, actions)
 * - Matchmaking (join, watch, toggle multiplayer)
 * - URL state management for room/player
 */

import { PLAYER_1, PLAYER_2 } from '../utils/GameUtils.js';
import { MatchmakingDialog } from '../ui/MatchmakingDialog.js';
import { Logger } from '../utils/Logger.js';

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
        
        // Bind event handlers
        this._bindNetworkEvents();
    }
    
    /**
     * Bind all network event handlers
     */
    _bindNetworkEvents() {
        const ns = this.networkSync;
        const game = this.game;
        const config = this.config;
        
        ns.onConnectionChange = (connected) => {
            game.isMultiplayer = connected;
            if (!connected) {
                game.connectedPlayers.clear();
            }
            this._updateIndicator();
        };
        
        ns.onSpectating = (spectatorId, serverMapSeed, serverConnectedPlayers) => {
            Logger.log('network', `Joined as Spectator ${spectatorId}`);
            game.isSpectator = true;
            
            if (serverConnectedPlayers?.length) {
                serverConnectedPlayers.forEach(pid => game.connectedPlayers.add(pid));
            }
            
            if (serverMapSeed !== undefined && serverMapSeed !== game.mapSeed) {
                game.generateMap(serverMapSeed);
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
            game.targetTicksPerSecond = Math.max(1, serverTargetTps);
            
            if (targetTick > 0 && ns.playerId) {
                game.gameUI.setTargetTick(targetTick, leaderPlayer);
                
                const ourTick = Math.floor(game.simTime);
                const tickDiff = targetTick - ourTick;
                
                if (tickDiff > config.tickSyncHardThreshold) {
                    const catchupTicks = Math.min(tickDiff, config.tickCatchupBatch * 5);
                    for (let i = 0; i < catchupTicks; i++) {
                        game.simulationStep();
                    }
                } else if (tickDiff > config.tickSyncThreshold) {
                    const catchupTicks = Math.min(tickDiff - config.tickSyncThreshold, config.tickCatchupBatch);
                    for (let i = 0; i < catchupTicks; i++) {
                        game.simulationStep();
                    }
                }
            }
        };
        
        ns.onPlayerJoined = (playerId, isHost, serverMapSeed, serverConnectedPlayers) => {
            Logger.log('network', `Player joined: ${playerId}`);
            
            if (serverConnectedPlayers?.length) {
                serverConnectedPlayers.forEach(pid => game.connectedPlayers.add(pid));
            } else {
                game.connectedPlayers.add(playerId);
            }
            
            if (playerId === ns.playerId) {
                game.currentPlayer = playerId === 1 ? PLAYER_1 : PLAYER_2;
                game.gameUI.updatePlayerIndicator();
                
                if (isHost && game.waitingForSync) {
                    game.waitingForSync = false;
                }
                
                if (serverMapSeed !== undefined && serverMapSeed !== game.mapSeed) {
                    game.generateMap(serverMapSeed);
                    game.playerFactoryCounts[PLAYER_1] = 0;
                    game.playerFactoryCounts[PLAYER_2] = 0;
                    game.playerTotalFactoriesPlaced[PLAYER_1] = 0;
                    game.playerTotalFactoriesPlaced[PLAYER_2] = 0;
                    game.factoriesPlaced = 0;
                }
                
                this._updateURL({ room: this.roomId, player: playerId, seed: serverMapSeed });
            } else {
                // We're host, sync state to new player
                if (ns.playerId === 1) {
                    const gridData = game.grid.download();
                    ns.syncState(gridData, {
                        type: 'player_sync',
                        reason: 'new_player_joined',
                        newPlayerId: playerId,
                        factoryCounts: { ...game.playerFactoryCounts },
                        totalPlaced: { ...game.playerTotalFactoriesPlaced },
                        factoriesPlaced: game.factoriesPlaced
                    }, game.simTime);
                }
            }
            this._updateIndicator();
        };
        
        ns.onPlayerLeft = (playerId) => {
            game.connectedPlayers.delete(playerId);
            this._updateIndicator();
        };
        
        ns.onStateReceived = (syncData) => {
            this._handleStateReceived(syncData);
        };
        
        ns.onActionReceived = (message) => {
            const { playerId, simTime: actionTick, action } = message;
            game.rollbackManager.processRemoteAction(action, playerId, actionTick);
        };
    }
    
    /**
     * Handle received state sync
     */
    _handleStateReceived(syncData) {
        const game = this.game;
        const config = this.config;
        const isPeriodicSync = syncData.action?.type === 'periodic_sync';
        
        if (game.waitingForSync) {
            game.waitingForSync = false;
        }
        
        if (syncData.gridState?.length > 0) {
            game.grid.upload(syncData.gridState);
        }
        
        if (!isPeriodicSync) {
            game.simTime = syncData.simTime;
            game.rollbackManager?.clear();
            game.rollbackManager?.saveInitialCheckpoint(game.simTime);
        } else {
            const ticksToFastForward = Math.floor(game.simTime - syncData.simTime);
            if (ticksToFastForward > 0 && ticksToFastForward < 120) {
                game.simTime = syncData.simTime;
                for (let i = 0; i < ticksToFastForward; i++) {
                    game.simulationStep();
                }
            } else {
                game.simTime = syncData.simTime;
            }
        }
        
        const action = syncData.action;
        if (action) {
            if (action.type === 'player_sync' || action.type === 'periodic_sync') {
                if (action.factoryCounts) {
                    game.playerFactoryCounts[PLAYER_1] = action.factoryCounts[PLAYER_1] || 0;
                    game.playerFactoryCounts[PLAYER_2] = action.factoryCounts[PLAYER_2] || 0;
                }
                if (action.totalPlaced) {
                    game.playerTotalFactoriesPlaced[PLAYER_1] = action.totalPlaced[PLAYER_1] || 0;
                    game.playerTotalFactoriesPlaced[PLAYER_2] = action.totalPlaced[PLAYER_2] || 0;
                }
                if (action.factoriesPlaced !== undefined) {
                    game.factoriesPlaced = action.factoriesPlaced;
                }
                game.gameUI.updatePlayerIndicator();
            }
        }
    }
    
    /**
     * Update network indicator UI
     */
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
    
    /**
     * Update URL parameters
     */
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
    
    // ========================================================================
    // Public API - Matchmaking
    // ========================================================================
    
    /**
     * Join a room as a player
     */
    async joinRoom(roomIdToJoin) {
        this.roomId = roomIdToJoin;
        this.game.waitingForSync = true;
        this.game.waitingForSyncStartTime = performance.now();
        await this.networkSync.connect(
            `ws://${window.location.host}/ws`,
            roomIdToJoin,
            null,
            false
        );
    }
    
    /**
     * Watch a room as a spectator
     */
    async watchRoom(roomIdToWatch) {
        this.roomId = roomIdToWatch;
        this.game.isSpectator = true;
        await this.networkSync.connect(
            `ws://${window.location.host}/ws`,
            roomIdToWatch,
            null,
            true
        );
    }
    
    /**
     * Toggle multiplayer connection
     */
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
    
    /**
     * Auto-connect based on URL parameters
     */
    async autoConnect(roomParam, playerParam, spectatorParam) {
        if (!roomParam) return;
        
        const requestedPlayerId = playerParam ? parseInt(playerParam) : null;
        
        if (spectatorParam) {
            await this.watchRoom(this.roomId).catch(console.error);
        } else if (playerParam) {
            this.game.waitingForSync = true;
            this.game.waitingForSyncStartTime = performance.now();
            await this.networkSync.connect(
                `ws://${window.location.host}/ws`,
                this.roomId,
                requestedPlayerId,
                false
            ).catch(console.error);
        }
    }
    
    /**
     * Get current room ID
     */
    getRoomId() {
        return this.roomId;
    }
    
    /**
     * Set room ID
     */
    setRoomId(roomId) {
        this.roomId = roomId;
    }
}

