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
 * Also runs Jump Flooding Algorithm (JFA) for accurate island detection.
 * 
 * Pipeline:
 *   256x256 game state → 16x16 (counts) → 4x4 (with deltas) → 2x1 (sound params)
 *   256x256 game state → JFA (8 passes) → count islands → detect depletion
 */
export class AudioReductionPipeline {
    /**
     * @param {number} gameSize - Game grid size (e.g., 256)
     * @param {number} compareDistance - Frames to compare for deltas (default: 4)
     * @param {number} jfaPasses - Number of JFA passes (default: 8 for 256x256)
     */
    constructor(gameSize = 256, compareDistance = 4, jfaPasses = 8) {
        this.gameSize = gameSize;
        this.compareDistance = compareDistance;
        this.jfaPasses = jfaPasses;  // Configurable JFA passes
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
        
        // JFA shaders
        this.jfaInitShader = null;
        this.jfaStepShader = null;
        this.jfaCountShader = null;
        
        // JFA textures (ping-pong for step iterations)
        this.jfaTexA = null;
        this.jfaTexB = null;
        this.jfaFbA = null;
        this.jfaFbB = null;
        
        // Island count tracking
        this.jfaCountTex16 = null;
        this.jfaCountFb16 = null;
        this.jfaCountTex1 = null;
        this.jfaCountFb1 = null;
        this.prevIslandCount = 0;
        this.islandDepletion = 0;  // Set when island count decreases
        
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
        
        // Load and compile shaders (including JFA)
        const [
            reduce256to16Src, reduce16to4Src, reduce4to2x1Src,
            jfaInitSrc, jfaStepSrc, jfaCountSrc
        ] = await Promise.all([
            loadShader('./src/shaders/audio/reduce_256to16.frag.glsl'),
            loadShader('./src/shaders/audio/reduce_16to4.frag.glsl'),
            loadShader('./src/shaders/audio/reduce_4to2x1.frag.glsl'),
            loadShader('./src/shaders/audio/jfa_init.frag.glsl'),
            loadShader('./src/shaders/audio/jfa_step.frag.glsl'),
            loadShader('./src/shaders/audio/jfa_count.frag.glsl')
        ]);
        
        this.reduce256to16Shader = new ComputeShader(reduce256to16Src);
        this.reduce16to4Shader = new ComputeShader(reduce16to4Src);
        this.reduce4to2x1Shader = new ComputeShader(reduce4to2x1Src);
        this.jfaInitShader = new ComputeShader(jfaInitSrc);
        this.jfaStepShader = new ComputeShader(jfaStepSrc);
        this.jfaCountShader = new ComputeShader(jfaCountSrc);
        
        // Wait for all shaders to compile in parallel
        await Promise.all([
            this.reduce256to16Shader.waitReady(),
            this.reduce16to4Shader.waitReady(),
            this.reduce4to2x1Shader.waitReady(),
            this.jfaInitShader.waitReady(),
            this.jfaStepShader.waitReady(),
            this.jfaCountShader.waitReady()
        ]);
        
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
        
        // JFA ping-pong textures (full resolution for accurate labels)
        this.jfaTexA = new DataTexture(this.gameSize, this.gameSize, { format: 'float' });
        this.jfaTexB = new DataTexture(this.gameSize, this.gameSize, { format: 'float' });
        this.jfaFbA = new Framebuffer(this.jfaTexA);
        this.jfaFbB = new Framebuffer(this.jfaTexB);
        
        // JFA island count reduction textures
        this.jfaCountTex16 = new DataTexture(this.size16, this.size16, { format: 'float' });
        this.jfaCountFb16 = new Framebuffer(this.jfaCountTex16);
        this.jfaCountTex1 = new DataTexture(1, 1, { format: 'float' });
        this.jfaCountFb1 = new Framebuffer(this.jfaCountTex1);
        
        this.initialized = true;
        console.log(`[AudioReductionPipeline] Initialized with ${this.jfaPasses} JFA passes`);
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
        
        // ====================================================================
        // JFA: Jump Flooding Algorithm for accurate island detection
        // ====================================================================
        this.runJFA(gameStateTexture);
        
        // Restore viewport
        gl.viewport(0, 0, gpu.canvas.width, gpu.canvas.height);
        
        this.frameCount++;
        
        return this.soundParams;
    }
    
