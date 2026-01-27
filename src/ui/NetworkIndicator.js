/**
 * NetworkIndicator - UI component showing multiplayer connection status
 * 
 * Displays:
 * - Connection status (click to connect)
 * - Player connection indicators (P1/P2)
 * - Spectator mode indicator
 */

export class NetworkIndicator {
    /**
     * @param {Object} options
     * @param {Function} options.onClick - Called when indicator is clicked
     * @param {boolean} [options.disabled=false] - If true, don't show the indicator
     */
    constructor(options) {
        this.onClick = options.onClick || (() => {});
        this.disabled = options.disabled ?? false;
        
        // State
        this.isMultiplayer = false;
        this.isSpectator = false;
        this.connectedPlayers = new Set();
        
        // DOM element
        this.element = null;
        
        if (!this.disabled) {
            this._createElement();
        }
    }
    
    /**
     * Create the indicator DOM element
     */
    _createElement() {
        this.element = document.createElement('div');
        this.element.id = 'network-indicator';
        this.element.style.cssText = `
            position: fixed;
            top: 38px;
            left: 8px;
            z-index: 200;
            padding: 4px 8px;
            border-radius: 4px;
            font-family: 'SF Mono', monospace;
            font-size: 10px;
            backdrop-filter: blur(8px);
            cursor: pointer;
        `;
        this.element.onclick = () => this.onClick();
        document.body.appendChild(this.element);
        
        this._render();
    }
    
    /**
     * Update the indicator display
     */
    _render() {
        if (!this.element) return;
        
        if (this.isMultiplayer) {
            const p1Connected = this.connectedPlayers.has(1);
            const p2Connected = this.connectedPlayers.has(2);
            const p1Status = p1Connected ? '🟣' : '⚫';
            const p2Status = p2Connected ? '🟢' : '⚫';
            
            if (this.isSpectator) {
                this.element.innerHTML = `👁 Spectating <span style="opacity: ${p1Connected ? 1 : 0.4}">${p1Status}</span> <span style="opacity: ${p2Connected ? 1 : 0.4}">${p2Status}</span>`;
                this.element.style.background = 'rgba(60, 60, 80, 0.9)';
            } else {
                this.element.innerHTML = `<span style="opacity: ${p1Connected ? 1 : 0.4}">${p1Status} P1</span> <span style="opacity: ${p2Connected ? 1 : 0.4}">${p2Status} P2</span>`;
                this.element.style.background = 'rgba(40, 40, 40, 0.9)';
            }
            this.element.style.color = 'white';
            this.element.style.border = '1px solid rgba(100, 100, 100, 0.8)';
        } else {
            this.element.textContent = '⚪ Click to Connect';
            this.element.style.background = 'rgba(80, 80, 80, 0.8)';
            this.element.style.color = 'white';
            this.element.style.border = '2px solid rgba(120, 120, 120, 0.8)';
        }
    }
    
    /**
     * Update connection state
     * @param {boolean} isMultiplayer
     * @param {boolean} isSpectator
     * @param {Set<number>} connectedPlayers
     */
    update(isMultiplayer, isSpectator, connectedPlayers) {
        this.isMultiplayer = isMultiplayer;
        this.isSpectator = isSpectator;
        this.connectedPlayers = connectedPlayers;
        this._render();
    }
    
    /**
     * Set multiplayer state
     * @param {boolean} isMultiplayer
     */
    setMultiplayer(isMultiplayer) {
        this.isMultiplayer = isMultiplayer;
        this._render();
    }
    
    /**
     * Set spectator mode
     * @param {boolean} isSpectator
     */
    setSpectator(isSpectator) {
        this.isSpectator = isSpectator;
        this._render();
    }
    
    /**
     * Update connected players set
     * @param {Set<number>} players
     */
    setConnectedPlayers(players) {
        this.connectedPlayers = players;
        this._render();
    }
    
    /**
     * Add a connected player
     * @param {number} playerId
     */
    addPlayer(playerId) {
        this.connectedPlayers.add(playerId);
        this._render();
    }
    
    /**
     * Remove a connected player
     * @param {number} playerId
     */
    removePlayer(playerId) {
        this.connectedPlayers.delete(playerId);
        this._render();
    }
    
    /**
     * Clear all connected players
     */
    clearPlayers() {
        this.connectedPlayers.clear();
        this._render();
    }
}

