/**
 * AudioManager - Manages game audio initialization and UI controls
 * 
 * Encapsulates:
 * - Audio system initialization (requires user gesture)
 * - Audio button state management
 * - Global audio controls and debugging utilities
 */
import { AudioEngine } from './AudioEngine.js';
import { AudioReductionPipeline } from './AudioReductionPipeline.js';

export class AudioManager {
    /**
     * @param {Object} config - Configuration object
     * @param {number} config.gridSize - Grid size for audio reduction pipeline
     * @param {function} [config.onInitialized] - Callback when audio is initialized
     */
    constructor(config) {
        this.gridSize = config.gridSize;
        this.onInitializedCallback = config.onInitialized || null;
        
        // Create audio components
        this.reductionPipeline = new AudioReductionPipeline(this.gridSize, 4);
        this.engine = new AudioEngine();
        this.initialized = false;
        
        // Setup button reference
        this.buttonElement = null;
    }
    
    /**
     * Bind to a UI button element
     * @param {HTMLElement} buttonElement - The audio toggle button
     */
    bindButton(buttonElement) {
        this.buttonElement = buttonElement;
        if (buttonElement) {
            buttonElement.addEventListener('click', () => this.toggle());
        }
        this.updateButton();
    }
    
    /**
     * Initialize audio system (must be called after user gesture)
     */
    async init() {
        if (this.initialized) return;
        
        try {
            await this.reductionPipeline.init();
            await this.engine.init();
            await this.engine.resume();
            this.initialized = true;
            console.log('[Audio] System initialized');
            this.updateButton();
            
            if (this.onInitializedCallback) {
                this.onInitializedCallback();
            }
        } catch (e) {
            console.error('[Audio] Failed to initialize:', e);
        }
    }
    
    /**
     * Toggle between init and mute/unmute
     */
    async toggle() {
        if (!this.initialized) {
            await this.init();
        } else {
            this.engine.toggleMute();
            this.updateButton();
        }
    }
    
    /**
     * Toggle mute (only if already initialized)
     * @returns {boolean} - Whether audio is now muted
     */
    toggleMute() {
        const muted = this.engine.toggleMute();
        this.updateButton();
        return muted;
    }
    
    /**
     * Update the audio button visual state
     */
    updateButton() {
        if (!this.buttonElement) return;
        
        if (!this.initialized) {
            this.buttonElement.textContent = '🔊';
        } else if (this.engine.muted) {
            this.buttonElement.textContent = '🔇';
        } else {
            this.buttonElement.textContent = '🔊';
        }
    }
    
    /**
     * Check if audio is initialized
     * @returns {boolean}
     */
    isInitialized() {
        return this.initialized;
    }
    
    /**
     * Check if audio is muted
     * @returns {boolean}
     */
    isMuted() {
        return this.engine.muted;
    }
    
    /**
     * Play reject sound (for invalid actions)
     */
    playReject() {
        if (this.initialized) {
            this.engine.playReject();
        }
    }
    
    /**
     * Play missile armed sound
     */
    playMissileArmed() {
        if (this.initialized) {
            this.engine.playMissileArmed();
        }
    }
    
    /**
     * Start missile moving loop
     */
    startMissileMoving() {
        if (this.initialized) {
            this.engine.startMissileMoving();
        }
    }
    
    /**
     * Stop missile moving loop
     */
    stopMissileMoving() {
        if (this.initialized) {
            this.engine.stopMissileMoving();
        }
    }
    
    /**
     * Play missile explosion sound
     */
    playMissileExplosion() {
        if (this.initialized) {
            this.engine.playMissileExplosion();
        }
    }
    
    /**
     * Run audio update with current game state
     * @param {WebGLTexture} stateTexture - Current grid state texture
     */
    update(stateTexture) {
        if (!this.initialized) return;
        
        // Run reduction pipeline on current game state
        this.reductionPipeline.run(stateTexture);
        
        // Update audio engine with sound parameters
        this.engine.update(this.reductionPipeline.getSoundParams());
    }
    
    /**
     * Setup window debug utilities
     */
    setupDebugUtils() {
        window.initAudio = () => this.init();
        window.toggleMute = () => this.toggleMute();
        
        // Debug utilities for console testing
        window.audio = {
            engine: this.engine,
            // Test individual sounds
            testSpawn: () => this.engine.tryPlayOneShot('spawn', 1.0),
            testExplosion: () => this.engine.tryPlayOneShot('explosion', 1.0),
            testDepletion: () => this.engine.tryPlayOneShot('depletion', 1.0),
            testReject: () => this.engine.playReject(),
            // Missile sounds
            testMissileArmed: () => this.engine.playMissileArmed(),
            testMissileMoving: () => this.engine.startMissileMoving(),
            testMissileStop: () => this.engine.stopMissileMoving(),
            testMissileExplosion: () => this.engine.playMissileExplosion(),
            // Set loop volumes (0-1)
            setMining: (v) => {
                const ctx = this.engine.audioContext;
                if (ctx && this.engine.loops.mining?.gain) {
                    this.engine.loops.mining.gain.gain.setValueAtTime(v * 0.15, ctx.currentTime);
                }
            },
            setCombat: (v) => {
                const ctx = this.engine.audioContext;
                if (ctx && this.engine.loops.combat?.gain) {
                    this.engine.loops.combat.gain.gain.setValueAtTime(v * 0.2, ctx.currentTime);
                }
            },
            setFactory: (v) => this.engine.loops.factory?.setActivity?.(v),
            setSwarm: (v) => {
                const ctx = this.engine.audioContext;
                if (ctx && this.engine.loops.swarm?.gain) {
                    this.engine.loops.swarm.gain.gain.setValueAtTime(v * 0.1, ctx.currentTime);
                }
            },
            // Stop all sounds
            stopAll: () => {
                const ctx = this.engine.audioContext;
                if (ctx) {
                    Object.values(this.engine.loops).forEach(l => {
                        if (l?.gain?.gain) {
                            l.gain.gain.setValueAtTime(0, ctx.currentTime);
                        }
                    });
                }
            },
            // Show current state
            status: () => console.log('Loops:', this.engine.loops, 'One-shots:', this.engine.oneShotPools)
        };
    }
    
    /**
     * Get the underlying audio engine (for direct access when needed)
     * @returns {AudioEngine}
     */
    getEngine() {
        return this.engine;
    }
    
    /**
     * Get the reduction pipeline (for direct access when needed)
     * @returns {AudioReductionPipeline}
     */
    getReductionPipeline() {
        return this.reductionPipeline;
    }
}

