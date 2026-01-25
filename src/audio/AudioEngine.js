/**
 * AudioEngine - Web Audio API based sound system
 * 
 * Manages continuous loops and one-shot sounds, driven by
 * intensity values from the AudioReductionPipeline.
 * 
 * Sound Architecture:
 * - Continuous loops (mining, combat, factory hum, swarm) with volume control
 * - One-shot sounds (spawn, explosion) with rate limiting
 * - Master ambient drone
 */
export class AudioEngine {
    constructor() {
        this.audioContext = null;
        this.masterGain = null;
        this.initialized = false;
        this.muted = false;
        
        // Continuous loops
        this.loops = {
            ambient: null,
            mining: null,
            combat: null,
            factory: null,
            swarm: null
        };
        
        // One-shot pools
        this.oneShotPools = {
            spawn: { sounds: [], maxVoices: 3, lastPlayed: 0, cooldown: 100 },
            explosion: { sounds: [], maxVoices: 2, lastPlayed: 0, cooldown: 200 }
        };
        
        // Current target volumes (for smooth transitions)
        this.targetVolumes = {
            ambient: 0.3,
            mining: 0,
            combat: 0,
            factory: 0,
            swarm: 0
        };
        
        // Smoothing factor for volume changes
        this.volumeSmoothFactor = 0.1;
    }
    
    /**
     * Initialize the audio engine. Must be called from a user gesture.
     */
    async init() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            
            // Master gain
            this.masterGain = this.audioContext.createGain();
            this.masterGain.gain.value = 0.5;
            this.masterGain.connect(this.audioContext.destination);
            
            // Create loops with generated tones (we'll replace with real sounds later)
            await this.createGeneratedLoops();
            
            this.initialized = true;
            console.log('[AudioEngine] Initialized');
            
