import { GPU } from '../gpu/GPU.js';
import { ComputeShader } from '../gpu/ComputeShader.js';
import { DataTexture } from '../gpu/DataTexture.js';
import { Framebuffer } from '../gpu/Framebuffer.js';
import { loadShader } from '../shaders/load.js';

/**
 * AudioReductionPipeline - GPU-based reduction for audio event detection
 * 
 * Reduces the 256x256 game state down to 2x1 sound parameters through
 * a series of reduction shaders, with temporal comparison to detect changes.
 * 
 * Pipeline:
 *   256x256 game state → 16x16 (counts) → 4x4 (with deltas) → 2x1 (sound params)
 */
export class AudioReductionPipeline {
    /**
     * @param {number} gameSize - Game grid size (e.g., 256)
     * @param {number} compareDistance - Frames to compare for deltas (default: 4)
     */
    constructor(gameSize = 256, compareDistance = 4) {
        this.gameSize = gameSize;
        this.compareDistance = compareDistance;
        this.frameCount = 0;
        this.initialized = false;
        
        // Reduction sizes
        this.size16 = 16;
        this.size4 = 4;
        this.size2x1 = { width: 2, height: 1 };
        
        // Will be initialized in init()
        this.reduce256to16Shader = null;
        this.reduce16to4Shader = null;
        this.reduce4to2x1Shader = null;
        
        // Ring buffers for temporal comparison (16x16 textures)
        // We need two textures per frame: pass0 (units/resources) and pass1 (factories)
        this.ringBuffer16 = [];      // Pass 0 outputs
        this.ringBuffer16Fac = [];   // Pass 1 outputs
        this.ringBufferFB16 = [];
        this.ringBufferFB16Fac = [];
        
        // Intermediate textures
        this.texture4 = null;
        this.fb4 = null;
        this.texture2x1 = null;
        this.fb2x1 = null;
        
        // Current 16x16 textures (written before going into ring buffer)
        this.currentTexture16 = null;
        this.currentTexture16Fac = null;
        this.currentFB16 = null;
        this.currentFB16Fac = null;
        
        // Output data (read back to CPU)
        this.soundParams = new Float32Array(8);  // 2 pixels * 4 channels
    }
    
    /**
     * Initialize shaders and textures. Call after GPU is ready.
     */
    async init() {
        const gpu = GPU.get();
        
        // Load and compile shaders
        const [reduce256to16Src, reduce16to4Src, reduce4to2x1Src] = await Promise.all([
            loadShader('./src/shaders/audio/reduce_256to16.frag.glsl'),
            loadShader('./src/shaders/audio/reduce_16to4.frag.glsl'),
            loadShader('./src/shaders/audio/reduce_4to2x1.frag.glsl')
        ]);
        
        this.reduce256to16Shader = new ComputeShader(reduce256to16Src);
        this.reduce16to4Shader = new ComputeShader(reduce16to4Src);
        this.reduce4to2x1Shader = new ComputeShader(reduce4to2x1Src);
        
        // Create ring buffer textures (16x16)
        for (let i = 0; i < this.compareDistance; i++) {
            const tex = new DataTexture(this.size16, this.size16, { format: 'float' });
            const texFac = new DataTexture(this.size16, this.size16, { format: 'float' });
            this.ringBuffer16.push(tex);
            this.ringBuffer16Fac.push(texFac);
            this.ringBufferFB16.push(new Framebuffer(tex));
            this.ringBufferFB16Fac.push(new Framebuffer(texFac));
        }
        
        // Current frame textures (before adding to ring buffer)
        this.currentTexture16 = new DataTexture(this.size16, this.size16, { format: 'float' });
        this.currentTexture16Fac = new DataTexture(this.size16, this.size16, { format: 'float' });
        this.currentFB16 = new Framebuffer(this.currentTexture16);
        this.currentFB16Fac = new Framebuffer(this.currentTexture16Fac);
        
        // Intermediate 4x4 texture
        this.texture4 = new DataTexture(this.size4, this.size4, { format: 'float' });
        this.fb4 = new Framebuffer(this.texture4);
        
        // Final 2x1 output texture
        this.texture2x1 = new DataTexture(this.size2x1.width, this.size2x1.height, { format: 'float' });
        this.fb2x1 = new Framebuffer(this.texture2x1);
        
        this.initialized = true;
        console.log('[AudioReductionPipeline] Initialized');
    }
    
