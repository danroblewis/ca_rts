import { GPU } from '../gpu/GPU.js';
import { ComputePipeline } from '../gpu/ComputePipeline.js';
import { loadShader } from '../shaders/load.js';

const BLOCK_SIZE = 8;
const UNIFORM_RING = 32;   // max ticks that can be encoded between submits

/**
 * SimulationPipeline - one simulation tick of the mining game on the GPU.
 *
 * A tick is two compute passes:
 *   1. sim_prepass.wgsl  - per-cell intent (unit/resource direction, factory
 *                          built flag) + per-8x8-block activity mask
 *   2. mining_game.wgsl  - the trait-based CA update, reading the intents
 *
 * The pipelines (shader modules) are shared across all instances; per-grid
 * resources (intent texture, mask buffer, uniform buffers) live on the instance.
 *
 * Usage:
 *   const sim = await SimulationPipeline.create(width, height);
 *   sim.step(readTexture, writeTexture, tick);                 // submit now
 *   sim.encodeStep(encoder, readTexture, writeTexture, tick);  // batch ticks
 */
export class SimulationPipeline {
    static _shared = null;

    static DEFAULT_PATHS = {
        prepass: './src/shaders/ca/v2/sim_prepass.wgsl',
        main: './src/shaders/ca/v2/mining_game.wgsl'
    };

    /**
     * Load and compile the shared shader pipelines (cached by path).
     * @param {Object} [paths] - {prepass, main} shader paths (for tests)
     */
    static async loadPipelines(paths = {}) {
        const prepassPath = paths.prepass || SimulationPipeline.DEFAULT_PATHS.prepass;
        const mainPath = paths.main || SimulationPipeline.DEFAULT_PATHS.main;
        const key = prepassPath + '|' + mainPath;
        SimulationPipeline._cache ??= new Map();
        let entry = SimulationPipeline._cache.get(key);
        if (!entry) {
            const [prepassSrc, mainSrc] = await Promise.all([loadShader(prepassPath), loadShader(mainPath)]);
            entry = {
                prepass: new ComputePipeline(prepassSrc, { label: 'Sim prepass' }),
                main: new ComputePipeline(mainSrc, { label: 'Simulation' })
            };
            SimulationPipeline._cache.set(key, entry);
        }
        return entry;
    }

    /**
     * Create a simulation pipeline for a grid of the given size.
     * @param {number} width
     * @param {number} height
     * @param {Object} [options]
     * @param {Object} [options.pipelines] - explicit {prepass, main} ComputePipelines
     * @param {Object} [options.paths] - shader paths passed to loadPipelines
     * @param {boolean} [options.missilesEnabled=false] - allow factory -> missile transformation
     */
    static async create(width, height, options = {}) {
        const pipelines = options.pipelines || await SimulationPipeline.loadPipelines(options.paths);
        return new SimulationPipeline(width, height, pipelines, options);
    }

