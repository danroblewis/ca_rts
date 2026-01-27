/**
 * SpeedToggle - UI component for simulation speed control
 * 
 * Manages the super speed toggle that switches between:
 * - Synced mode (simulation tied to render frame rate)
 * - Fast mode (simulation runs as fast as possible)
 */

export class SpeedToggle {
    /**
     * @param {Object} options
     * @param {boolean} options.defaultSyncMode - Initial sync state
     * @param {boolean} options.isOnLocalhost - If true, show toggle; if false, hide it
     * @param {Function} options.onSpeedChange - Called when speed mode changes: (syncWithRender) => void
     * @param {Function} options.onFastModeStart - Called when fast mode is enabled (to start fast loop)
     */
    constructor(options) {
        this.syncWithRender = options.defaultSyncMode ?? true;
        this.isOnLocalhost = options.isOnLocalhost ?? true;
        this.onSpeedChange = options.onSpeedChange || (() => {});
        this.onFastModeStart = options.onFastModeStart || (() => {});
        
        // Bind to DOM elements
        this.toggleElement = document.getElementById('speed-toggle');
        this.labelElement = document.getElementById('speed-label');
        this.containerElement = document.getElementById('speed-toggle-container');
        
        this._bindEvents();
        this._updateUI();
        
        // Hide on non-localhost
        if (!this.isOnLocalhost && this.containerElement) {
            this.containerElement.style.display = 'none';
        }
        
        // Expose to console
        window.toggleSimSync = () => this.toggle();
    }
    
    /**
     * Bind to DOM events
     */
    _bindEvents() {
        if (this.toggleElement) {
            this.toggleElement.addEventListener('change', (e) => {
                this.setSuperSpeed(e.target.checked);
            });
        }
    }
    
    /**
     * Update UI to reflect current state
     */
    _updateUI() {
        const superSpeedOn = !this.syncWithRender;
        
        if (this.toggleElement) {
            this.toggleElement.checked = superSpeedOn;
        }
        
        if (this.labelElement) {
            this.labelElement.classList.toggle('active', superSpeedOn);
        }
    }
    
    /**
     * Set super speed mode
     * @param {boolean} enabled - true for fast mode, false for synced mode
     */
    setSuperSpeed(enabled) {
        const wasFast = !this.syncWithRender;
        this.syncWithRender = !enabled;
        this._updateUI();
        
        console.log(`Super Speed: ${enabled ? 'ON (fast as possible)' : 'OFF (synced with render)'}`);
        
        this.onSpeedChange(this.syncWithRender);
        
        // Start fast loop when switching to fast mode
        if (!this.syncWithRender && !wasFast) {
            this.onFastModeStart();
        }
    }
    
    /**
     * Toggle between synced and fast mode
     */
    toggle() {
        this.setSuperSpeed(this.syncWithRender);
    }
    
    /**
     * Check if currently in sync mode
     * @returns {boolean}
     */
    isSyncMode() {
        return this.syncWithRender;
    }
    
    /**
     * Force sync mode (used when entering multiplayer)
     */
    forceSyncMode() {
        if (!this.syncWithRender) {
            this.syncWithRender = true;
            this._updateUI();
            this.onSpeedChange(this.syncWithRender);
        }
    }
    
    /**
     * Show the toggle
     */
    show() {
        if (this.containerElement) {
            this.containerElement.style.display = 'flex';
        }
    }
    
    /**
     * Hide the toggle
     */
    hide() {
        if (this.containerElement) {
            this.containerElement.style.display = 'none';
        }
    }
    
    /**
     * Get the sync state (for external use)
     * @returns {boolean}
     */
    getSyncWithRender() {
        return this.syncWithRender;
    }
}