    /**
     * Run the reduction pipeline on the current game state.
     * @param {DataTexture} gameStateTexture - The 256x256 game state
     * @returns {Float32Array} - 8 floats: [miningVol, combatVol, factoryHum, swarmVol, spawnRate, explosionRate, ambient, reserved]
     */
    run(gameStateTexture) {
        if (!this.initialized) {
            console.warn('[AudioReductionPipeline] Not initialized, skipping');
            return this.soundParams;
        }
        
        const gpu = GPU.get();
        const gl = gpu.gl;
        
        // Calculate ring buffer indices
        const currentSlot = this.frameCount % this.compareDistance;
        const previousSlot = (this.frameCount - this.compareDistance + this.compareDistance * 2) % this.compareDistance;
        
        // ====================================================================
        // Stage 1a: 256x256 → 16x16 (Pass 0: units, resources, combat)
        // ====================================================================
        this.currentFB16.bind();
        this.reduce256to16Shader.use();
        this.reduce256to16Shader.setTexture('u_state', gameStateTexture, 0);
        this.reduce256to16Shader.setVec2('u_inputResolution', this.gameSize, this.gameSize);
        this.reduce256to16Shader.setVec2('u_outputResolution', this.size16, this.size16);
        this.reduce256to16Shader.setInt('u_pass', 0);
        this.reduce256to16Shader.dispatch();
        
        // ====================================================================
        // Stage 1b: 256x256 → 16x16 (Pass 1: factories)
        // ====================================================================
        this.currentFB16Fac.bind();
        this.reduce256to16Shader.use();
        this.reduce256to16Shader.setTexture('u_state', gameStateTexture, 0);
        this.reduce256to16Shader.setVec2('u_inputResolution', this.gameSize, this.gameSize);
        this.reduce256to16Shader.setVec2('u_outputResolution', this.size16, this.size16);
        this.reduce256to16Shader.setInt('u_pass', 1);
        this.reduce256to16Shader.dispatch();
        
        // ====================================================================
        // Stage 2: 16x16 → 4x4 (with temporal deltas)
        // ====================================================================
        // Get previous frame data from ring buffer
        const prevTexture = this.ringBuffer16[previousSlot];
        const prevTextureFac = this.ringBuffer16Fac[previousSlot];
        
        this.fb4.bind();
        this.reduce16to4Shader.use();
        this.reduce16to4Shader.setTexture('u_current', this.currentTexture16, 0);
        this.reduce16to4Shader.setTexture('u_previous', prevTexture, 1);
        this.reduce16to4Shader.setTexture('u_currentFac', this.currentTexture16Fac, 2);
        this.reduce16to4Shader.setTexture('u_previousFac', prevTextureFac, 3);
        this.reduce16to4Shader.setVec2('u_inputResolution', this.size16, this.size16);
        this.reduce16to4Shader.setVec2('u_outputResolution', this.size4, this.size4);
        this.reduce16to4Shader.dispatch();
        
        // ====================================================================
        // Stage 3: 4x4 → 2x1 (final sound parameters)
        // ====================================================================
        this.fb2x1.bind();
        this.reduce4to2x1Shader.use();
        this.reduce4to2x1Shader.setTexture('u_deltas', this.texture4, 0);
        this.reduce4to2x1Shader.setTexture('u_currentFac', this.currentTexture16Fac, 1);
        this.reduce4to2x1Shader.setVec2('u_inputResolution', this.size4, this.size4);
        this.reduce4to2x1Shader.setVec2('u_facResolution', this.size16, this.size16);
        this.reduce4to2x1Shader.dispatch();
        
        // ====================================================================
        // Copy current frame to ring buffer slot
        // ====================================================================
        this.copyTexture(this.currentTexture16, this.ringBuffer16[currentSlot], this.size16);
        this.copyTexture(this.currentTexture16Fac, this.ringBuffer16Fac[currentSlot], this.size16);
        
        // ====================================================================
        // Read back final 2x1 texture (only 2 pixels = 8 floats)
        // ====================================================================
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb2x1.framebuffer);
        gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, this.soundParams);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        
        // Restore viewport
        gl.viewport(0, 0, gpu.canvas.width, gpu.canvas.height);
        
        this.frameCount++;
        
        return this.soundParams;
    }
    
    /**
     * Copy one texture to another using a simple blit.
     */
    copyTexture(src, dst, size) {
        const gpu = GPU.get();
        const gl = gpu.gl;
        
        // Read from source
        const data = new Float32Array(size * size * 4);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.getFramebufferFor(src).framebuffer);
        gl.readPixels(0, 0, size, size, gl.RGBA, gl.FLOAT, data);
        
        // Write to destination
        dst.upload(data);
        
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    }
    
    /**
     * Get framebuffer for a texture (helper)
     */
    getFramebufferFor(texture) {
        if (texture === this.currentTexture16) return this.currentFB16;
        if (texture === this.currentTexture16Fac) return this.currentFB16Fac;
        
        const idx = this.ringBuffer16.indexOf(texture);
        if (idx >= 0) return this.ringBufferFB16[idx];
        
        const idxFac = this.ringBuffer16Fac.indexOf(texture);
        if (idxFac >= 0) return this.ringBufferFB16Fac[idxFac];
        
        throw new Error('Unknown texture');
    }
    
    /**
     * Get sound parameters as a structured object.
     */
    getSoundParams() {
        return {
            // Continuous loops (0-1)
            miningVolume: this.soundParams[0],
            combatVolume: this.soundParams[1],
            factoryHum: this.soundParams[2],
            swarmVolume: this.soundParams[3],
            
            // Triggers
            spawnRate: this.soundParams[4],
            explosionRate: this.soundParams[5],
            ambientIntensity: this.soundParams[6],
            reserved: this.soundParams[7]
        };
    }
    
    /**
     * Clean up GPU resources.
     */
    destroy() {
        if (this.reduce256to16Shader) this.reduce256to16Shader.destroy();
        if (this.reduce16to4Shader) this.reduce16to4Shader.destroy();
        if (this.reduce4to2x1Shader) this.reduce4to2x1Shader.destroy();
        
        for (let i = 0; i < this.compareDistance; i++) {
            this.ringBuffer16[i].destroy();
            this.ringBuffer16Fac[i].destroy();
            this.ringBufferFB16[i].destroy();
            this.ringBufferFB16Fac[i].destroy();
        }
        
        if (this.currentTexture16) this.currentTexture16.destroy();
        if (this.currentTexture16Fac) this.currentTexture16Fac.destroy();
        if (this.currentFB16) this.currentFB16.destroy();
        if (this.currentFB16Fac) this.currentFB16Fac.destroy();
        
        if (this.texture4) this.texture4.destroy();
        if (this.fb4) this.fb4.destroy();
        if (this.texture2x1) this.texture2x1.destroy();
        if (this.fb2x1) this.fb2x1.destroy();
        
        this.initialized = false;
    }
}

