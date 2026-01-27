/**
 * GameState.js - Centralized game state management
 * 
 * This class holds all mutable game state and provides a clean interface
 * for reading and modifying it. No DOM dependencies.
 */

import { PLAYER_1, PLAYER_2 } from '../utils/GameUtils.js';

export class GameState {
    constructor(config = {}) {
        // Grid configuration
        this.gridSize = config.gridSize || 512;
        
        // Map seed
        this.mapSeed = config.mapSeed || 12345;
        
        // Current player (who is placing factories)
        this.currentPlayer = PLAYER_1;
        
        // Spectator mode
        this.isSpectator = false;
        
        // Game over state
        this.gameOver = false;
        this.winner = null;
        
        // Factory limits
        this.maxFactoriesPerPlayer = config.maxFactoriesPerPlayer || 7;
        
        // Factory counts (currently placed on map)
        this.playerFactoryCounts = {
            [PLAYER_1]: 0,
            [PLAYER_2]: 0
        };
        
        // Total factories ever placed (for win condition tracking)
        this.playerTotalFactoriesPlaced = {
            [PLAYER_1]: 0,
            [PLAYER_2]: 0
        };
        
        // Legacy counter (for first factory resources)
        this.factoriesPlaced = 0;
        
        // Simulation time (tick count)
        this.simTime = 0;
        
        // Network state
        this.isMultiplayer = false;
        this.connectedPlayers = new Set();
        this.roomId = null;
        
        // Delete mode
        this.deleteMode = false;
        
        // Selection state
        this.isSelecting = false;
        this.selectionStart = null;
        this.selectionEnd = null;
        this.hasActiveSelection = false;
        this.selectedRegion = null;  // {x1, y1, x2, y2} in grid coords
        
        // Active command for GPU rendering
        this.activeCommand = null;  // {sourceX1, sourceY1, sourceX2, sourceY2, destX, destY, player}
        
        // Camera state
        this.cameraX = this.gridSize / 2;
        this.cameraY = this.gridSize / 2;
        this.cameraZoom = config.defaultZoom || 2.0;
        this.minZoom = config.minZoom || 1.5;
        this.maxZoom = config.maxZoom || 8.0;
        
        // Listeners for state changes
        this.listeners = {
            playerChanged: [],
            gameOver: [],
            factoryCountChanged: [],
            selectionChanged: [],
            cameraChanged: []
        };
    }
    
    // ========================================================================
    // Event System
    // ========================================================================
    
    /**
     * Subscribe to a state change event.
     * 
     * @param {string} event - Event name
     * @param {function} callback - Callback function
     */
    on(event, callback) {
        if (this.listeners[event]) {
            this.listeners[event].push(callback);
        }
    }
    
    /**
     * Emit an event to all listeners.
     * 
     * @param {string} event - Event name
     * @param {any} data - Event data
     */
    emit(event, data) {
        if (this.listeners[event]) {
            this.listeners[event].forEach(cb => cb(data));
        }
    }
    
    // ========================================================================
    // Player Management
    // ========================================================================
    
    /**
     * Set the current player.
     */
    setCurrentPlayer(player) {
        if (player !== this.currentPlayer) {
            this.currentPlayer = player;
            this.emit('playerChanged', { player });
        }
    }
    
    /**
     * Toggle between players.
     */
    togglePlayer() {
        this.setCurrentPlayer(this.currentPlayer === PLAYER_1 ? PLAYER_2 : PLAYER_1);
    }
    
    /**
     * Set spectator mode.
     */
    setSpectator(isSpectator) {
        this.isSpectator = isSpectator;
    }
    
    // ========================================================================
    // Factory Management
    // ========================================================================
    
    /**
     * Check if a player can place a factory.
     */
    canPlaceFactory(player = this.currentPlayer) {
        const currentCount = this.playerFactoryCounts[player] || 0;
        return currentCount < this.maxFactoriesPerPlayer;
    }
    
    /**
     * Get remaining factory count for a player.
     */
    getRemainingFactories(player = this.currentPlayer) {
        const currentCount = this.playerFactoryCounts[player] || 0;
        return Math.max(0, this.maxFactoriesPerPlayer - currentCount);
    }
    
    /**
     * Increment factory count for a player.
     */
    incrementFactoryCount(player) {
        this.playerFactoryCounts[player] = (this.playerFactoryCounts[player] || 0) + 1;
        this.playerTotalFactoriesPlaced[player] = (this.playerTotalFactoriesPlaced[player] || 0) + 1;
        this.factoriesPlaced++;
        this.emit('factoryCountChanged', { player, counts: this.playerFactoryCounts });
    }
    