    /**
     * @param {Object} [options]
     * @param {boolean} [options.missilesEnabled=false] - allow factory -> missile transformation
     */
    constructor(width, height, pipelines, options = {}) {
        const gpu = GPU.get();
        this.width = width;
        this.height = height;
        this.prepass = pipelines.prepass;
        this.main = pipelines.main;

        this.blocksX = Math.ceil(width / BLOCK_SIZE);
        this.blocksY = Math.ceil(height / BLOCK_SIZE);

        // Ring of uniform buffers so several ticks can be recorded in one
        // command encoder (queue.writeBuffer is ordered against submits, not
        // against passes inside one encoder).
        this.uniformBuffers = [];
        for (let i = 0; i < UNIFORM_RING; i++) {
            this.uniformBuffers.push(gpu.createUniformBuffer(16, `SimParams ${i}`));
        }
        this.uniformIndex = 0;
        // [width, height, time, flags]  flags bit 0: missile feature
        this.missilesEnabled = !!options.missilesEnabled;
        this.uniformData = new Float32Array([width, height, 0, this.missilesEnabled ? 1 : 0]);

        this.intentTexture = gpu.device.createTexture({
            size: { width, height },
            format: 'r32uint',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
            label: `Sim intent ${width}x${height}`
        });
        this.intentView = this.intentTexture.createView();

        this.maskBuffer = gpu.device.createBuffer({
            size: Math.max(16, this.blocksX * this.blocksY * 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            label: 'Sim activity mask'
        });

        // Per-block state hash written by the prepass (hash of the input state
        // of the most recently encoded tick).
        this.hashBufferSize = Math.max(16, this.blocksX * this.blocksY * 4);
        this.hashBuffer = gpu.device.createBuffer({
            size: this.hashBufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            label: 'Sim state hash'
        });
        this._stagingPool = [];

        // Bind groups depend on (readTex, writeTex, uniform slot); cache them.
        this._bindGroupCache = new Map();
    }

    _getBindGroups(readTex, writeTex, uniformIndex) {
        let byWrite = this._bindGroupCache.get(readTex);
        if (!byWrite) {
            byWrite = new Map();
            this._bindGroupCache.set(readTex, byWrite);
        }
        let bySlot = byWrite.get(writeTex);
        if (!bySlot) {
            bySlot = new Array(UNIFORM_RING).fill(null);
            byWrite.set(writeTex, bySlot);
        }
        let groups = bySlot[uniformIndex];
        if (!groups) {
            const uniformBuffer = this.uniformBuffers[uniformIndex];
            groups = {
                prepass: this.prepass.createBindGroup([
                    { binding: 0, resource: readTex.view },
                    { binding: 1, resource: this.intentView },
                    { binding: 2, resource: { buffer: uniformBuffer } },
                    { binding: 3, resource: { buffer: this.maskBuffer } },
                    { binding: 4, resource: { buffer: this.hashBuffer } }
                ]),
                main: this.main.createBindGroup([
                    { binding: 0, resource: readTex.view },
                    { binding: 1, resource: writeTex.view },
                    { binding: 2, resource: { buffer: uniformBuffer } },
                    { binding: 3, resource: this.intentView },
                    { binding: 4, resource: { buffer: this.maskBuffer } }
                ])
            };
            bySlot[uniformIndex] = groups;
        }
        return groups;
    }

    /**
     * Record one tick (prepass + main pass) into an existing command encoder.
     * Up to UNIFORM_RING ticks may be recorded before a submit.
     * @param {GPUCommandEncoder} encoder
     * @param {DataTexture} readTex - current state
     * @param {DataTexture} writeTex - next state
     * @param {number} time - simulation tick (drives the RNG)
     */
    encodeStep(encoder, readTex, writeTex, time) {
        const slot = this.uniformIndex;
        this.uniformIndex = (this.uniformIndex + 1) % UNIFORM_RING;

        this.uniformData[2] = time;
        GPU.get().writeBuffer(this.uniformBuffers[slot], this.uniformData);

        const groups = this._getBindGroups(readTex, writeTex, slot);
        this.prepass.dispatch(groups.prepass, this.blocksX, this.blocksY, 1, encoder);
        this.main.dispatch(groups.main, this.blocksX, this.blocksY, 1, encoder);
    }

    /**
     * Run one tick and submit it immediately.
     */
    step(readTex, writeTex, time) {
        const gpu = GPU.get();
        const encoder = gpu.createCommandEncoder('Simulation tick');
        this.encodeStep(encoder, readTex, writeTex, time);
        gpu.submit([encoder.finish()]);
    }

    /**
     * Record a copy of the state hash (as computed by the most recently
     * encoded tick's prepass, i.e. the hash of that tick's INPUT state) into a
     * staging buffer. Returns a function that, once the encoder has been
     * submitted, resolves to the combined 32-bit hash without blocking.
     * @param {GPUCommandEncoder} encoder
     * @returns {() => Promise<number>}
     */
    encodeHashReadback(encoder) {
        const gpu = GPU.get();
        let staging = this._stagingPool.pop();
        if (!staging) {
            staging = gpu.device.createBuffer({
                size: this.hashBufferSize,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
                label: 'Sim hash staging'
            });
        }
        encoder.copyBufferToBuffer(this.hashBuffer, 0, staging, 0, this.hashBufferSize);
        const count = this.blocksX * this.blocksY;
        return async () => {
            await staging.mapAsync(GPUMapMode.READ);
            const words = new Uint32Array(staging.getMappedRange());
            let h = 0x811C9DC5;
            for (let i = 0; i < count; i++) {
                h = Math.imul(h ^ words[i], 0x01000193) >>> 0;
                h ^= h >>> 13;
            }
            staging.unmap();
            this._stagingPool.push(staging);
            return h >>> 0;
        };
    }

    /**
     * Convenience: compute the hash of the state in `readTex` right now
     * (runs the prepass only). Used by tests and resync.
     */
    async hashState(readTex, writeTex, time = 0) {
        const gpu = GPU.get();
        const encoder = gpu.createCommandEncoder('Sim hash');
        const slot = this.uniformIndex;
        this.uniformIndex = (this.uniformIndex + 1) % UNIFORM_RING;
        this.uniformData[2] = time;
        gpu.writeBuffer(this.uniformBuffers[slot], this.uniformData);
        const groups = this._getBindGroups(readTex, writeTex, slot);
        this.prepass.dispatch(groups.prepass, this.blocksX, this.blocksY, 1, encoder);
        const read = this.encodeHashReadback(encoder);
        gpu.submit([encoder.finish()]);
        return read();
    }

    destroy() {
        this.intentTexture.destroy();
        this.maskBuffer.destroy();
        this.hashBuffer.destroy();
        for (const b of this._stagingPool) b.destroy();
        for (const b of this.uniformBuffers) b.destroy();
        this._bindGroupCache.clear();
    }
}