    /**
     * Run Jump Flooding Algorithm to count resource islands.
     * Detects when island count decreases (a blob was fully depleted).
     */
    runJFA(gameStateTexture) {
        const gpu = GPU.get();
        const gl = gpu.gl;
        
        // Step 1: Initialize - each resource cell gets its own coords as label
        this.jfaFbA.bind();
        this.jfaInitShader.use();
        this.jfaInitShader.setTexture('u_state', gameStateTexture, 0);
        this.jfaInitShader.setVec2('u_resolution', this.gameSize, this.gameSize);
        this.jfaInitShader.dispatch();
        
        // Step 2: JFA propagation passes (ping-pong between A and B)
        let readTex = this.jfaTexA;
        let writeFb = this.jfaFbB;
        let writeTex = this.jfaTexB;
        
        for (let i = 0; i < this.jfaPasses; i++) {
            // Step size: starts at gameSize/2, halves each pass
            const stepSize = Math.floor(this.gameSize / Math.pow(2, i + 1));
            if (stepSize < 1) break;
            
            writeFb.bind();
            this.jfaStepShader.use();
            this.jfaStepShader.setTexture('u_labels', readTex, 0);
            this.jfaStepShader.setVec2('u_resolution', this.gameSize, this.gameSize);
            this.jfaStepShader.setFloat('u_stepSize', stepSize);
            this.jfaStepShader.dispatch();
            
            // Swap ping-pong
            [readTex, writeTex] = [writeTex, readTex];
            writeFb = (writeFb === this.jfaFbA) ? this.jfaFbB : this.jfaFbA;
        }
        
        // After all passes, readTex contains the final labels
        const finalLabelsTex = readTex;
        
        // Step 3: Count island roots (cells where label == position)
        // Stage 1: 256x256 → 16x16
        this.jfaCountFb16.bind();
        this.jfaCountShader.use();
        this.jfaCountShader.setTexture('u_labels', finalLabelsTex, 0);
        this.jfaCountShader.setVec2('u_inputResolution', this.gameSize, this.gameSize);
        this.jfaCountShader.setVec2('u_outputResolution', this.size16, this.size16);
        this.jfaCountShader.setInt('u_stage', 0);
        this.jfaCountShader.dispatch();
        
        // Stage 2: 16x16 → 1x1
        this.jfaCountFb1.bind();
        this.jfaCountShader.use();
        this.jfaCountShader.setTexture('u_labels', this.jfaCountTex16, 0);
        this.jfaCountShader.setVec2('u_inputResolution', this.size16, this.size16);
        this.jfaCountShader.setVec2('u_outputResolution', 1, 1);
        this.jfaCountShader.setInt('u_stage', 1);
        this.jfaCountShader.dispatch();
        
        // Read back island count (just 1 pixel = 4 floats, we only need R)
        const countData = new Float32Array(4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.jfaCountFb1.framebuffer);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, countData);
        
        const currentIslandCount = Math.round(countData[0]);
        
        // Detect depletion: island count decreased
        if (this.prevIslandCount > 0 && currentIslandCount < this.prevIslandCount) {
            const depleted = this.prevIslandCount - currentIslandCount;
            this.islandDepletion = depleted;
            console.log(`[JFA] Island depleted! ${this.prevIslandCount} → ${currentIslandCount} (${depleted} islands cleared)`);
        } else {
            this.islandDepletion = 0;
        }
        
        this.prevIslandCount = currentIslandCount;
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
            depletionRate: this.soundParams[7],  // Heuristic-based depletion
            
            // JFA-based accurate island depletion
            islandDepletion: this.islandDepletion
        };
    }
    
    /**
     * Clean up GPU resources.
     */
    destroy() {
        if (this.reduce256to16Shader) this.reduce256to16Shader.destroy();
        if (this.reduce16to4Shader) this.reduce16to4Shader.destroy();
        if (this.reduce4to2x1Shader) this.reduce4to2x1Shader.destroy();
        if (this.jfaInitShader) this.jfaInitShader.destroy();
        if (this.jfaStepShader) this.jfaStepShader.destroy();
        if (this.jfaCountShader) this.jfaCountShader.destroy();
        
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
        
        // JFA textures
        if (this.jfaTexA) this.jfaTexA.destroy();
        if (this.jfaTexB) this.jfaTexB.destroy();
        if (this.jfaFbA) this.jfaFbA.destroy();
        if (this.jfaFbB) this.jfaFbB.destroy();
        if (this.jfaCountTex16) this.jfaCountTex16.destroy();
        if (this.jfaCountFb16) this.jfaCountFb16.destroy();
        if (this.jfaCountTex1) this.jfaCountTex1.destroy();
        if (this.jfaCountFb1) this.jfaCountFb1.destroy();
        
        this.initialized = false;
    }
}