    /**
     * Decrement factory count for a player.
     */
    decrementFactoryCount(player) {
        if (this.playerFactoryCounts[player] > 0) {
            this.playerFactoryCounts[player]--;
            this.emit('factoryCountChanged', { player, counts: this.playerFactoryCounts });
        }
    }
    
    /**
     * Set factory counts directly (for network sync).
     */
    setFactoryCounts(counts, totalPlaced = null, factoriesPlaced = null) {
        this.playerFactoryCounts = { ...counts };
        if (totalPlaced) {
            this.playerTotalFactoriesPlaced = { ...totalPlaced };
        }
        if (factoriesPlaced !== null) {
            this.factoriesPlaced = factoriesPlaced;
        }
        this.emit('factoryCountChanged', { counts: this.playerFactoryCounts });
    }
    
    /**
     * Check if this is the first factory being placed.
     */
    isFirstFactory() {
        return this.factoriesPlaced === 0;
    }
    
    // ========================================================================
    // Win/Lose Conditions
    // ========================================================================
    
    /**
     * Check and update game over state.
     * A player loses when they have placed all their factories and have none left on map.
     */
    checkWinCondition() {
        for (const player of [PLAYER_1, PLAYER_2]) {
            const totalPlaced = this.playerTotalFactoriesPlaced[player] || 0;
            const currentCount = this.playerFactoryCounts[player] || 0;
            
            // Player loses if they've placed all allowed factories and have 0 on map
            if (totalPlaced >= this.maxFactoriesPerPlayer && currentCount === 0) {
                const winner = player === PLAYER_1 ? PLAYER_2 : PLAYER_1;
                this.setGameOver(winner);
                return true;
            }
        }
        return false;
    }
    
    /**
     * Set game over state.
     */
    setGameOver(winner) {
        if (!this.gameOver) {
            this.gameOver = true;
            this.winner = winner;
            this.emit('gameOver', { winner });
        }
    }
    
    /**
     * Reset game over state.
     */
    resetGameOver() {
        this.gameOver = false;
        this.winner = null;
    }
    
    // ========================================================================
    // Selection Management
    // ========================================================================
    
    /**
     * Start a selection at the given grid coordinates.
     */
    startSelection(x, y) {
        this.isSelecting = true;
        this.selectionStart = { x, y };
        this.selectionEnd = { x, y };
        this.emit('selectionChanged', { type: 'start', x, y });
    }
    
    /**
     * Update the selection end point.
     */
    updateSelection(x, y) {
        if (this.isSelecting) {
            this.selectionEnd = { x, y };
            this.emit('selectionChanged', { type: 'update', x, y });
        }
    }
    
    /**
     * End the selection and compute the selected region.
     */
    endSelection() {
        if (this.isSelecting && this.selectionStart && this.selectionEnd) {
            this.selectedRegion = {
                x1: Math.min(this.selectionStart.x, this.selectionEnd.x),
                y1: Math.min(this.selectionStart.y, this.selectionEnd.y),
                x2: Math.max(this.selectionStart.x, this.selectionEnd.x),
                y2: Math.max(this.selectionStart.y, this.selectionEnd.y)
            };
            this.isSelecting = false;
            this.emit('selectionChanged', { type: 'end', region: this.selectedRegion });
            return this.selectedRegion;
        }
        return null;
    }
    
    /**
     * Set that we have an active selection (units are marked).
     */
    setHasActiveSelection(hasSelection, region = null) {
        this.hasActiveSelection = hasSelection;
        if (region) {
            this.selectedRegion = region;
        }
        if (!hasSelection) {
            this.selectedRegion = null;
            this.activeCommand = null;
        }
    }
    
    /**
     * Clear all selection state.
     */
    clearSelection() {
        this.isSelecting = false;
        this.selectionStart = null;
        this.selectionEnd = null;
        this.hasActiveSelection = false;
        this.selectedRegion = null;
        this.activeCommand = null;
        this.emit('selectionChanged', { type: 'clear' });
    }
    
    /**
     * Set the active command (for GPU rendering).
     */
    setActiveCommand(command) {
        this.activeCommand = command;
    }
    
    // ========================================================================
    // Camera Management
    // ========================================================================
    
    /**
     * Set camera position.
     */
    setCamera(x, y) {
        this.cameraX = x;
        this.cameraY = y;
        this.clampCamera();
        this.emit('cameraChanged', { x: this.cameraX, y: this.cameraY, zoom: this.cameraZoom });
    }
    