            return true;
        } catch (e) {
            console.error('[AudioEngine] Failed to initialize:', e);
            return false;
        }
    }
    
    /**
     * Create generated audio loops using oscillators.
     * These are placeholder sounds - can be replaced with real audio files.
     */
    async createGeneratedLoops() {
        // Ambient: Low drone (warp core style)
        this.loops.ambient = this.createDroneLoop(55, 'sawtooth', 0.15);  // A1
        
        // Mining: Crystalline shimmer
        this.loops.mining = this.createShimmerLoop(880, 0.1);  // High A
        
        // Combat: Aggressive pulse
        this.loops.combat = this.createPulseLoop(110, 0.08);  // Low
        
        // Factory: Mechanical hum
        this.loops.factory = this.createDroneLoop(82.5, 'triangle', 0.12);  // E2
        
        // Swarm: Buzzing
        this.loops.swarm = this.createBuzzLoop(220, 0.06);
        
        // Start all loops (but with zero volume)
        Object.values(this.loops).forEach(loop => {
            if (loop && loop.start) {
                loop.gainNode.gain.value = 0;
                loop.start();
            }
        });
    }
    
    /**
     * Create a simple drone loop
     */
    createDroneLoop(frequency, type, baseVolume) {
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        const filter = this.audioContext.createBiquadFilter();
        
        osc.type = type;
        osc.frequency.value = frequency;
        
        filter.type = 'lowpass';
        filter.frequency.value = 400;
        filter.Q.value = 1;
        
        gain.gain.value = 0;
        
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.masterGain);
        
        return {
            oscillator: osc,
            gainNode: gain,
            filter: filter,
            baseVolume: baseVolume,
            start: () => osc.start(),
            stop: () => osc.stop()
        };
    }
    
    /**
     * Create a shimmering loop (for mining)
     */
    createShimmerLoop(frequency, baseVolume) {
        const osc1 = this.audioContext.createOscillator();
        const osc2 = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        const filter = this.audioContext.createBiquadFilter();
        
        osc1.type = 'sine';
        osc1.frequency.value = frequency;
        
        osc2.type = 'sine';
        osc2.frequency.value = frequency * 1.5;  // Fifth
        
        filter.type = 'bandpass';
        filter.frequency.value = 1200;
        filter.Q.value = 2;
        
        gain.gain.value = 0;
        
        osc1.connect(filter);
        osc2.connect(filter);
        filter.connect(gain);
        gain.connect(this.masterGain);
        
        // Add slight detuning for shimmer
        const lfo = this.audioContext.createOscillator();
        const lfoGain = this.audioContext.createGain();
        lfo.frequency.value = 6;
        lfoGain.gain.value = 5;
        lfo.connect(lfoGain);
        lfoGain.connect(osc1.frequency);
        lfoGain.connect(osc2.frequency);
        lfo.start();
        
        return {
            oscillator: osc1,
            oscillator2: osc2,
            gainNode: gain,
            filter: filter,
            lfo: lfo,
            baseVolume: baseVolume,
            start: () => { osc1.start(); osc2.start(); },
            stop: () => { osc1.stop(); osc2.stop(); lfo.stop(); }
        };
    }
    
    /**
     * Create a pulsing loop (for combat)
     */
    createPulseLoop(frequency, baseVolume) {
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        const pulseGain = this.audioContext.createGain();
        const filter = this.audioContext.createBiquadFilter();
        
        osc.type = 'sawtooth';
        osc.frequency.value = frequency;
        
        filter.type = 'lowpass';
        filter.frequency.value = 600;
        filter.Q.value = 5;
        
        // Pulse modulation
        const lfo = this.audioContext.createOscillator();
        lfo.type = 'square';
        lfo.frequency.value = 4;  // 4 Hz pulse
        const lfoGain = this.audioContext.createGain();
        lfoGain.gain.value = 0.5;
        lfo.connect(lfoGain);
        lfoGain.connect(pulseGain.gain);
        pulseGain.gain.value = 0.5;
        
        gain.gain.value = 0;
        
        osc.connect(filter);
        filter.connect(pulseGain);
        pulseGain.connect(gain);
        gain.connect(this.masterGain);
        lfo.start();
        
        return {
            oscillator: osc,
            gainNode: gain,
            filter: filter,
            lfo: lfo,
            baseVolume: baseVolume,
            start: () => osc.start(),
            stop: () => { osc.stop(); lfo.stop(); }
        };
    }
    
    /**
     * Create a buzzing loop (for swarm)
     */
    createBuzzLoop(frequency, baseVolume) {
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        const filter = this.audioContext.createBiquadFilter();
        
        osc.type = 'sawtooth';
        osc.frequency.value = frequency;
        
        filter.type = 'bandpass';
        filter.frequency.value = 800;
        filter.Q.value = 3;
        
        // Rapid modulation for buzz
        const lfo = this.audioContext.createOscillator();
        const lfoGain = this.audioContext.createGain();
        lfo.frequency.value = 30;  // Fast buzz
        lfoGain.gain.value = 20;
        lfo.connect(lfoGain);
        lfoGain.connect(osc.frequency);
        lfo.start();
        
        gain.gain.value = 0;
        
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.masterGain);
        
        return {
            oscillator: osc,
            gainNode: gain,
            filter: filter,
            lfo: lfo,
            baseVolume: baseVolume,
            start: () => osc.start(),
            stop: () => { osc.stop(); lfo.stop(); }
        };
    }
    
    /**
     * Update audio based on sound parameters from reduction pipeline.
     * @param {Object} params - Sound parameters
     */
    update(params) {
        if (!this.initialized || this.muted) return;
        
        // Update target volumes for continuous loops
        this.targetVolumes.mining = params.miningVolume || 0;
        this.targetVolumes.combat = params.combatVolume || 0;
        this.targetVolumes.factory = params.factoryHum || 0;
        this.targetVolumes.swarm = params.swarmVolume || 0;
        this.targetVolumes.ambient = 0.3 + (params.ambientIntensity || 0) * 0.3;
        
        // Smoothly transition loop volumes
        this.smoothUpdateLoops();
        
        // Handle one-shot triggers
        if (params.spawnRate > 0.5) {
            this.tryPlayOneShot('spawn', params.spawnRate);
        }
        if (params.explosionRate > 0.5) {
            this.tryPlayOneShot('explosion', params.explosionRate);
        }
    }
    
    /**
     * Smoothly update loop volumes
     */
    smoothUpdateLoops() {
        const now = this.audioContext.currentTime;
        const rampTime = 0.05;  // 50ms ramp
        
        for (const [name, loop] of Object.entries(this.loops)) {
            if (!loop || !loop.gainNode) continue;
            
            const target = this.targetVolumes[name] * loop.baseVolume;
            loop.gainNode.gain.linearRampToValueAtTime(target, now + rampTime);
        }
    }
    
    /**
     * Try to play a one-shot sound with rate limiting
     */
    tryPlayOneShot(type, intensity) {
        const pool = this.oneShotPools[type];
        if (!pool) return;
        
        const now = Date.now();
        if (now - pool.lastPlayed < pool.cooldown) return;
        
        // Count active voices
        const activeVoices = pool.sounds.filter(s => s.playing).length;
        if (activeVoices >= pool.maxVoices) return;
        
        // Play the one-shot
        this.playGeneratedOneShot(type, Math.min(1, intensity / 3));
        pool.lastPlayed = now;
    }
    
    /**
     * Play a generated one-shot sound
     */
    playGeneratedOneShot(type, volume) {
        if (!this.audioContext) return;
        
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        const filter = this.audioContext.createBiquadFilter();
        
        if (type === 'spawn') {
            // Rising tone
            osc.type = 'sine';
            osc.frequency.value = 400;
            osc.frequency.linearRampToValueAtTime(800, this.audioContext.currentTime + 0.1);
            filter.type = 'lowpass';
            filter.frequency.value = 2000;
            gain.gain.value = volume * 0.2;
            gain.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.15);
        } else if (type === 'explosion') {
            // Noise burst
            osc.type = 'sawtooth';
            osc.frequency.value = 80;
            filter.type = 'lowpass';
            filter.frequency.value = 400;
            filter.frequency.linearRampToValueAtTime(100, this.audioContext.currentTime + 0.3);
            gain.gain.value = volume * 0.3;
            gain.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.4);
        }
        
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.masterGain);
        
        osc.start();
        osc.stop(this.audioContext.currentTime + 0.5);
    }
    
    /**
     * Resume audio context (required after user gesture)
     */
    async resume() {
        if (this.audioContext && this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
            console.log('[AudioEngine] Resumed');
        }
    }
    
    /**
     * Set master volume
     */
    setMasterVolume(volume) {
        if (this.masterGain) {
            this.masterGain.gain.value = Math.max(0, Math.min(1, volume));
        }
    }
    
    /**
     * Mute/unmute all audio
     */
    setMuted(muted) {
        this.muted = muted;
        if (this.masterGain) {
            this.masterGain.gain.value = muted ? 0 : 0.5;
        }
    }
    
    /**
     * Toggle mute state
     */
    toggleMute() {
        this.setMuted(!this.muted);
        return this.muted;
    }
    
    /**
     * Check if audio is ready
     */
    isReady() {
        return this.initialized && this.audioContext && this.audioContext.state === 'running';
    }
    
    /**
     * Clean up audio resources
     */
    destroy() {
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        this.initialized = false;
    }
}

