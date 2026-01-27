/**
 * SettingsUI - Manages shader and performance mode toggles
 * 
 * Handles:
 * - Shader mode switching (metaball/debug)
 * - Performance mode toggle (minimap on/off)
 * - URL parameter persistence
 */

export class SettingsUI {
    /**
     * @param {Object} options
     * @param {Object} options.shaders - { metaball: ComputeShader, debug: ComputeShader }
     * @param {Function} options.onShaderChange - Called when shader changes: (shader, mode) => void
     * @param {Function} options.onPerformanceChange - Called when perf mode changes: (enabled, showMinimap) => void
     */
    constructor(options) {
        this.shaders = options.shaders;
        this.onShaderChange = options.onShaderChange || (() => {});
        this.onPerformanceChange = options.onPerformanceChange || (() => {});
        
        // Get current mode from URL
        this.shaderMode = this._getShaderModeFromURL();
        this.performanceMode = this._getPerformanceModeFromURL();
        this.showMinimap = !this.performanceMode;
        
        // Bind to DOM elements
        this._bindShaderToggle();
        this._bindPerfToggle();
        
        // Expose to console for debugging
        window.switchShader = (mode) => this.setShaderMode(mode);
    }
    
    /**
     * Get shader mode from URL parameters
     */
    _getShaderModeFromURL() {
        const params = new URLSearchParams(window.location.search);
        const mode = params.get('shader');
        return mode === 'debug' ? 'debug' : 'metaball';
    }
    
    /**
     * Get performance mode from URL parameters
     */
    _getPerformanceModeFromURL() {
        const params = new URLSearchParams(window.location.search);
        const perf = params.get('perf');
        return perf === '1' || perf === 'true';
    }
    
    /**
     * Update URL with shader mode
     */
    _updateShaderURL(mode) {
        const url = new URL(window.location);
        if (mode === 'debug') {
            url.searchParams.set('shader', 'debug');
        } else {
            url.searchParams.delete('shader');
        }
        window.history.replaceState({}, '', url);
    }
    
    /**
     * Update URL with performance mode
     */
    _updatePerfURL(enabled) {
        const url = new URL(window.location);
        if (enabled) {
            url.searchParams.set('perf', '1');
        } else {
            url.searchParams.delete('perf');
        }
        window.history.replaceState({}, '', url);
    }
    
    /**
     * Bind to shader toggle DOM elements
     */
    _bindShaderToggle() {
        this.shaderToggle = document.getElementById('shader-toggle');
        this.labelPretty = document.getElementById('label-pretty');
        
        if (this.shaderToggle) {
            this.shaderToggle.addEventListener('change', (e) => {
                this.setShaderMode(e.target.checked ? 'debug' : 'metaball');
            });
        }
        
        this._updateShaderToggleUI();
    }
    
    /**
     * Bind to performance toggle DOM elements
     */
    _bindPerfToggle() {
        this.perfToggle = document.getElementById('perf-toggle');
        this.perfLabel = document.getElementById('perf-label');
        
        if (this.perfToggle) {
            this.perfToggle.addEventListener('change', (e) => {
                this.setPerformanceMode(e.target.checked);
            });
        }
        
        this._updatePerfToggleUI();
    }
    
    /**
     * Update shader toggle UI to match current state
     */
    _updateShaderToggleUI() {
        if (!this.shaderToggle || !this.labelPretty) return;
        
        if (this.shaderMode === 'debug') {
            this.labelPretty.classList.remove('active');
            this.shaderToggle.checked = true;
        } else {
            this.labelPretty.classList.add('active');
            this.shaderToggle.checked = false;
        }
    }
    
    /**
     * Update performance toggle UI to match current state
     */
    _updatePerfToggleUI() {
        if (!this.perfToggle || !this.perfLabel) return;
        
        if (this.performanceMode) {
            this.perfLabel.style.opacity = '1';
            this.perfLabel.style.color = '#22c55e';
            this.perfToggle.checked = true;
        } else {
            this.perfLabel.style.opacity = '0.8';
            this.perfLabel.style.color = '#aaa';
            this.perfToggle.checked = false;
        }
    }
    
    /**
     * Set shader mode
     * @param {string} mode - 'metaball' or 'debug'
     */
    setShaderMode(mode) {
        this.shaderMode = mode;
        this._updateShaderURL(mode);
        this._updateShaderToggleUI();
        
        const shader = mode === 'debug' ? this.shaders.debug : this.shaders.metaball;
        this.onShaderChange(shader, mode);
        
        console.log(`Switched to ${mode === 'debug' ? 'Debug' : 'Metaball'} shader`);
    }
    
    /**
     * Set performance mode
     * @param {boolean} enabled
     */
    setPerformanceMode(enabled) {
        this.performanceMode = enabled;
        this.showMinimap = !enabled;
        this._updatePerfURL(enabled);
        this._updatePerfToggleUI();
        
        this.onPerformanceChange(enabled, this.showMinimap);
        
        console.log(`Performance mode: ${enabled ? 'ON' : 'OFF'} (minimap: ${this.showMinimap ? 'visible' : 'hidden'})`);
    }
    
    /**
     * Get current shader
     * @returns {ComputeShader}
     */
    getCurrentShader() {
        return this.shaderMode === 'debug' ? this.shaders.debug : this.shaders.metaball;
    }
    
    /**
     * Get current shader mode
     * @returns {string}
     */
    getShaderMode() {
        return this.shaderMode;
    }
    
    /**
     * Check if performance mode is enabled
     * @returns {boolean}
     */
    isPerformanceMode() {
        return this.performanceMode;
    }
    
    /**
     * Check if minimap should be shown
     * @returns {boolean}
     */
    shouldShowMinimap() {
        return this.showMinimap;
    }
}

