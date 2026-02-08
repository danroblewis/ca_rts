import { GPU } from '../gpu/GPU.js';
import { ComputePipeline } from '../gpu/ComputePipeline.js';
import { DataTexture } from '../gpu/DataTexture.js';
import { loadShader } from '../shaders/load.js';

/**
 * AudioReductionPipeline - GPU-based reduction for audio event detection
 *
 * Reduces the 256x256 game state down to 2x1 sound parameters through
 * a series of compute shaders, with temporal comparison to detect changes.
 *
 * Also runs Jump Flooding Algorithm (JFA) for accurate island detection.
 *
 * Pipeline:
 *   256x256 game state -> 16x16 (counts) -> 4x4 (with deltas) -> 2x1 (sound params)
 *   256x256 game state -> JFA (8 passes) -> count islands -> detect depletion
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
        this.jfaPasses = jfaPasses;
        this.frameCount = 0;
        this.initialized = false;

        // Reduction sizes
        this.size16 = 16;
        this.size4 = 4;
        this.size2x1 = { width: 2, height: 1 };

        // Shaders (ComputePipeline)
        this.reduce256to16Shader = null;
        this.reduce16to4Shader = null;
        this.reduce4to2x1Shader = null;
        this.jfaInitShader = null;
        this.jfaStepShader = null;
        this.jfaCountShader = null;

        // Uniform buffers for each shader stage
        this.reduce256to16Uniforms = null;
        this.reduce16to4Uniforms = null;
        this.reduce4to2x1Uniforms = null;
        this.jfaInitUniforms = null;
        this.jfaStepUniforms = null;
        this.jfaCountUniforms = null;

        // JFA textures (ping-pong for step iterations)
        this.jfaTexA = null;
        this.jfaTexB = null;

        // Island count tracking
        this.jfaCountTex16 = null;
        this.jfaCountTex1 = null;
        this.prevIslandCount = 0;
        this.islandDepletion = 0;

        // Ring buffers for temporal comparison (16x16 textures)
        this.ringBuffer16 = [];      // Pass 0 outputs
        this.ringBuffer16Fac = [];   // Pass 1 outputs

        // Intermediate textures
        this.texture4 = null;
        this.texture2x1 = null;

        // Current 16x16 textures (written before going into ring buffer)
        this.currentTexture16 = null;
        this.currentTexture16Fac = null;

        // Output data (read back to CPU)
        this.soundParams = new Float32Array(8);  // 2 pixels * 4 channels
    }

    /**
     * Initialize shaders and textures. Call after GPU is ready.
     */
    async init() {
        const gpu = GPU.get();

        // Load and compile WGSL compute shaders
        const [
            reduce256to16Src, reduce16to4Src, reduce4to2x1Src,
            jfaInitSrc, jfaStepSrc, jfaCountSrc
        ] = await Promise.all([
            loadShader('./src/shaders/audio/reduce_256to16.wgsl'),
            loadShader('./src/shaders/audio/reduce_16to4.wgsl'),
            loadShader('./src/shaders/audio/reduce_4to2x1.wgsl'),
            loadShader('./src/shaders/audio/jfa_init.wgsl'),
            loadShader('./src/shaders/audio/jfa_step.wgsl'),
            loadShader('./src/shaders/audio/jfa_count.wgsl')
        ]);

        this.reduce256to16Shader = new ComputePipeline(reduce256to16Src, { label: 'Reduce 256→16' });
        this.reduce16to4Shader = new ComputePipeline(reduce16to4Src, { label: 'Reduce 16→4' });
        this.reduce4to2x1Shader = new ComputePipeline(reduce4to2x1Src, { label: 'Reduce 4→2x1' });
        this.jfaInitShader = new ComputePipeline(jfaInitSrc, { label: 'JFA Init' });
        this.jfaStepShader = new ComputePipeline(jfaStepSrc, { label: 'JFA Step' });
        this.jfaCountShader = new ComputePipeline(jfaCountSrc, { label: 'JFA Count' });

        // Create sampler for texture sampling in compute shaders
        this.sampler = gpu.createSampler({
            magFilter: 'nearest',
            minFilter: 'nearest'
        });

        // Create uniform buffers
        // reduce_256to16: inputResolution(vec2f) + outputResolution(vec2f) + pass_index(i32) + pad(3) = 32 bytes
        this.reduce256to16Uniforms = gpu.createUniformBuffer(32, 'Reduce 256→16 params');
        // reduce_16to4: inputResolution(vec2f) + outputResolution(vec2f) = 16 bytes
        this.reduce16to4Uniforms = gpu.createUniformBuffer(16, 'Reduce 16→4 params');
        // reduce_4to2x1: inputResolution(vec2f) + outputResolution(vec2f) + facResolution(vec2f) = 32 bytes
        this.reduce4to2x1Uniforms = gpu.createUniformBuffer(32, 'Reduce 4→2x1 params');
        // jfa_init: resolution(vec2f) = 16 bytes (padded)
        this.jfaInitUniforms = gpu.createUniformBuffer(16, 'JFA Init params');
        // jfa_step: resolution(vec2f) + stepSize(f32) + pad = 16 bytes
        this.jfaStepUniforms = gpu.createUniformBuffer(16, 'JFA Step params');
        // jfa_count: inputResolution(vec2f) + outputResolution(vec2f) + stage(i32) + pad(3) = 32 bytes
        this.jfaCountUniforms = gpu.createUniformBuffer(32, 'JFA Count params');

        // Create ring buffer textures (16x16)
        for (let i = 0; i < this.compareDistance; i++) {
            this.ringBuffer16.push(new DataTexture(this.size16, this.size16, { format: 'float' }));
            this.ringBuffer16Fac.push(new DataTexture(this.size16, this.size16, { format: 'float' }));
        }

        // Current frame textures
        this.currentTexture16 = new DataTexture(this.size16, this.size16, { format: 'float' });
        this.currentTexture16Fac = new DataTexture(this.size16, this.size16, { format: 'float' });

        // Intermediate 4x4 texture
        this.texture4 = new DataTexture(this.size4, this.size4, { format: 'float' });

        // Final 2x1 output texture
        this.texture2x1 = new DataTexture(this.size2x1.width, this.size2x1.height, { format: 'float' });

        // JFA ping-pong textures
        this.jfaTexA = new DataTexture(this.gameSize, this.gameSize, { format: 'float' });
        this.jfaTexB = new DataTexture(this.gameSize, this.gameSize, { format: 'float' });

        // JFA island count reduction textures
        this.jfaCountTex16 = new DataTexture(this.size16, this.size16, { format: 'float' });
        this.jfaCountTex1 = new DataTexture(1, 1, { format: 'float' });

        this.initialized = true;
        console.log(`[AudioReductionPipeline] Initialized with ${this.jfaPasses} JFA passes`);
    }

    /**
     * Run the reduction pipeline on the current game state.
     * NOTE: Async because texture readback is async in WebGPU.
     * @param {DataTexture} gameStateTexture - The 256x256 game state
     * @returns {Promise<Float32Array>} 8 floats of sound parameters
     */
    async run(gameStateTexture) {
        if (!this.initialized) {
            console.warn('[AudioReductionPipeline] Not initialized, skipping');
            return this.soundParams;
        }

        const gpu = GPU.get();

        // Calculate ring buffer indices
        const currentSlot = this.frameCount % this.compareDistance;
        const previousSlot = (this.frameCount - this.compareDistance + this.compareDistance * 2) % this.compareDistance;

        // ====================================================================
        // Stage 1a: 256x256 -> 16x16 (Pass 0: units, resources, combat)
        // ====================================================================
        {
            const params = new Float32Array(8);
            const paramsInt = new Int32Array(params.buffer);
            params[0] = this.gameSize;
            params[1] = this.gameSize;
            params[2] = this.size16;
            params[3] = this.size16;
            paramsInt[4] = 0; // pass = 0
            gpu.writeBuffer(this.reduce256to16Uniforms, params);

            const bindGroup = this.reduce256to16Shader.createBindGroup([
                { binding: 0, resource: gameStateTexture.view },
                { binding: 1, resource: this.currentTexture16.view },
                { binding: 2, resource: { buffer: this.reduce256to16Uniforms } },
                { binding: 3, resource: this.sampler }
            ]);
            this.reduce256to16Shader.dispatch(bindGroup,
                Math.ceil(this.size16 / 8), Math.ceil(this.size16 / 8));
        }

        // ====================================================================
        // Stage 1b: 256x256 -> 16x16 (Pass 1: factories)
        // ====================================================================
        {
            const params = new Float32Array(8);
            const paramsInt = new Int32Array(params.buffer);
            params[0] = this.gameSize;
            params[1] = this.gameSize;
            params[2] = this.size16;
            params[3] = this.size16;
            paramsInt[4] = 1; // pass = 1
            gpu.writeBuffer(this.reduce256to16Uniforms, params);

            const bindGroup = this.reduce256to16Shader.createBindGroup([
                { binding: 0, resource: gameStateTexture.view },
                { binding: 1, resource: this.currentTexture16Fac.view },
                { binding: 2, resource: { buffer: this.reduce256to16Uniforms } },
                { binding: 3, resource: this.sampler }
            ]);
            this.reduce256to16Shader.dispatch(bindGroup,
                Math.ceil(this.size16 / 8), Math.ceil(this.size16 / 8));
        }

        // ====================================================================
        // Stage 2: 16x16 -> 4x4 (with temporal deltas)
        // ====================================================================
        {
            const prevTexture = this.ringBuffer16[previousSlot];
            const prevTextureFac = this.ringBuffer16Fac[previousSlot];

            const params = new Float32Array([
                this.size16, this.size16,
                this.size4, this.size4
            ]);
            gpu.writeBuffer(this.reduce16to4Uniforms, params);

            const bindGroup = this.reduce16to4Shader.createBindGroup([
                { binding: 0, resource: this.currentTexture16.view },
                { binding: 1, resource: prevTexture.view },
                { binding: 2, resource: this.currentTexture16Fac.view },
                { binding: 3, resource: prevTextureFac.view },
                { binding: 4, resource: this.texture4.view },
                { binding: 5, resource: { buffer: this.reduce16to4Uniforms } },
                { binding: 6, resource: this.sampler }
            ]);
            this.reduce16to4Shader.dispatch(bindGroup,
                Math.ceil(this.size4 / 8), Math.ceil(this.size4 / 8));
        }

        // ====================================================================
        // Stage 3: 4x4 -> 2x1 (final sound parameters)
        // ====================================================================
        {
            // Params struct: inputResolution(vec2f) + outputResolution(vec2f) + facResolution(vec2f) = 24 bytes
            const params = new Float32Array([
                this.size4, this.size4,           // inputResolution
                2, 1,                              // outputResolution (2x1)
                this.size16, this.size16,           // facResolution
                0, 0                               // padding to 32 bytes
            ]);
            gpu.writeBuffer(this.reduce4to2x1Uniforms, params);

            const bindGroup = this.reduce4to2x1Shader.createBindGroup([
                { binding: 0, resource: this.texture4.view },
                { binding: 1, resource: this.currentTexture16Fac.view },
                { binding: 2, resource: this.texture2x1.view },
                { binding: 3, resource: { buffer: this.reduce4to2x1Uniforms } },
                { binding: 4, resource: this.sampler }
            ]);
            this.reduce4to2x1Shader.dispatch(bindGroup, 1, 1);
        }

        // ====================================================================
        // Copy current frame to ring buffer slot (texture-to-texture copy)
        // ====================================================================
        this._copyTexture(this.currentTexture16, this.ringBuffer16[currentSlot], this.size16);
        this._copyTexture(this.currentTexture16Fac, this.ringBuffer16Fac[currentSlot], this.size16);

        // ====================================================================
        // Read back final 2x1 texture (async)
        // ====================================================================
        const readData = await this.texture2x1.download();
        this.soundParams.set(readData.subarray(0, 8));

        // ====================================================================
        // JFA: Jump Flooding Algorithm for accurate island detection
        // ====================================================================
        await this._runJFA(gameStateTexture);

        this.frameCount++;
        return this.soundParams;
    }

    /**
     * Run Jump Flooding Algorithm to count resource islands.
     */
    async _runJFA(gameStateTexture) {
        const gpu = GPU.get();

        // Step 1: Initialize - each resource cell gets its own coords as label
        {
            const params = new Float32Array([this.gameSize, this.gameSize, 0, 0]);
            gpu.writeBuffer(this.jfaInitUniforms, params);

            const bindGroup = this.jfaInitShader.createBindGroup([
                { binding: 0, resource: gameStateTexture.view },
                { binding: 1, resource: this.jfaTexA.view },
                { binding: 2, resource: { buffer: this.jfaInitUniforms } },
                { binding: 3, resource: this.sampler }
            ]);
            const wg = Math.ceil(this.gameSize / 8);
            this.jfaInitShader.dispatch(bindGroup, wg, wg);
        }

        // Step 2: JFA propagation passes (ping-pong between A and B)
        let readTex = this.jfaTexA;
        let writeTex = this.jfaTexB;

        for (let i = 0; i < this.jfaPasses; i++) {
            const stepSize = Math.floor(this.gameSize / Math.pow(2, i + 1));
            if (stepSize < 1) break;

            const params = new Float32Array([this.gameSize, this.gameSize, stepSize, 0]);
            gpu.writeBuffer(this.jfaStepUniforms, params);

            const bindGroup = this.jfaStepShader.createBindGroup([
                { binding: 0, resource: readTex.view },
                { binding: 1, resource: writeTex.view },
                { binding: 2, resource: { buffer: this.jfaStepUniforms } },
                { binding: 3, resource: this.sampler }
            ]);
            const wg = Math.ceil(this.gameSize / 8);
            this.jfaStepShader.dispatch(bindGroup, wg, wg);

            // Swap ping-pong
            [readTex, writeTex] = [writeTex, readTex];
        }

        // After all passes, readTex contains the final labels
        const finalLabelsTex = readTex;

        // Step 3: Count island roots
        // Stage 1: 256x256 -> 16x16
        {
            const params = new Float32Array(8);
            const paramsInt = new Int32Array(params.buffer);
            params[0] = this.gameSize;
            params[1] = this.gameSize;
            params[2] = this.size16;
            params[3] = this.size16;
            paramsInt[4] = 0; // stage = 0
            gpu.writeBuffer(this.jfaCountUniforms, params);

            const bindGroup = this.jfaCountShader.createBindGroup([
                { binding: 0, resource: finalLabelsTex.view },
                { binding: 1, resource: this.jfaCountTex16.view },
                { binding: 2, resource: { buffer: this.jfaCountUniforms } },
                { binding: 3, resource: this.sampler }
            ]);
            this.jfaCountShader.dispatch(bindGroup,
                Math.ceil(this.size16 / 8), Math.ceil(this.size16 / 8));
        }

        // Stage 2: 16x16 -> 1x1
        {
            const params = new Float32Array(8);
            const paramsInt = new Int32Array(params.buffer);
            params[0] = this.size16;
            params[1] = this.size16;
            params[2] = 1;
            params[3] = 1;
            paramsInt[4] = 1; // stage = 1
            gpu.writeBuffer(this.jfaCountUniforms, params);

            const bindGroup = this.jfaCountShader.createBindGroup([
                { binding: 0, resource: this.jfaCountTex16.view },
                { binding: 1, resource: this.jfaCountTex1.view },
                { binding: 2, resource: { buffer: this.jfaCountUniforms } },
                { binding: 3, resource: this.sampler }
            ]);
            this.jfaCountShader.dispatch(bindGroup, 1, 1);
        }

        // Read back island count (async)
        const countData = await this.jfaCountTex1.download();
        const currentIslandCount = Math.round(countData[0]);
        this.islandDepletion = 0;  // Feature disabled - too noisy
        this.prevIslandCount = currentIslandCount;
    }

    /**
     * Copy one texture to another using GPU command encoder.
     */
    _copyTexture(src, dst, size) {
        const gpu = GPU.get();
        const encoder = gpu.createCommandEncoder('Texture copy');
        encoder.copyTextureToTexture(
            { texture: src.texture },
            { texture: dst.texture },
            { width: size, height: size }
        );
        gpu.submit([encoder.finish()]);
    }

    /**
     * Get sound parameters as a structured object.
     */
    getSoundParams() {
        return {
            miningVolume: this.soundParams[0],
            combatVolume: this.soundParams[1],
            factoryHum: this.soundParams[2],
            swarmVolume: this.soundParams[3],
            spawnRate: this.soundParams[4],
            explosionRate: this.soundParams[5],
            ambientIntensity: this.soundParams[6],
            depletionRate: this.soundParams[7],
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

        if (this.reduce256to16Uniforms) this.reduce256to16Uniforms.destroy();
        if (this.reduce16to4Uniforms) this.reduce16to4Uniforms.destroy();
        if (this.reduce4to2x1Uniforms) this.reduce4to2x1Uniforms.destroy();
        if (this.jfaInitUniforms) this.jfaInitUniforms.destroy();
        if (this.jfaStepUniforms) this.jfaStepUniforms.destroy();
        if (this.jfaCountUniforms) this.jfaCountUniforms.destroy();

        for (let i = 0; i < this.compareDistance; i++) {
            this.ringBuffer16[i]?.destroy();
            this.ringBuffer16Fac[i]?.destroy();
        }

        if (this.currentTexture16) this.currentTexture16.destroy();
        if (this.currentTexture16Fac) this.currentTexture16Fac.destroy();
        if (this.texture4) this.texture4.destroy();
        if (this.texture2x1) this.texture2x1.destroy();

        if (this.jfaTexA) this.jfaTexA.destroy();
        if (this.jfaTexB) this.jfaTexB.destroy();
        if (this.jfaCountTex16) this.jfaCountTex16.destroy();
        if (this.jfaCountTex1) this.jfaCountTex1.destroy();

        this.initialized = false;
    }
}
