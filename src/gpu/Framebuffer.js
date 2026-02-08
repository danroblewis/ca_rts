/**
 * Framebuffer - Legacy stub.
 *
 * WebGPU has no framebuffer objects. Render targets are specified per-pass
 * via beginRenderPass({ colorAttachments }). For compute shaders, output
 * goes to storage textures (no framebuffer needed).
 *
 * This file is kept for import compatibility but the class is a no-op wrapper.
 */

export class Framebuffer {
    constructor(texture = null) {
        this.attachedTexture = texture;
    }

    attach(texture) {
        this.attachedTexture = texture;
    }

    // No-ops - WebGPU doesn't need these
    bind() {}
    unbind() {}

    destroy() {
        this.attachedTexture = null;
    }
}
