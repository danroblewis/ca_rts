import { PingPongBuffer } from '../gpu/PingPongBuffer.js';

/**
 * CAGrid - The cellular automata world state.
 * 
 * Just a PingPongBuffer with dimensions. All the actual
 * cell logic happens in GLSL shaders.
 */
export class CAGrid {
    /**
     * @param {number} width - Grid width in cells
     * @param {number} height - Grid height in cells
     */
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.buffer = new PingPongBuffer(width, height, { format: 'float' });
    }

    /** Get the read texture for shader input */
    getReadTexture() {
        return this.buffer.getReadTexture();
    }

    /** Get the write framebuffer for shader output */
    getWriteFramebuffer() {
        return this.buffer.getWriteFramebuffer();
    }

    /** Swap buffers after a simulation step */
    swap() {
        this.buffer.swap();
    }

    /** Upload initial data from CPU */
    upload(data) {
        this.buffer.upload(data);
    }

    /** Download current state to CPU (slow, avoid in hot path) */
    download() {
        return this.buffer.download();
    }

    /** Clean up GPU resources */
    destroy() {
        this.buffer.destroy();
    }
}
