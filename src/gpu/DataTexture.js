import { GPU } from './GPU.js';

/**
 * DataTexture - A texture used for storing data (not just images).
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
        const gl = gpu.gl;

        this.width = width;
        this.height = height;
        this.format = options.format || 'float';

        // Determine WebGL format based on data type
        if (this.format === 'float') {
            this.internalFormat = gl.RGBA32F;
            this.glFormat = gl.RGBA;
            this.glType = gl.FLOAT;
            this.bytesPerPixel = 16; // 4 floats * 4 bytes
            this.ArrayType = Float32Array;
        } else {
            this.internalFormat = gl.RGBA8;
            this.glFormat = gl.RGBA;
            this.glType = gl.UNSIGNED_BYTE;
            this.bytesPerPixel = 4; // 4 bytes
            this.ArrayType = Uint8Array;
        }

        // Create the texture
        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);

        // Set texture parameters - NEAREST for exact values
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        // Allocate texture storage
        const data = options.data || null;
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            this.internalFormat,
            width,
            height,
            0,
            this.glFormat,
            this.glType,
            data
        );

        gl.bindTexture(gl.TEXTURE_2D, null);
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
        const gl = gpu.gl;

        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            x,
            y,
            width,
            height,
            this.glFormat,
            this.glType,
            data
        );
        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    /**
     * Read data from the texture back to CPU.
     * NOTE: This is slow! Avoid in hot paths.
     * @param {WebGLFramebuffer} framebuffer - Framebuffer with this texture attached
     * @returns {Float32Array|Uint8Array}
     */
    download(framebuffer) {
        const gpu = GPU.get();
        const gl = gpu.gl;

        const data = new this.ArrayType(this.width * this.height * 4);

        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.readPixels(0, 0, this.width, this.height, this.glFormat, this.glType, data);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        return data;
    }

    /**
     * Bind this texture to a texture unit.
     * @param {number} unit - Texture unit index (0-15)
     */
    bind(unit = 0) {
        const gpu = GPU.get();
        const gl = gpu.gl;

        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
    }

    /**
     * Clean up GPU resources.
     */
    destroy() {
        const gpu = GPU.get();
        const gl = gpu.gl;
        gl.deleteTexture(this.texture);
        this.texture = null;
    }
}
