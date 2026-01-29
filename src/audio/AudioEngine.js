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
            explosion: { sounds: [], maxVoices: 2, lastPlayed: 0, cooldown: 200 },
            depletion: { sounds: [], maxVoices: 2, lastPlayed: 0, cooldown: 300 },  // Resource blob depleted
            missileArmed: { sounds: [], maxVoices: 1, lastPlayed: 0, cooldown: 500 },
            missileExplosion: { sounds: [], maxVoices: 2, lastPlayed: 0, cooldown: 100 }
        };
        
        // Missile moving loop (separate from main loops - manually controlled)
        this.missileLoop = null;
        this.missileLoopActive = false;
        
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
            // console.log('[AudioEngine] Initialized');
            
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
        // Ambient: Subtle base drone (always-on foundation)
        this.loops.ambient = this.createDroneLoop(55, 'sine', 0.08);  // Very subtle A1
        
        // Mining: Crystalline shimmer (very quiet to prevent constant noise)
        this.loops.mining = this.createShimmerLoop(880, 0.02);  // High A, very quiet
        
        // Combat: Aggressive pulse (reduced)
        this.loops.combat = this.createPulseLoop(110, 0.05);  // Low, quieter
        
        // Factory: Subtle hum - only plays when there's activity
        // Much quieter to avoid annoying drone
        this.loops.factory = this.createWarpCoreHum(0.06);
        
        // Swarm: Buzzing (reduced)
        this.loops.swarm = this.createBuzzLoop(220, 0.03);
        
        // Start all loops (but with zero volume)
        Object.values(this.loops).forEach(loop => {
            if (loop && loop.start) {
                loop.gainNode.gain.value = 0;
                loop.start();
            }
        });
        
        // Create missile moving loop (starts silent, activated on demand)
        this.missileLoop = this.createMissileMovingLoop();
        this.missileLoop.gainNode.gain.value = 0;
        this.missileLoop.start();
    }
    
    /**
     * Create an ominous missile moving sound - low rumbling with ascending pitch
     */
    createMissileMovingLoop() {
        const osc1 = this.audioContext.createOscillator();
        const osc2 = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        const filter = this.audioContext.createBiquadFilter();
        
        // Low ominous rumble
        osc1.type = 'sawtooth';
        osc1.frequency.value = 40;
        
        // Higher harmonic for menace
        osc2.type = 'square';
        osc2.frequency.value = 80;
        
        // Pulsing LFO for drama
        const lfo = this.audioContext.createOscillator();
        const lfoGain = this.audioContext.createGain();
        lfo.type = 'sine';
        lfo.frequency.value = 2;  // Slow throb
        lfoGain.gain.value = 15;
        lfo.connect(lfoGain);
        lfoGain.connect(osc1.frequency);
        lfoGain.connect(osc2.frequency);
        lfo.start();
        
        // Rumbling filter
        filter.type = 'lowpass';
        filter.frequency.value = 200;
        filter.Q.value = 3;
        
        gain.gain.value = 0;
        
        const osc1Gain = this.audioContext.createGain();
        const osc2Gain = this.audioContext.createGain();
        osc1Gain.gain.value = 0.5;
        osc2Gain.gain.value = 0.3;
        
        osc1.connect(osc1Gain);
        osc2.connect(osc2Gain);
        osc1Gain.connect(filter);
        osc2Gain.connect(filter);
        filter.connect(gain);
        gain.connect(this.masterGain);
        
        return {
            oscillators: [osc1, osc2],
            gainNode: gain,
            filter: filter,
            lfo: lfo,
            baseVolume: 0.25,
            start: () => { osc1.start(); osc2.start(); },
            stop: () => { osc1.stop(); osc2.stop(); lfo.stop(); }
        };
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
     * Create a subtle, non-annoying factory hum
     * Key changes from previous version:
     * - Much quieter base volume
     * - Softer waveforms (sine instead of sawtooth)
     * - Multiple LFOs at irrational ratios (never repeats exactly)
     * - Random "breathing" variations
     * - Lower frequencies for less fatiguing sound
     */
    createWarpCoreHum(baseVolume) {
        const audioContext = this.audioContext;
        
        // Use softer sine waves instead of harsh sawtooth
        const osc1 = audioContext.createOscillator();
        const osc2 = audioContext.createOscillator();
        
        // Lower frequencies, sine waves for gentleness
        osc1.type = 'sine';
        osc1.frequency.value = 55;  // Low A, below typical hearing focus
        
        osc2.type = 'sine';
        osc2.frequency.value = 82.5;  // Perfect fifth above (harmonic)
        
        // Multiple LFOs at irrational ratios - never repeats exactly
        // This prevents the "stuck in a pattern" feeling
        const pitchLFO1 = audioContext.createOscillator();
        const pitchLFO2 = audioContext.createOscillator();
        const pitchLFOGain = audioContext.createGain();
        
        pitchLFO1.type = 'sine';
        pitchLFO1.frequency.value = 0.13;  // Very slow
        pitchLFO2.type = 'sine';
        pitchLFO2.frequency.value = 0.089;  // Irrational ratio to first
        pitchLFOGain.gain.value = 1.5;  // Subtle pitch variation
        
        pitchLFO1.connect(pitchLFOGain);
        pitchLFO2.connect(pitchLFOGain);
        pitchLFOGain.connect(osc1.frequency);
        pitchLFOGain.connect(osc2.frequency);
        
        // Amplitude modulation with multiple irrational-ratio LFOs
        const ampLFO1 = audioContext.createOscillator();
        const ampLFO2 = audioContext.createOscillator();
        const ampLFO3 = audioContext.createOscillator();
        const ampMixer = audioContext.createGain();
        const pulseGain = audioContext.createGain();
        
        ampLFO1.type = 'sine';
        ampLFO1.frequency.value = 0.7;   // Base pulse
        ampLFO2.type = 'sine';
        ampLFO2.frequency.value = 0.31;  // Slower "breathing"
        ampLFO3.type = 'sine';  
        ampLFO3.frequency.value = 0.071; // Very slow swell (14 second cycle)
        
        const amp1Gain = audioContext.createGain();
        const amp2Gain = audioContext.createGain();
        const amp3Gain = audioContext.createGain();
        amp1Gain.gain.value = 0.1;   // Subtle fast pulse
        amp2Gain.gain.value = 0.15;  // Medium breathing
        amp3Gain.gain.value = 0.2;   // Larger slow swells
        
        ampLFO1.connect(amp1Gain);
        ampLFO2.connect(amp2Gain);
        ampLFO3.connect(amp3Gain);
        amp1Gain.connect(pulseGain.gain);
        amp2Gain.connect(pulseGain.gain);
        amp3Gain.connect(pulseGain.gain);
        pulseGain.gain.value = 0.55;  // Base level (will vary 0.1 to 1.0)
        
        // Mix oscillators with lower volume
        const oscMixer = audioContext.createGain();
        oscMixer.gain.value = 0.3;  // Much quieter overall
        
        const osc1Gain = audioContext.createGain();
        const osc2Gain = audioContext.createGain();
        osc1Gain.gain.value = 0.6;
        osc2Gain.gain.value = 0.4;
        
        osc1.connect(osc1Gain);
        osc2.connect(osc2Gain);
        osc1Gain.connect(oscMixer);
        osc2Gain.connect(oscMixer);
        
        // Gentle lowpass filter
        const filter = audioContext.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 150;  // Very dark, muffled
        filter.Q.value = 0.7;  // No resonance peak
        
        // Final output gain
        const outputGain = audioContext.createGain();
        outputGain.gain.value = 0;
        
        // Signal chain
        oscMixer.connect(filter);
        filter.connect(pulseGain);
        pulseGain.connect(outputGain);
        outputGain.connect(this.masterGain);
        
        // Start LFOs
        pitchLFO1.start();
        pitchLFO2.start();
        ampLFO1.start();
        ampLFO2.start();
        ampLFO3.start();
        
        return {
            oscillators: [osc1, osc2],
            gainNode: outputGain,
            filter: filter,
            pitchLFOs: [pitchLFO1, pitchLFO2],
            ampLFOs: [ampLFO1, ampLFO2, ampLFO3],
            baseVolume: baseVolume * 0.5,  // Reduce base volume by half
            start: () => {
                osc1.start();
                osc2.start();
            },
            stop: () => {
                osc1.stop();
                osc2.stop();
                pitchLFO1.stop();
                pitchLFO2.stop();
                ampLFO1.stop();
                ampLFO2.stop();
                ampLFO3.stop();
            },
            // Method to modulate filter based on activity
            setActivity: (level) => {
                // Cap the level to prevent overwhelming sound
                const cappedLevel = Math.min(level, 0.6);
                // Higher activity = slightly brighter, but stay muffled
                const targetFreq = 120 + cappedLevel * 180;  // 120-228 Hz (very muted range)
                filter.frequency.linearRampToValueAtTime(
                    targetFreq, 
                    audioContext.currentTime + 0.3  // Slower transition
                );
            }
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
        
        // === TEMPORARY DEBUG: Log raw params every 60 frames ===
        this.debugFrameCount = (this.debugFrameCount || 0) + 1;
        if (this.debugFrameCount % 60 === 0) {
            // console.log(
            //     "[Audio] Params: mining",
            //     params.miningVolume !== undefined ? Math.floor(params.miningVolume * 1000) / 1000 : undefined,
            //     ", combat",
            //     params.combatVolume !== undefined ? Math.floor(params.combatVolume * 1000) / 1000 : undefined,
            //     ", factory",
            //     params.factoryHum !== undefined ? Math.floor(params.factoryHum * 1000) / 1000 : undefined,
            //     ", swarm",
            //     params.swarmVolume !== undefined ? Math.floor(params.swarmVolume * 1000) / 1000 : undefined,
            //     ", spawn",
            //     params.spawnRate !== undefined ? Math.floor(params.spawnRate * 100) / 100 : undefined,
            //     ", explosion",
            //     params.explosionRate !== undefined ? Math.floor(params.explosionRate * 100) / 100 : undefined,
            //     ", depletion",
            //     params.depletionRate !== undefined ? Math.floor(params.depletionRate * 100) / 100 : undefined,
            //     ", islands",
            //     params.islandDepletion !== undefined ? params.islandDepletion : 0
            // );
        }
        // === END TEMPORARY DEBUG ===
        
        // Update target volumes for continuous loops
        // Mining: very aggressive reduction to prevent constant noise
        const rawMining = params.miningVolume || 0;
        this.targetVolumes.mining = rawMining > 0.3 ? rawMining * 0.15 : 0;  // Much higher threshold, much lower volume
        
        this.targetVolumes.combat = params.combatVolume || 0;
        this.targetVolumes.factory = params.factoryHum || 0;
        this.targetVolumes.swarm = params.swarmVolume || 0;
        this.targetVolumes.ambient = 0.3 + (params.ambientIntensity || 0) * 0.3;
        
        // === TEMPORARY LOGGING (except mining - too frequent) ===
        if (this.targetVolumes.combat > 0.05) {
            // console.log(`[Audio] Combat: ${this.targetVolumes.combat.toFixed(2)}`);
        }
        if (this.targetVolumes.factory > 0.05) {
            // // console.log(`[Audio] Factory hum: ${this.targetVolumes.factory.toFixed(2)}`);
        }
        if (this.targetVolumes.swarm > 0.05) {
            // console.log(`[Audio] Swarm: ${this.targetVolumes.swarm.toFixed(2)}`);
        }
        // === END TEMPORARY LOGGING ===
        
        // Smoothly transition loop volumes
        this.smoothUpdateLoops();
        
        // Handle one-shot triggers
        if (params.spawnRate > 0.5) {
            // console.log(`[Audio] Spawn triggered: rate=${params.spawnRate.toFixed(2)}`);
            this.tryPlayOneShot('spawn', params.spawnRate);
        }
        if (params.explosionRate > 0.5) {
            // console.log(`[Audio] Explosion triggered: rate=${params.explosionRate.toFixed(2)}`);
            this.tryPlayOneShot('explosion', params.explosionRate);
        }
        // Resource depletion detection disabled - was triggering too often
        // and never worked reliably with moving resources
        // if (params.islandDepletion > 0) {
        //     this.tryPlayOneShot('depletion', params.islandDepletion);
        // }
        // else if (params.depletionRate > 0.3) {
        //     this.tryPlayOneShot('depletion', params.depletionRate);
        // }
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
            
            // Special handling for factory warp-core hum: modulate filter based on activity
            if (name === 'factory' && loop.setActivity) {
                loop.setActivity(this.targetVolumes.factory);
            }
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
            // Soft "pop" or "blip" - gentle birth sound
            osc.type = 'sine';
            // Start high, quickly drop (like a bubble popping)
            osc.frequency.value = 600;
            osc.frequency.exponentialRampToValueAtTime(200, this.audioContext.currentTime + 0.08);
            filter.type = 'lowpass';
            filter.frequency.value = 1200;
            filter.frequency.exponentialRampToValueAtTime(400, this.audioContext.currentTime + 0.1);
            // Quiet and quick
            gain.gain.value = volume * 0.08;
            gain.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + 0.12);
        } else if (type === 'depletion') {
            // Noisy decaying "woosh" - resonant filtered wind, something cleared away
            osc.type = 'sawtooth';  // Rich harmonics for noise-like quality
            // Start at mid frequency, sweep down
            osc.frequency.value = 400;
            osc.frequency.exponentialRampToValueAtTime(80, this.audioContext.currentTime + 0.5);
            
            // Resonant bandpass filter that sweeps down - creates "woosh" character
            filter.type = 'bandpass';
            filter.Q.value = 8;  // High resonance for that filtered wind sound
            filter.frequency.value = 1200;
            filter.frequency.exponentialRampToValueAtTime(150, this.audioContext.currentTime + 0.6);
            
            // Volume envelope: quick attack, slow decay
            gain.gain.value = volume * 0.15;
            gain.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + 0.7);
        } else if (type === 'explosion') {
            // Noise burst
            osc.type = 'sawtooth';
            osc.frequency.value = 80;
            filter.type = 'lowpass';
            filter.frequency.value = 400;
            filter.frequency.linearRampToValueAtTime(100, this.audioContext.currentTime + 0.3);
            gain.gain.value = volume * 0.3;
            gain.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.4);
        } else if (type === 'missileArmed') {
            // Dramatic power-up sound - rising pitch with resonance
            osc.type = 'sawtooth';
            osc.frequency.value = 100;
            osc.frequency.exponentialRampToValueAtTime(400, this.audioContext.currentTime + 0.5);
            osc.frequency.exponentialRampToValueAtTime(200, this.audioContext.currentTime + 0.8);
            filter.type = 'bandpass';
            filter.frequency.value = 300;
            filter.frequency.exponentialRampToValueAtTime(800, this.audioContext.currentTime + 0.5);
            filter.frequency.exponentialRampToValueAtTime(400, this.audioContext.currentTime + 0.8);
            filter.Q.value = 5;
            gain.gain.value = volume * 0.25;
            gain.gain.linearRampToValueAtTime(volume * 0.4, this.audioContext.currentTime + 0.4);
            gain.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + 1.0);
        } else if (type === 'missileExplosion') {
            // HUGE explosion - much bigger than normal
            osc.type = 'sawtooth';
            osc.frequency.value = 50;
            osc.frequency.exponentialRampToValueAtTime(20, this.audioContext.currentTime + 0.8);
            filter.type = 'lowpass';
            filter.frequency.value = 600;
            filter.frequency.linearRampToValueAtTime(80, this.audioContext.currentTime + 1.0);
            filter.Q.value = 2;
            // Much louder and longer than regular explosion
            gain.gain.value = volume * 0.6;
            gain.gain.linearRampToValueAtTime(volume * 0.3, this.audioContext.currentTime + 0.3);
            gain.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + 1.5);
        }
        
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.masterGain);
        
        // Determine sound duration
        let duration = 0.5;
        if (type === 'missileArmed') duration = 1.2;
        else if (type === 'missileExplosion') duration = 2.0;
        
        osc.start();
        osc.stop(this.audioContext.currentTime + duration);
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
     * Play a rejection/error sound (when action is blocked)
     */
    playReject() {
        if (!this.initialized || this.muted || !this.audioContext) return;
        
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        const now = this.audioContext.currentTime;
        
        // Quick descending buzz - sounds like "nope"
        osc.type = 'square';
        osc.frequency.value = 200;
        osc.frequency.exponentialRampToValueAtTime(100, now + 0.15);
        
        gain.gain.value = 0.15;
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        
        osc.connect(gain);
        gain.connect(this.masterGain);
        
        osc.start(now);
        osc.stop(now + 0.15);
    }
    
    /**
     * Play missile armed sound (when missile becomes ready to launch)
     */
    playMissileArmed() {
        if (!this.initialized || this.muted) return;
        this.playGeneratedOneShot('missileArmed', 1.0);
        console.log('[AudioEngine] Missile armed sound');
    }
    
    /**
     * Start missile moving loop (call when missile starts flying)
     */
    startMissileMoving() {
        if (!this.initialized || this.muted || !this.missileLoop) return;
        if (this.missileLoopActive) return;  // Already playing
        
        const now = this.audioContext.currentTime;
        this.missileLoop.gainNode.gain.cancelScheduledValues(now);
        this.missileLoop.gainNode.gain.setValueAtTime(0, now);
        this.missileLoop.gainNode.gain.linearRampToValueAtTime(this.missileLoop.baseVolume, now + 0.3);
        this.missileLoopActive = true;
        console.log('[AudioEngine] Missile moving loop started');
    }
    
    /**
     * Stop missile moving loop (call when missile explodes or is destroyed)
     */
    stopMissileMoving() {
        if (!this.initialized || !this.missileLoop) return;
        if (!this.missileLoopActive) return;  // Already stopped
        
        const now = this.audioContext.currentTime;
        this.missileLoop.gainNode.gain.cancelScheduledValues(now);
        this.missileLoop.gainNode.gain.linearRampToValueAtTime(0, now + 0.1);
        this.missileLoopActive = false;
        console.log('[AudioEngine] Missile moving loop stopped');
    }
    
    /**
     * Play missile explosion sound (big dramatic explosion)
     */
    playMissileExplosion() {
        if (!this.initialized || this.muted) return;
        this.stopMissileMoving();  // Stop moving sound first
        this.playGeneratedOneShot('missileExplosion', 1.0);
        console.log('[AudioEngine] Missile explosion sound');
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

