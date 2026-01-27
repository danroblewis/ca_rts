/**
 * WinConditionManager - Handles game end state detection and display
 * 
 * Checks for win/lose conditions based on factory counts and triggers
 * the game over UI when a player loses all their bases.
 */

import { PLAYER_1, PLAYER_2 } from '../utils/GameUtils.js';

export class WinConditionManager {
    /**
     * @param {Object} options
     * @param {Function} options.countFactories - () => { [PLAYER_1]: count, [PLAYER_2]: count }
     * @param {Function} options.getPlayerTotalFactoriesPlaced - () => { [PLAYER_1]: count, [PLAYER_2]: count }
     * @param {Function} options.onFactoryCountsUpdated - (counts) => void - Called when counts are updated
     * @param {Function} options.onGameOver - (winner, onPlayAgain) => void - Called when game ends
     * @param {number} [options.checkInterval=5000] - How often to check for win condition (ms)
     */
    constructor(options) {
        this.countFactories = options.countFactories;
        this.getPlayerTotalFactoriesPlaced = options.getPlayerTotalFactoriesPlaced;
        this.onFactoryCountsUpdated = options.onFactoryCountsUpdated || (() => {});
        this.onGameOver = options.onGameOver || (() => {});
        this.checkInterval = options.checkInterval ?? 5000;
        
        // Game state
        this.gameOver = false;
        this.winner = null;
        
        // Start periodic checking
        this.intervalId = null;
    }
    
    /**
     * Start the periodic win condition check
     */
    start() {
        if (this.intervalId) return;
        this.intervalId = setInterval(() => this.check(), this.checkInterval);
    }
    
    /**
     * Stop the periodic win condition check
     */
    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }
    
    /**
     * Reset game state for a new game
     */
    reset() {
        this.gameOver = false;
        this.winner = null;
    }
    
    /**
     * Check for win/lose condition
     * @returns {boolean} True if game ended
     */
    check() {
        if (this.gameOver) return false;
        
        // Count actual factories on map
        const actualCounts = this.countFactories();
        const totalPlaced = this.getPlayerTotalFactoriesPlaced();
        
        // Notify that counts have been updated
        this.onFactoryCountsUpdated(actualCounts);
        
        // Check lose condition: placed at least one base AND now have none left
        // (Must have placed at least one base to lose - can't lose before placing anything)
        for (const player of [PLAYER_1, PLAYER_2]) {
            if (totalPlaced[player] >= 1 && actualCounts[player] === 0) {
                // This player loses - all their bases were destroyed
                this.gameOver = true;
                this.winner = player === PLAYER_1 ? PLAYER_2 : PLAYER_1;
                console.log(`Player ${player} lost - all bases destroyed!`);
                this.onGameOver(this.winner);
                return true;
            }
        }
        
        return false;
    }
    
    /**
     * Check if the game is over
     * @returns {boolean}
     */
    isGameOver() {
        return this.gameOver;
    }
    
    /**
     * Get the winner (null if game not over)
     * @returns {number|null}
     */
    getWinner() {
        return this.winner;
    }
    
    /**
     * Force game over (for network sync scenarios)
     * @param {number} winningPlayer
     */
    setGameOver(winningPlayer) {
        this.gameOver = true;
        this.winner = winningPlayer;
        this.onGameOver(this.winner);
    }
}

