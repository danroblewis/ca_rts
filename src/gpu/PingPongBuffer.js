import { DataTexture } from './DataTexture.js';

/**
 * PingPongBuffer - Double-buffered texture pair for iterative GPU computation.
 *
 * Used for cellular automata and other simulations where you read from
 * one buffer and write to another, then swap.
 *
 * WebGPU version: no framebuffers needed. Compute shaders write directly
 * to storage textures.
 */
export class PingPongBuffer {
    /**
     * @param {number} width - Width in pixels/cells
     * @param {number} height - Height in pixels/cells
     * @param {Object} options - Options passed to DataTexture constructor
     */
    constructor(width, height, options = {}) {
        this.width = width;
        this.height = height;

        // Create two textures
        this.textures = [
            new DataTexture(width, height, options),
            new DataTexture(width, height, options)
        ];

        // Index 0 = read, Index 1 = write
        this.readIndex = 0;
    }

    /**
     * Get the current read texture (contains current state).
     * @returns {DataTexture}
     */
    getReadTexture() {
        return this.textures[this.readIndex];
    }

    /**
     * Get the current write texture (target for next state).
     * @returns {DataTexture}
     */
    getWriteTexture() {
        return this.textures[1 - this.readIndex];
    }

    /**
     * Swap read and write buffers.
     * Call this after each simulation step.
     */
    swap() {
        this.readIndex = 1 - this.readIndex;
    }

    /**
     * Upload initial data to the read buffer.
     * @param {Float32Array|Uint8Array} data
     */
    upload(data) {
        this.textures[this.readIndex].upload(data);
    }

    /**
     * Download data from the read buffer.
     * @returns {Promise<Float32Array|Uint8Array>}
     */
    async download() {
        return this.textures[this.readIndex].download();
    }

    /**
     * Clean up GPU resources.
     */
    destroy() {
        this.textures[0].destroy();
        this.textures[1].destroy();
    }
}
