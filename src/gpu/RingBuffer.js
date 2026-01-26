import { DataTexture } from './DataTexture.js';
import { Framebuffer } from './Framebuffer.js';

/**
 * RingBuffer - Circular buffer of textures for iterative GPU computation
 * with temporal anti-aliasing support.
 * 
 * Instead of 2 ping-pong textures, we keep 8 frames of history.
 * This allows the render shader to blend across multiple frames
 * for smoother motion.
 */
export class RingBuffer {
    /**
     * @param {number} width - Width in pixels/cells
     * @param {number} height - Height in pixels/cells
     * @param {Object} options - Options passed to DataTexture constructor
     * @param {number} [frameCount=8] - Number of frames in the ring buffer
     */
    constructor(width, height, options = {}, frameCount = 8) {
        this.width = width;
        this.height = height;
        this.frameCount = frameCount;

        // Create textures for each frame
        this.textures = [];
        this.framebuffers = [];
        
        for (let i = 0; i < frameCount; i++) {
            const texture = new DataTexture(width, height, options);
            this.textures.push(texture);
            this.framebuffers.push(new Framebuffer(texture));
        }

        // writeIndex points to the next frame to write to
        // After a simulation step: write to writeIndex, then increment
        // Current state (most recent) is at (writeIndex - 1 + frameCount) % frameCount
        this.writeIndex = 0;
    }

    /**
     * Get the index of the most recent (current) frame.
     * @returns {number}
     */
    getCurrentIndex() {
        return (this.writeIndex - 1 + this.frameCount) % this.frameCount;
    }

    /**
     * Get the current read texture (contains current state).
     * This is the most recently written frame.
     * @returns {DataTexture}
     */
    getReadTexture() {
        return this.textures[this.getCurrentIndex()];
    }

    /**
     * Get the current write texture (target for next state).
     * @returns {DataTexture}
     */
    getWriteTexture() {
        return this.textures[this.writeIndex];
    }

    /**
     * Get the framebuffer for the write texture.
     * @returns {Framebuffer}
     */
    getWriteFramebuffer() {
        return this.framebuffers[this.writeIndex];
    }

    /**
     * Get the framebuffer for the read texture (current state).
     * @returns {Framebuffer}
     */
    getReadFramebuffer() {
        return this.framebuffers[this.getCurrentIndex()];
    }

    /**
     * Get a texture by age (0 = current/newest, 1 = one frame ago, etc.)
     * @param {number} age - How many frames ago (0 to frameCount-1)
     * @returns {DataTexture}
     */
    getTextureByAge(age) {
        const index = (this.getCurrentIndex() - age + this.frameCount) % this.frameCount;
        return this.textures[index];
    }

    /**
     * Get all textures ordered by age (index 0 = newest, index 7 = oldest).
     * Useful for passing to render shader for temporal AA.
     * @returns {DataTexture[]}
     */
    getAllTexturesByAge() {
        const result = [];
        for (let age = 0; age < this.frameCount; age++) {
            result.push(this.getTextureByAge(age));
        }
        return result;
    }

    /**
     * Advance to the next frame after a simulation step.
     * Call this after rendering to the write framebuffer.
     */
    swap() {
        this.writeIndex = (this.writeIndex + 1) % this.frameCount;
    }

    /**
     * Upload initial data to ALL frames (fills history with same state).
     * Use this for initialization only - slow (8x upload)!
     * @param {Float32Array|Uint8Array} data 
     * @param {boolean} allFrames - If true, upload to all frames (default: false, only current)
     */
    upload(data, allFrames = false) {
        if (allFrames) {
            // Upload to all frames - only for initial map generation
            for (let i = 0; i < this.frameCount; i++) {
                this.textures[i].upload(data);
            }
        } else {
            // Upload to just the current read frame - for network sync
            this.textures[this.getCurrentIndex()].upload(data);
        }
    }

    /**
     * Upload data to only the current read frame.
     * Use this for incremental updates that don't need full history reset.
     * @param {Float32Array|Uint8Array} data 
     */
    uploadCurrent(data) {
        this.textures[this.getCurrentIndex()].upload(data);
    }

    /**
     * Download data from the read buffer (current state).
     * @returns {Float32Array|Uint8Array}
     */
    download() {
        const currentIndex = this.getCurrentIndex();
        return this.textures[currentIndex].download(
            this.framebuffers[currentIndex].framebuffer
        );
    }

    /**
     * Get the number of frames in the buffer.
     * @returns {number}
     */
    getFrameCount() {
        return this.frameCount;
    }

    /**
     * Clean up GPU resources.
     */
    destroy() {
        for (let i = 0; i < this.frameCount; i++) {
            this.textures[i].destroy();
            this.framebuffers[i].destroy();
        }
        this.textures = [];
        this.framebuffers = [];
    }
}
