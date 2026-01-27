/**
 * GameUI.js - Game UI elements (player indicator, FPS display, tick display)
 * 
 * This module handles HUD elements that display game status information.
 */

export class GameUI {
    constructor(options = {}) {
        this.isOnGitHub = options.isOnGitHub || false;
        this.maxFactoriesPerPlayer = options.maxFactoriesPerPlayer || 7;
        this.tickSyncThreshold = options.tickSyncThreshold || 5;
        
        // Callbacks for getting current state
        this.getCurrentPlayer = options.getCurrentPlayer || (() => 1);
        this.getPlayerFactoryCount = options.getPlayerFactoryCount || (() => 0);
        this.isSpectator = options.isSpectator || (() => false);
        this.isMultiplayer = options.isMultiplayer || (() => false);
        this.getSimTime = options.getSimTime || (() => 0);
        this.onSwitchPlayer = options.onSwitchPlayer || (() => {});
        
        // State for displays
        this.lastKnownTargetTick = 0;
        this.lastKnownLeaderPlayer = 0;
        
        // DOM elements (created lazily)
        this._playerIndicator = null;
        this._tickDisplay = null;
        this._fpsDisplay = null;
        
        // Bind keyboard listener for player switch
        this._bindKeyboardListener();
    }
    
    /**
     * Bind keyboard listener for player switching (1/2 keys)
     */
    _bindKeyboardListener() {
        document.addEventListener('keydown', (e) => {
            if (e.key === '1') {
                this.onSwitchPlayer(1);
            } else if (e.key === '2') {
                this.onSwitchPlayer(2);
            }
        });
    }
    
    /**
     * Update target tick info (called from network sync)
     */
    setTargetTick(tick, leaderPlayer = 0) {
        this.lastKnownTargetTick = tick;
        this.lastKnownLeaderPlayer = leaderPlayer;
    }
    
    /**
     * Update the player indicator display
     */
    updatePlayerIndicator() {
        if (this.isOnGitHub) return;
        
        if (!this._playerIndicator) {
            this._playerIndicator = document.createElement('div');
            this._playerIndicator.id = 'player-indicator';
            this._playerIndicator.style.cssText = `
                position: fixed;
                top: 8px;
                left: 8px;
                z-index: 200;
                padding: 4px 8px;
                border-radius: 4px;
                font-family: 'SF Mono', monospace;
                font-size: 11px;
                font-weight: bold;
                backdrop-filter: blur(8px);
                cursor: pointer;
            `;
            this._playerIndicator.onclick = () => this.onSwitchPlayer();
            document.body.appendChild(this._playerIndicator);
        }
        
        const indicator = this._playerIndicator;
        const currentPlayer = this.getCurrentPlayer();
        const baseCount = this.getPlayerFactoryCount(currentPlayer);
        
        if (this.isSpectator()) {
            indicator.textContent = '👁 Spectator';
            indicator.style.background = 'rgba(80, 80, 100, 0.8)';
            indicator.style.color = 'white';
            indicator.style.border = '2px solid rgba(120, 120, 150, 0.8)';
            indicator.style.cursor = 'default';
        } else {
            if (currentPlayer === 1) {
                indicator.textContent = `Player 1 (${baseCount}/${this.maxFactoriesPerPlayer})`;
                indicator.style.background = 'rgba(112, 51, 204, 0.8)';
                indicator.style.color = 'white';
                indicator.style.border = '2px solid rgba(160, 100, 255, 0.8)';
            } else {
                indicator.textContent = `Player 2 (${baseCount}/${this.maxFactoriesPerPlayer})`;
                indicator.style.background = 'rgba(51, 179, 102, 0.8)';
                indicator.style.color = 'white';
                indicator.style.border = '2px solid rgba(100, 220, 150, 0.8)';
            }
            indicator.style.cursor = 'pointer';
        }
    }
    