    /**
     * Pan camera by delta.
     */
    panCamera(dx, dy) {
        this.cameraX += dx;
        this.cameraY += dy;
        this.clampCamera();
        this.emit('cameraChanged', { x: this.cameraX, y: this.cameraY, zoom: this.cameraZoom });
    }
    
    /**
     * Set zoom level.
     */
    setZoom(zoom) {
        this.cameraZoom = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
        this.clampCamera();
        this.emit('cameraChanged', { x: this.cameraX, y: this.cameraY, zoom: this.cameraZoom });
    }
    
    /**
     * Adjust zoom by a factor.
     */
    adjustZoom(factor) {
        this.setZoom(this.cameraZoom * factor);
    }
    
    /**
     * Get visible grid size based on zoom.
     */
    getVisibleGridSize() {
        return this.gridSize / this.cameraZoom;
    }
    
    /**
     * Clamp camera to keep view within map bounds.
     */
    clampCamera() {
        const halfVisible = this.getVisibleGridSize() / 2;
        this.cameraX = Math.max(halfVisible, Math.min(this.gridSize - halfVisible, this.cameraX));
        this.cameraY = Math.max(halfVisible, Math.min(this.gridSize - halfVisible, this.cameraY));
    }
    
    // ========================================================================
    // Simulation Time
    // ========================================================================
    
    /**
     * Get current simulation time (tick count).
     */
    getSimTime() {
        return this.simTime;
    }
    
    /**
     * Set simulation time.
     */
    setSimTime(time) {
        this.simTime = time;
    }
    
    /**
     * Increment simulation time.
     */
    incrementSimTime(delta = 1) {
        this.simTime += delta;
    }
    
    // ========================================================================
    // Network State
    // ========================================================================
    
    /**
     * Set multiplayer mode.
     */
    setMultiplayer(isMultiplayer, roomId = null) {
        this.isMultiplayer = isMultiplayer;
        this.roomId = roomId;
    }
    
    /**
     * Add a connected player.
     */
    addConnectedPlayer(playerId) {
        this.connectedPlayers.add(playerId);
    }
    
    /**
     * Remove a connected player.
     */
    removeConnectedPlayer(playerId) {
        this.connectedPlayers.delete(playerId);
    }
    
    /**
     * Set connected players from array.
     */
    setConnectedPlayers(players) {
        this.connectedPlayers = new Set(players);
    }
    
    /**
     * Check if both players are connected.
     */
    areBothPlayersConnected() {
        return this.connectedPlayers.has(1) && this.connectedPlayers.has(2);
    }
    
    // ========================================================================
    // Serialization (for network sync)
    // ========================================================================
    
    /**
     * Get state for network sync.
     */
    toSyncData() {
        return {
            factoryCounts: { ...this.playerFactoryCounts },
            totalPlaced: { ...this.playerTotalFactoriesPlaced },
            factoriesPlaced: this.factoriesPlaced,
            simTime: this.simTime,
            gameOver: this.gameOver,
            winner: this.winner
        };
    }
    
    /**
     * Apply state from network sync.
     */
    fromSyncData(data) {
        if (data.factoryCounts) {
            this.playerFactoryCounts = { ...data.factoryCounts };
        }
        if (data.totalPlaced) {
            this.playerTotalFactoriesPlaced = { ...data.totalPlaced };
        }
        if (data.factoriesPlaced !== undefined) {
            this.factoriesPlaced = data.factoriesPlaced;
        }
        if (data.simTime !== undefined) {
            this.simTime = data.simTime;
        }
        if (data.gameOver !== undefined) {
            this.gameOver = data.gameOver;
            this.winner = data.winner;
        }
    }
    
    // ========================================================================
    // Reset
    // ========================================================================
    
    /**
     * Reset game state for a new game.
     */
    reset(newMapSeed = null) {
        if (newMapSeed !== null) {
            this.mapSeed = newMapSeed;
        }
        
        this.gameOver = false;
        this.winner = null;
        this.factoriesPlaced = 0;
        this.playerFactoryCounts = { [PLAYER_1]: 0, [PLAYER_2]: 0 };
        this.playerTotalFactoriesPlaced = { [PLAYER_1]: 0, [PLAYER_2]: 0 };
        this.simTime = 0;
        this.clearSelection();
        
        // Reset camera to center
        this.cameraX = this.gridSize / 2;
        this.cameraY = this.gridSize / 2;
    }
}

// Export a singleton instance for easy access
// (Individual modules can also create their own instances for testing)
let defaultInstance = null;

export function getGameState() {
    if (!defaultInstance) {
        defaultInstance = new GameState();
    }
    return defaultInstance;
}

export function initGameState(config) {
    defaultInstance = new GameState(config);
    return defaultInstance;
}

