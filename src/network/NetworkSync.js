/**
 * NetworkSync - WebSocket transport for multiplayer
 *
 * Protocol:
 * - Control messages (join, leave, heartbeat, ...) are JSON text.
 * - Lockstep input frames are JSON text: { type: 'inputs', playerId, frames }
 *   where frames = [{ tick, actions }]. Sent every tick, relayed by the server
 *   to every other client in the room.
 * - State hashes are JSON text: { type: 'hash', playerId, tick, hash }.
 * - Snapshots ("sync") are binary: [4-byte header length][JSON header][zlib grid]
 *   The header carries { tick, counters, frames } so a joiner (or a client
 *   recovering from a desync) can resume lockstep from the snapshot tick.
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
        this.localSimTime = 0;            // Track local simulation time for cache detection
        this.onStateReceived = null;      // Called when full state is received (legacy)
        this.onActionReceived = null;     // Called when lightweight action is received (rollback netcode)
        this.onPlayerJoined = null;
        this.onPlayerLeft = null;
        this.onConnectionChange = null;
        this.onSpectating = null;  // Called when spectator joins
        this.onRestart = null;     // Called when game restarts
        this.onSpeedSync = null;   // Called when server sends target simulation speed
        this.onInputsReceived = null;   // (playerId, frames) lockstep input frames
        this.onHashReceived = null;     // (playerId, tick, hash)
        this.onInputsRequested = null;  // (requestingPlayerId, fromTick) peer asks for re-send
        this.onStateRequested = null;   // (requestingPlayerId) peer/spectator asks for a snapshot
        this.onPong = null;             // (rttMs)
        this.hostId = null;
        this.rttMs = 0;          // smoothed round trip to the server
        this.rttPeakMs = 0;      // max of the recent samples (jitter-aware)
        this._rttSamples = [];
        this.peerRttMs = {};     // playerId -> that peer's reported rttPeakMs
    }

    // ========================================================================
    // Binary Sync Message Format
    // ========================================================================
    // 
    // Binary sync messages: [4-byte header length (little endian)][JSON header][raw grid bytes]
    // JSON header contains: { type, playerId, roomId, simTime, action }
    // Grid bytes are raw Float32Array data (no base64)
    //
    // This eliminates:
    // - Base64 encoding overhead (33% size increase)
    // - Slow character-by-character string building
    // ========================================================================

    /**
     * Create a binary sync message with grid state
     * Returns an ArrayBuffer ready to send
     * 
     * Format: [4-byte header length][JSON header][compressed grid bytes]
     * Header includes: compressed flag, original size for decompression
     */
    createBinarySyncMessage(gridData, action, simTime, extra = {}) {
        const start = performance.now();
        
        // Get raw grid bytes
        const gridBytes = new Uint8Array(gridData.buffer);
        const originalSize = gridBytes.length;
        
        // Compress grid data using pako (zlib deflate)
        const compressStart = performance.now();
        const compressedGrid = window.pako ? window.pako.deflate(gridBytes, { level: 1 }) : gridBytes;
        const compressEnd = performance.now();
        const isCompressed = window.pako !== undefined;
        
        // Create the JSON header (without grid data)
        const header = {
            type: 'sync',
            playerId: this.playerId,
            roomId: this.roomId,
            simTime: simTime,
            action: action,
            sentAt: Date.now(),
            compressed: isCompressed,
            originalSize: originalSize,
            ...extra
        };
        const headerJson = JSON.stringify(header);
        const headerBytes = new TextEncoder().encode(headerJson);
        
        // Create the binary message: [4-byte header length][header][compressed grid]
        const totalSize = 4 + headerBytes.length + compressedGrid.length;
        const message = new ArrayBuffer(totalSize);
        const view = new DataView(message);
        
        // Write header length (4 bytes, little endian)
        view.setUint32(0, headerBytes.length, true);
        
        // Write header
        const messageBytes = new Uint8Array(message);
        messageBytes.set(headerBytes, 4);
        
        // Write compressed grid data
        messageBytes.set(compressedGrid, 4 + headerBytes.length);
        
        const elapsed = performance.now() - start;
        const sizeMB = (totalSize / (1024 * 1024)).toFixed(2);
        const originalMB = (originalSize / (1024 * 1024)).toFixed(2);
        const ratio = ((1 - compressedGrid.length / originalSize) * 100).toFixed(1);
        console.log(`[NetworkSync] createBinarySyncMessage: ${originalMB} MB → ${sizeMB} MB (${ratio}% reduction) in ${elapsed.toFixed(2)} ms (compress: ${(compressEnd - compressStart).toFixed(2)} ms)`);
        
        return message;
    }

    /**
     * Parse a binary sync message received from the server
     */
    parseBinarySyncMessage(arrayBuffer) {
        const start = performance.now();
        
        const view = new DataView(arrayBuffer);
        const messageBytes = new Uint8Array(arrayBuffer);
        
        // Read header length (4 bytes, little endian)
        const headerLength = view.getUint32(0, true);
        
        // Read and parse header
        const headerBytes = messageBytes.slice(4, 4 + headerLength);
        const headerJson = new TextDecoder().decode(headerBytes);
        const header = JSON.parse(headerJson);
        
        // Read compressed grid data
        const compressedBytes = messageBytes.slice(4 + headerLength);
        
        // Decompress if needed
        let gridBytes;
        const decompressStart = performance.now();
        if (header.compressed && window.pako) {
            gridBytes = window.pako.inflate(compressedBytes);
        } else {
            gridBytes = compressedBytes;
        }
        const decompressEnd = performance.now();
        
        // Convert to Float32Array
        const gridData = new Float32Array(gridBytes.buffer, gridBytes.byteOffset, gridBytes.length / 4);
        
        const elapsed = performance.now() - start;
        const compressedKB = (compressedBytes.length / 1024).toFixed(1);
        const originalKB = (gridBytes.length / 1024).toFixed(1);
        console.log(`[NetworkSync] parseBinarySyncMessage: ${compressedKB} KB → ${originalKB} KB in ${elapsed.toFixed(2)} ms (decompress: ${(decompressEnd - decompressStart).toFixed(2)} ms)`);
        
        return {
            ...header,
            gridState: gridData
        };
    }

    // ========================================================================
    // Legacy base64 serialization (kept for backward compatibility with cache)
    // ========================================================================

    /**
     * Deserialize grid data from base64 format (for cached state from server)
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
        console.log(`[NetworkSync] deserializeGrid (base64) took ${elapsed.toFixed(2)} ms`);
        return floatArray;
    }

    /**
     * Parse a received JSON sync message (for cached state)
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
                
                // Handle both binary and text messages
                this.ws.binaryType = 'arraybuffer';
                this.ws.onmessage = (event) => {
                    if (event.data instanceof ArrayBuffer) {
                        // Binary message - this is a sync message
                        this.handleBinaryMessage(event.data);
                    } else {
                        // Text message - JSON control message
                        this.handleMessage(JSON.parse(event.data));
                    }
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
     * Send a JSON message to the server
     */
    send(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }

    /**
     * Send a binary message to the server
     */
    sendBinary(arrayBuffer) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(arrayBuffer);
        }
    }

    /**
     * Handle incoming binary messages (sync messages)
     */
    handleBinaryMessage(arrayBuffer) {
        const receiveTime = Date.now();
        const parsed = this.parseBinarySyncMessage(arrayBuffer);
        
        // Calculate network latency if sender included timestamp
        if (parsed.sentAt) {
            const networkLatency = receiveTime - parsed.sentAt;
            console.log(`[NetworkSync] Network latency: ${networkLatency} ms`);
        }
        
        if (this.isSpectator || parsed.playerId !== this.playerId) {
            console.log(`[NetworkSync] Received snapshot from Player ${parsed.playerId} at tick ${parsed.simTime}`);
            if (this.onStateReceived) {
                this.onStateReceived(parsed);
            }
        } else {
            console.log(`[NetworkSync] Ignoring our own snapshot (tick ${parsed.simTime})`);
        }
    }

    /**
     * Handle incoming JSON messages (control messages)
     */
    handleMessage(message) {
        switch (message.type) {
            case 'joined':
                this.playerId = message.playerId;
                if (message.hostId !== undefined) this.hostId = message.hostId;
                console.log(`[NetworkSync] Joined as Player ${this.playerId}, mapSeed: ${message.mapSeed}, connectedPlayers: ${message.connectedPlayers}, host: ${this.hostId}`);
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
                if (message.hostId !== undefined) this.hostId = message.hostId;
                if (this.onPlayerJoined) {
                    this.onPlayerJoined(message.playerId, false);
                }
                break;

            case 'player_left':
                console.log(`[NetworkSync] Player ${message.playerId} left`);
                if (message.hostId !== undefined) this.hostId = message.hostId;
                if (this.onPlayerLeft) {
                    this.onPlayerLeft(message.playerId);
                }
                break;

            case 'spectator_joined':
                // Host sends a fresh snapshot so the spectator can follow
                if (this.onStateRequested) {
                    this.onStateRequested(null);
                }
                break;

            case 'state_requested':
                if (this.onStateRequested) {
                    this.onStateRequested(message.requestingPlayerId);
                }
                break;

            case 'inputs':
                if (message.playerId !== this.playerId && this.onInputsReceived) {
                    this.onInputsReceived(message.playerId, message.frames || []);
                }
                break;

            case 'hash':
                if (message.playerId !== this.playerId) {
                    if (message.rtt !== undefined) this.peerRttMs[message.playerId] = message.rtt;
                    if (this.onHashReceived) this.onHashReceived(message.playerId, message.tick, message.hash, message.rtt);
                }
                break;

            case 'request_inputs':
                if (this.onInputsRequested) {
                    this.onInputsRequested(message.requestingPlayerId, message.fromTick);
                }
                break;

            case 'pong': {
                const rtt = Date.now() - message.t;
                this.rttMs = this.rttMs ? this.rttMs * 0.7 + rtt * 0.3 : rtt;
                this._rttSamples.push(rtt);
                if (this._rttSamples.length > 8) this._rttSamples.shift();
                this.rttPeakMs = Math.max(...this._rttSamples);
                if (this.onPong) this.onPong(rtt);
                break;
            }
                
            case 'sync':
                // JSON sync message (from server cache - base64 encoded)
                if (this.isSpectator || message.playerId !== this.playerId) {
                    console.log(`[NetworkSync] Received JSON sync from Player ${message.playerId} at tick ${message.simTime}`);
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
            
            case 'speed_sync':
                // Server telling us to sync to a specific simulation speed and tick count
                console.log(`[NetworkSync] Speed sync: target ${message.targetTicksPerSecond.toFixed(1)} tps (slowest: Player ${message.slowestPlayer})`);
                if (this.onSpeedSync) {
                    this.onSpeedSync(
                        message.targetTicksPerSecond, 
                        message.slowestPlayer,
                        message.tickCounts || {},
                        message.targetTick || 0,
                        message.leaderPlayer || 0
                    );
                }
                break;
            
            case 'game_action':
                // Lightweight action message - no grid state, requires rollback
                if (this.isSpectator || message.playerId !== this.playerId) {
                    const networkLatency = message.sentAt ? Date.now() - message.sentAt : 0;
                    console.log(`[NetworkSync] Received action from Player ${message.playerId}: ${message.action.type} at tick ${message.simTime} (latency: ${networkLatency}ms)`);
                    if (this.onActionReceived) {
                        this.onActionReceived(message);
                    }
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
     * Sync state after performing an action (uses binary format - LEGACY, expensive)
     */
    syncState(gridData, action, simTime, extra = {}) {
        if (!this.isConnected) return;
        
        const binaryMessage = this.createBinarySyncMessage(gridData, action, simTime, extra);
        this.sendBinary(binaryMessage);
        console.log(`[NetworkSync] Synced binary state after action: ${action.type}`);
    }

    /**
     * Send a lightweight action (no grid state) for rollback netcode.
     * The receiver will rollback to a checkpoint and replay with this action.
     * 
     * @param {Object} action - The action to send (type, data)
     * @param {number} simTime - The tick when this action was applied
     */
    sendAction(action, simTime) {
        if (!this.isConnected) return;
        
        const message = {
            type: 'game_action',
            playerId: this.playerId,
            roomId: this.roomId,
            simTime: simTime,
            action: action,
            sentAt: Date.now()
        };
        
        this.send(message);
        console.log(`[NetworkSync] Sent action: ${action.type} at tick ${simTime}`);
    }

    /**
     * Send lockstep input frames: [{ tick, actions }]
     */
    sendInputs(frames) {
        if (!this.isConnected || this.isSpectator || frames.length === 0) return;
        this.send({
            type: 'inputs',
            playerId: this.playerId,
            roomId: this.roomId,
            frames: frames
        });
    }

    /**
     * Send a state hash for divergence detection.
     */
    sendHash(tick, hash) {
        if (!this.isConnected || this.isSpectator) return;
        // Piggy-back our round trip so peers can size their input delay for
        // the full client->server->client path.
        this.send({ type: 'hash', playerId: this.playerId, roomId: this.roomId, tick, hash, rtt: this.rttPeakMs });
    }

    /**
     * Ask a peer to re-send its input frames from a tick (gap recovery).
     */
    requestInputs(targetPlayerId, fromTick) {
        if (!this.isConnected) return;
        this.send({
            type: 'request_inputs',
            roomId: this.roomId,
            requestingPlayerId: this.playerId,
            targetPlayerId: targetPlayerId,
            fromTick: fromTick
        });
    }

    /**
     * Round-trip measurement (server echoes as 'pong').
     */
    sendPing() {
        if (!this.isConnected) return;
        this.send({ type: 'ping', roomId: this.roomId, t: Date.now() });
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
    
    /**
     * Send heartbeat with current simulation speed and tick count
     * @param {number} ticksPerSecond - Current effective simulation speed
     * @param {number} currentTick - Current simulation tick count
     */
    sendHeartbeat(ticksPerSecond, currentTick) {
        if (!this.isConnected || this.isSpectator) return;
        
        // Track local sim time so we can detect cached state from server
        this.localSimTime = currentTick;
        
        this.send({
            type: 'heartbeat',
            roomId: this.roomId,
            playerId: this.playerId,
            ticksPerSecond: ticksPerSecond,
            currentTick: currentTick
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

