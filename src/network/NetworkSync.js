/**
 * NetworkSync - Handles multiplayer synchronization
 * 
 * Protocol:
 * - When a player performs an action, they send:
 *   1. Their entire grid state (serialized)
 *   2. The action they performed
 *   3. The current simulation tick
 * 
 * - The receiver replaces their grid with the sender's state
 */

export class NetworkSync {
    constructor(gridSize) {
        this.gridSize = gridSize;
        this.ws = null;
        this.playerId = null;
        this.spectatorId = null;
        this.roomId = null;
        this.isConnected = false;
        this.isSpectator = false;
        this.onStateReceived = null;
        this.onPlayerJoined = null;
        this.onPlayerLeft = null;
        this.onConnectionChange = null;
        this.onSpectating = null;  // Called when spectator joins
        this.onRestart = null;     // Called when game restarts
    }

    // ========================================================================
    // Grid Serialization/Deserialization
    // ========================================================================

    /**
     * Serialize grid data to a compact format for transmission
     * Uses base64 encoding of the raw float data
     * Logs how long serialization takes.
     */
    serializeGrid(gridData) {
        const start = performance.now();
        // Convert Float32Array to base64
        const bytes = new Uint8Array(gridData.buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        const elapsed = performance.now() - start;
        console.log(`[NetworkSync] serializeGrid took ${elapsed.toFixed(2)} ms`);
        return base64;
    }

    /**
     * Deserialize grid data from transmission format
     * Logs how long deserialization takes.
     */
    deserializeGrid(serialized) {
        const start = performance.now();
        // Convert base64 back to Float32Array
        const binary = atob(serialized);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        const floatArray = new Float32Array(bytes.buffer);
        const elapsed = performance.now() - start;
        console.log(`[NetworkSync] deserializeGrid took ${elapsed.toFixed(2)} ms`);
        return floatArray;
    }

    /**
     * Create a sync message with grid state and action
     */
    createSyncMessage(gridData, action, simTime) {
        return {
            type: 'sync',
            playerId: this.playerId,
            roomId: this.roomId,
            simTime: simTime,
            action: action,
            gridState: this.serializeGrid(gridData)
        };
    }

    /**
     * Parse a received sync message
     */
    parseSyncMessage(message) {
        return {
            ...message,
            gridState: this.deserializeGrid(message.gridState)
        };
    }

    // ========================================================================
    // WebSocket Connection
    // ========================================================================

    /**
     * Connect to the game server
     * @param {string} serverUrl - WebSocket server URL
     * @param {string} roomId - Room to join
     * @param {number|null} requestedPlayerId - Optional: request a specific player ID (for rejoining)
     * @param {boolean} asSpectator - If true, join as spectator instead of player
     */
    connect(serverUrl, roomId, requestedPlayerId = null, asSpectator = false) {
        return new Promise((resolve, reject) => {
            this.roomId = roomId;
            this.isSpectator = asSpectator;
            
            try {
                this.ws = new WebSocket(serverUrl);
                
                this.ws.onopen = () => {
                    console.log('[NetworkSync] Connected to server');
                    this.isConnected = true;
                    
                    if (asSpectator) {
                        // Join as spectator
                        const spectateMessage = {
                            type: 'spectate',
                            roomId: this.roomId
                        };
                        console.log(`[NetworkSync] Joining as spectator:`, JSON.stringify(spectateMessage));
                        this.send(spectateMessage);
                    } else {
                        // Join as player, optionally requesting a specific player ID
                        const joinMessage = {
                            type: 'join',
                            roomId: this.roomId
                        };
                        if (requestedPlayerId !== null && requestedPlayerId !== undefined && !isNaN(requestedPlayerId)) {
                            joinMessage.requestedPlayerId = requestedPlayerId;
                            console.log(`[NetworkSync] Requesting player ID: ${requestedPlayerId}`);
                        } else {
                            console.log(`[NetworkSync] No valid requestedPlayerId (value: ${requestedPlayerId})`);
                        }
                        console.log(`[NetworkSync] Sending join message:`, JSON.stringify(joinMessage));
                        this.send(joinMessage);
                    }
                    
                    if (this.onConnectionChange) {
                        this.onConnectionChange(true);
                    }
                    resolve();
                };
                
                this.ws.onclose = () => {
                    console.log('[NetworkSync] Disconnected from server');
                    this.isConnected = false;
                    this.playerId = null;
                    if (this.onConnectionChange) {
                        this.onConnectionChange(false);
                    }
                };
                
                this.ws.onerror = (error) => {
                    console.error('[NetworkSync] WebSocket error:', error);
                    reject(error);
                };
                
                this.ws.onmessage = (event) => {
                    this.handleMessage(JSON.parse(event.data));
                };
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Disconnect from the server
     */
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
        this.playerId = null;
    }

    /**
     * Send a message to the server
     */
    send(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }

    /**
     * Handle incoming messages
     */
    handleMessage(message) {
        switch (message.type) {
            case 'joined':
                this.playerId = message.playerId;
                console.log(`[NetworkSync] Joined as Player ${this.playerId}, mapSeed: ${message.mapSeed}, connectedPlayers: ${message.connectedPlayers}`);
                if (this.onPlayerJoined) {
                    this.onPlayerJoined(message.playerId, message.isHost, message.mapSeed, message.connectedPlayers);
                }
                break;
            
            case 'spectating':
                this.spectatorId = message.spectatorId;
                this.isSpectator = true;
                console.log(`[NetworkSync] Spectating as Spectator ${this.spectatorId}, mapSeed: ${message.mapSeed}`);
                if (this.onSpectating) {
                    this.onSpectating(message.spectatorId, message.mapSeed, message.connectedPlayers);
                }
                break;
                
            case 'player_joined':
                console.log(`[NetworkSync] Player ${message.playerId} joined`);
                if (this.onPlayerJoined) {
                    this.onPlayerJoined(message.playerId, false);
                }
                break;
                
            case 'player_left':
                console.log(`[NetworkSync] Player ${message.playerId} left`);
                if (this.onPlayerLeft) {
                    this.onPlayerLeft(message.playerId);
                }
                break;
                
            case 'sync':
                // Another player synced their state (or for spectators, any player)
                if (this.isSpectator || message.playerId !== this.playerId) {
                    console.log(`[NetworkSync] Received sync from Player ${message.playerId} at tick ${message.simTime}`);
                    const parsed = this.parseSyncMessage(message);
                    if (this.onStateReceived) {
                        this.onStateReceived(parsed);
                    }
                }
                break;
            
            case 'restart':
                console.log(`[NetworkSync] Game restart initiated by Player ${message.initiatedBy}, new seed: ${message.mapSeed}`);
                if (this.onRestart) {
                    this.onRestart(message.mapSeed, message.initiatedBy);
                }
                break;
                
            case 'error':
                console.error('[NetworkSync] Server error:', message.message);
                break;
                
            default:
                console.warn('[NetworkSync] Unknown message type:', message.type);
        }
    }

    // ========================================================================
    // Game Actions
    // ========================================================================

    /**
     * Sync state after performing an action
     */
    syncState(gridData, action, simTime) {
        if (!this.isConnected) return;
        
        const message = this.createSyncMessage(gridData, action, simTime);
        this.send(message);
        console.log(`[NetworkSync] Synced state after action: ${action.type}`);
    }

    /**
     * Request full state from host (for late joiners)
     */
    requestState() {
        if (!this.isConnected) return;
        
        this.send({
            type: 'request_state',
            roomId: this.roomId
        });
    }
    
    /**
     * Request game restart (Play Again)
     */
    requestRestart() {
        if (!this.isConnected || this.isSpectator) return;
        
        this.send({
            type: 'restart',
            roomId: this.roomId
        });
    }
}

// Singleton instance
let networkSyncInstance = null;

export function getNetworkSync(gridSize) {
    if (!networkSyncInstance) {
        networkSyncInstance = new NetworkSync(gridSize);
    }
    return networkSyncInstance;
}