    /**
     * Update the tick display
     */
    updateTickDisplay() {
        if (!this._tickDisplay) {
            this._tickDisplay = document.createElement('div');
            this._tickDisplay.id = 'tick-display';
            this._tickDisplay.style.cssText = `
                position: fixed;
                bottom: 8px;
                right: 8px;
                z-index: 200;
                padding: 4px 8px;
                border-radius: 4px;
                font-family: 'SF Mono', monospace;
                font-size: 11px;
                background: rgba(0, 0, 0, 0.6);
                color: #aaa;
                backdrop-filter: blur(4px);
            `;
            document.body.appendChild(this._tickDisplay);
        }
        
        const ourTick = Math.floor(this.getSimTime());
        
        if (this.isMultiplayer() && this.lastKnownTargetTick > 0) {
            const diff = this.lastKnownTargetTick - ourTick;
            const diffStr = Math.abs(diff).toString().padStart(4, '\u2007');
            let diffColor = '#aaa';
            let statusText = '';
            
            if (diff > this.tickSyncThreshold) {
                diffColor = '#f99';
                statusText = `Δ <span style="color:${diffColor}">${diffStr}</span> behind`;
            } else if (diff < -this.tickSyncThreshold) {
                diffColor = '#9f9';
                statusText = `Δ <span style="color:${diffColor}">${diffStr}</span> ahead `;
            } else {
                statusText = `Δ <span style="color:#9f9">${diffStr}</span> synced`;
            }
            this._tickDisplay.innerHTML = `Tick: ${ourTick} (${statusText})`;
        } else {
            this._tickDisplay.textContent = `Tick: ${ourTick}`;
        }
    }
    
    /**
     * Show game over overlay
     * @param {number} winner - The winning player (1 or 2)
     * @param {boolean} isMultiplayer - Whether in multiplayer mode
     * @param {boolean} isSpectator - Whether viewing as spectator
     * @param {Function} onRestart - Callback for restart button
     */
    showGameOver(winner, isMultiplayer, isSpectator, onRestart) {
        const overlay = document.createElement('div');
        overlay.id = 'game-over-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.85);
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            z-index: 10000;
        `;
        
        const winnerName = winner === 1 ? 'Player 1 (Purple)' : 'Player 2 (Green)';
        const winnerColor = winner === 1 ? '#a855f7' : '#22c55e';
        
        overlay.innerHTML = `
            <h1 style="color: ${winnerColor}; font-size: 4rem; margin-bottom: 1rem; font-family: sans-serif;">
                ${winnerName} Wins!
            </h1>
            <p style="color: #888; font-size: 1.5rem; font-family: sans-serif;">
                The opponent has lost all their bases.
            </p>
            <button id="play-again-btn" style="
                margin-top: 2rem;
                padding: 1rem 2rem;
                font-size: 1.2rem;
                background: ${winnerColor};
                color: white;
                border: none;
                border-radius: 8px;
                cursor: pointer;
                font-family: sans-serif;
            ">Play Again</button>
        `;
        
        document.body.appendChild(overlay);
        
        document.getElementById('play-again-btn').onclick = () => {
            if (onRestart) onRestart();
        };
        
        console.log(`[Game Over] ${winnerName} wins!`);
    }
    
    /**
     * Update the FPS/TPS display
     */
    updateFpsDisplay(currentTps, targetTps, potentialTps = null, renderFps = 60) {
        if (!this._fpsDisplay) {
            this._fpsDisplay = document.createElement('div');
            this._fpsDisplay.id = 'fps-display';
            this._fpsDisplay.style.cssText = `
                position: fixed;
                bottom: 8px;
                left: 8px;
                z-index: 200;
                padding: 4px 8px;
                border-radius: 4px;
                font-family: 'SF Mono', monospace;
                font-size: 11px;
                background: rgba(0, 0, 0, 0.6);
                color: #aaa;
                backdrop-filter: blur(4px);
            `;
            document.body.appendChild(this._fpsDisplay);
        }
        
        if (this.isMultiplayer()) {
            const actual = Math.round(currentTps);
            const target = Math.round(targetTps);
            const potential = potentialTps ? Math.round(potentialTps) : actual;
            
            if (actual < target * 0.9) {
                this._fpsDisplay.textContent = `${actual} TPS (target: ${target}, max: ${potential})`;
                this._fpsDisplay.style.color = '#f99';
            } else if (potential > target * 1.2) {
                this._fpsDisplay.textContent = `${actual} TPS (synced, could do ${potential})`;
                this._fpsDisplay.style.color = '#9f9';
            } else {
                this._fpsDisplay.textContent = `${actual} TPS`;
                this._fpsDisplay.style.color = '#9f9';
            }
        } else {
            const fps = Math.round(renderFps);
            const tps = Math.round(currentTps);
            this._fpsDisplay.textContent = `${fps} FPS | ${tps} TPS`;
            this._fpsDisplay.style.color = fps <= 30 ? '#f99' : fps < 55 ? '#ff9' : '#9f9';
        }
    }
}

