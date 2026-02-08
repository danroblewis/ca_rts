import { RingBuffer } from '../gpu/RingBuffer.js';

/**
 * CAGrid - The cellular automata world state.
 *
 * Uses a RingBuffer (8 frames of history) instead of simple ping-pong.
 * This enables temporal anti-aliasing by blending multiple frames
 * in the render shader.
 *
 * All the actual cell logic happens in WGSL compute shaders.
 */
export class CAGrid {
    /**
     * @param {number} width - Grid width in cells
     * @param {number} height - Grid height in cells
     * @param {number} [frameCount=8] - Number of frames in ring buffer
     */
    constructor(width, height, frameCount = 8) {
        this.width = width;
        this.height = height;
        this.buffer = new RingBuffer(width, height, { format: 'float' }, frameCount);
    }

    /** Get the read texture for shader input (current state) */
    getReadTexture() {
        return this.buffer.getReadTexture();
    }

    /** Get the write texture for compute shader output */
    getWriteTexture() {
        return this.buffer.getWriteTexture();
    }

    /**
     * Get a texture by age (0 = current, 1 = one frame ago, etc.)
     * @param {number} age - How many frames ago
     * @returns {DataTexture}
     */
    getTextureByAge(age) {
        return this.buffer.getTextureByAge(age);
    }

    /**
     * Get all textures ordered by age for temporal AA.
     * Index 0 = newest (current), Index 7 = oldest
     * @returns {DataTexture[]}
     */
    getAllTexturesByAge() {
        return this.buffer.getAllTexturesByAge();
    }

    /**
     * Get the number of frames stored in the ring buffer.
     * @returns {number}
     */
    getFrameCount() {
        return this.buffer.getFrameCount();
    }

    /** Swap buffers after a simulation step */
    swap() {
        this.buffer.swap();
    }

    /**
     * Upload initial data from CPU.
     * @param {Float32Array} data
     * @param {boolean} [allFrames=false] - If true, fills all frames
     */
    upload(data, allFrames = false) {
        this.buffer.upload(data, allFrames);
    }

    /**
     * Upload data to only the current read frame.
     * Use for incremental updates (e.g., applying actions) without resetting history.
     */
    uploadCurrent(data) {
        this.buffer.uploadCurrent(data);
    }

    /** Download current state to CPU (async, avoid in hot path) */
    async download() {
        return this.buffer.download();
    }

    /** Clean up GPU resources */
    destroy() {
        this.buffer.destroy();
    }
}
