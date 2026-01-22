import { GPU } from './GPU.js';

/**
 * Framebuffer - Wrapper for WebGL framebuffer objects.
 * 
 * Used to render to textures instead of the screen.
 */
export class Framebuffer {
    /**
     * Create a framebuffer.
     * @param {DataTexture} texture - Optional texture to attach immediately
     */
    constructor(texture = null) {
        const gpu = GPU.get();
        const gl = gpu.gl;

        this.framebuffer = gl.createFramebuffer();
        this.attachedTexture = null;

        if (texture) {
            this.attach(texture);
        }
    }

    /**
     * Attach a texture as the color attachment.
     * @param {DataTexture} texture 
     */
    attach(texture) {
        const gpu = GPU.get();
        const gl = gpu.gl;

        this.attachedTexture = texture;

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
        gl.framebufferTexture2D(
            gl.FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            texture.texture,
            0
        );

        // Check framebuffer status
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            throw new Error(`Framebuffer incomplete: ${status}`);
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    /**
     * Bind this framebuffer as the render target.
     * Sets viewport to match the attached texture size.
     */
    bind() {
        const gpu = GPU.get();
        const gl = gpu.gl;

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);

        if (this.attachedTexture) {
            gl.viewport(0, 0, this.attachedTexture.width, this.attachedTexture.height);
        }
    }

    /**
     * Unbind (switch back to rendering to canvas).
     */
    unbind() {
        const gpu = GPU.get();
        const gl = gpu.gl;

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gpu.canvas.width, gpu.canvas.height);
    }

    /**
     * Clean up GPU resources.
     */
    destroy() {
        const gpu = GPU.get();
        const gl = gpu.gl;
        gl.deleteFramebuffer(this.framebuffer);
        this.framebuffer = null;
        this.attachedTexture = null;
    }
}
