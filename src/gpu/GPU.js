/**
 * GPU - Singleton class managing the WebGPU device and canvas context.
 *
 * This class ensures only ONE WebGPU device exists for the entire application.
 * All GPU operations go through this single device.
 */

let instance = null;

export class GPU {
    /**
     * Initialize the GPU singleton with a canvas element.
     * Can only be called once - subsequent calls throw an error.
     * @param {HTMLCanvasElement} canvas
     * @returns {Promise<GPU>}
     */
    static async init(canvas) {
        if (instance !== null) {
            throw new Error('GPU.init() can only be called once. Use GPU.get() to access the instance.');
        }
        instance = new GPU(canvas);
        await instance._initDevice();
        return instance;
    }

    /**
     * Get the GPU singleton instance.
     * @returns {GPU}
     */
    static get() {
        if (instance === null) {
            throw new Error('GPU not initialized. Call GPU.init(canvas) first.');
        }
        return instance;
    }

    /**
     * Reset the singleton (for testing only).
     */
    static _reset() {
        instance = null;
    }

    /**
     * @param {HTMLCanvasElement} canvas
     */
    constructor(canvas) {
        if (instance !== null) {
            throw new Error('Use GPU.init() or GPU.get() instead of new GPU()');
        }

        this.canvas = canvas;
        this.device = null;
        this.context = null;
        this.canvasFormat = null;
        this.adapter = null;
    }

    /**
     * Initialize WebGPU device and canvas context.
     */
    async _initDevice() {
        if (!navigator.gpu) {
            throw new Error('WebGPU is not supported in this browser');
        }

        // Request adapter
        this.adapter = await navigator.gpu.requestAdapter({
            powerPreference: 'high-performance'
        });

        if (!this.adapter) {
            throw new Error('No WebGPU adapter found');
        }

        // Request device with float32 filterable if available
        const requiredFeatures = [];
        if (this.adapter.features.has('float32-filterable')) {
            requiredFeatures.push('float32-filterable');
        }

        this.device = await this.adapter.requestDevice({
            requiredFeatures,
            requiredLimits: {
                maxStorageTexturesPerShaderStage: 1,
                maxStorageBuffersPerShaderStage: 1,
            }
        });

        // Handle device loss
        this.device.lost.then((info) => {
            console.error(`WebGPU device lost: ${info.message}`);
            if (info.reason !== 'destroyed') {
                console.error('Attempting to recover...');
            }
        });

        // Configure canvas context
        this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
        this.context = this.canvas.getContext('webgpu');
        this.context.configure({
            device: this.device,
            format: this.canvasFormat,
            alphaMode: 'opaque'
        });

        console.log('WebGPU device created successfully');
        console.log(`  Canvas format: ${this.canvasFormat}`);
        console.log(`  Float32 filterable: ${this.device.features.has('float32-filterable')}`);
    }

    /**
     * Create a shader module from WGSL source.
     * @param {string} source - WGSL shader source code
     * @param {string} [label] - Debug label
     * @returns {GPUShaderModule}
     */
    createShaderModule(source, label = '') {
        const start = performance.now();
        const module = this.device.createShaderModule({
            code: source,
            label
        });
        const compileTime = performance.now() - start;

        if (compileTime > 10) {
            console.log(`    Shader module "${label}": ${compileTime.toFixed(1)}ms`);
        }

        return module;
    }

    /**
     * Create a sampler for texture sampling.
     * @param {Object} [descriptor] - GPUSamplerDescriptor
     * @returns {GPUSampler}
     */
    createSampler(descriptor = {}) {
        return this.device.createSampler({
            magFilter: 'nearest',
            minFilter: 'nearest',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
            ...descriptor
        });
    }

    /**
     * Create a uniform buffer.
     * @param {number} size - Buffer size in bytes (will be rounded up to 16-byte alignment)
     * @param {string} [label] - Debug label
     * @returns {GPUBuffer}
     */
    createUniformBuffer(size, label = '') {
        // Round up to 16-byte alignment
        const alignedSize = Math.ceil(size / 16) * 16;
        return this.device.createBuffer({
            size: alignedSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label
        });
    }

    /**
     * Write data to a uniform buffer.
     * @param {GPUBuffer} buffer
     * @param {ArrayBuffer|TypedArray} data
     * @param {number} [offset=0]
     */
    writeBuffer(buffer, data, offset = 0) {
        this.device.queue.writeBuffer(buffer, offset, data);
    }

    /**
     * Get the current canvas texture view for render pass output.
     * @returns {GPUTextureView}
     */
    getCurrentTextureView() {
        return this.context.getCurrentTexture().createView();
    }

    /**
     * Submit command buffers to the GPU queue.
     * @param {GPUCommandBuffer[]} commandBuffers
     */
    submit(commandBuffers) {
        this.device.queue.submit(commandBuffers);
    }

    /**
     * Create a command encoder.
     * @param {string} [label] - Debug label
     * @returns {GPUCommandEncoder}
     */
    createCommandEncoder(label = '') {
        return this.device.createCommandEncoder({ label });
    }
}
