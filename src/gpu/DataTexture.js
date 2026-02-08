import { GPU } from './GPU.js';

/**
 * DataTexture - A WebGPU texture used for storing data (not just images).
 *
 * Supports:
 * - RGBA32F (float) for high-precision data
 * - RGBA8 (byte) for compact data
 *
 * Uses NEAREST filtering for exact cell values (no interpolation).
 */
export class DataTexture {
    /**
     * @param {number} width - Width in pixels/cells
     * @param {number} height - Height in pixels/cells
     * @param {Object} options
     * @param {'float'|'byte'} options.format - Data format (default: 'float')
     * @param {Float32Array|Uint8Array|null} options.data - Initial data (optional)
     */
    constructor(width, height, options = {}) {
        const gpu = GPU.get();

        this.width = width;
        this.height = height;
        this.format = options.format || 'float';

        // Determine WebGPU format based on data type
        if (this.format === 'float') {
            this.gpuFormat = 'rgba32float';
            this.bytesPerPixel = 16; // 4 floats * 4 bytes
            this.ArrayType = Float32Array;
        } else {
            this.gpuFormat = 'rgba8unorm';
            this.bytesPerPixel = 4; // 4 bytes
            this.ArrayType = Uint8Array;
        }

        // Create the texture
        this.texture = gpu.device.createTexture({
            size: { width, height },
            format: this.gpuFormat,
            usage:
                GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.STORAGE_BINDING |
                GPUTextureUsage.COPY_SRC |
                GPUTextureUsage.COPY_DST |
                GPUTextureUsage.RENDER_ATTACHMENT,
            label: `DataTexture ${width}x${height} ${this.format}`
        });

        // Create a default view
        this.view = this.texture.createView();

        // Upload initial data if provided
        if (options.data) {
            this.upload(options.data);
        }
    }

    /**
     * Upload data to the texture.
     * @param {Float32Array|Uint8Array} data - Data to upload (must match format)
     * @param {number} x - X offset (default: 0)
     * @param {number} y - Y offset (default: 0)
     * @param {number} width - Width of region (default: full width)
     * @param {number} height - Height of region (default: full height)
     */
    upload(data, x = 0, y = 0, width = this.width, height = this.height) {
        const gpu = GPU.get();

        gpu.device.queue.writeTexture(
            { texture: this.texture, origin: { x, y } },
            data,
            { bytesPerRow: width * this.bytesPerPixel, rowsPerImage: height },
            { width, height }
        );
    }

    /**
     * Read data from the texture back to CPU.
     * NOTE: This is async and slow! Avoid in hot paths.
     * @returns {Promise<Float32Array|Uint8Array>}
     */
    async download() {
        const gpu = GPU.get();

        const bytesPerRow = Math.ceil((this.width * this.bytesPerPixel) / 256) * 256;
        const bufferSize = bytesPerRow * this.height;

        // Create a staging buffer for readback
        const stagingBuffer = gpu.device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            label: 'DataTexture download staging'
        });

        // Copy texture to staging buffer
        const encoder = gpu.createCommandEncoder('DataTexture download');
        encoder.copyTextureToBuffer(
            { texture: this.texture },
            { buffer: stagingBuffer, bytesPerRow, rowsPerImage: this.height },
            { width: this.width, height: this.height }
        );
        gpu.submit([encoder.finish()]);

        // Map the staging buffer and read data
        await stagingBuffer.mapAsync(GPUMapMode.READ);
        const mappedRange = stagingBuffer.getMappedRange();

        // Copy data out (handling potential row padding)
        const actualBytesPerRow = this.width * this.bytesPerPixel;
        const result = new this.ArrayType(this.width * this.height * 4);

        if (bytesPerRow === actualBytesPerRow) {
            // No padding, direct copy
            result.set(new this.ArrayType(mappedRange));
        } else {
            // Has padding, copy row by row
            const src = new this.ArrayType(mappedRange);
            const srcElementsPerRow = bytesPerRow / (this.bytesPerPixel / 4);
            const dstElementsPerRow = this.width * 4;
            for (let row = 0; row < this.height; row++) {
                const srcOffset = row * (bytesPerRow / (this.format === 'float' ? 4 : 1));
                const dstOffset = row * dstElementsPerRow;
                result.set(
                    src.subarray(srcOffset, srcOffset + dstElementsPerRow),
                    dstOffset
                );
            }
        }

        stagingBuffer.unmap();
        stagingBuffer.destroy();

        return result;
    }

    /**
     * Create a texture view (for bind group creation).
     * @returns {GPUTextureView}
     */
    createView() {
        return this.texture.createView();
    }

    /**
     * Clean up GPU resources.
     */
    destroy() {
        if (this.texture) {
            this.texture.destroy();
            this.texture = null;
            this.view = null;
        }
    }
}
