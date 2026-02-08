import { GPU } from './GPU.js';

/**
 * RenderPipeline - WebGPU render pipeline for drawing to the canvas.
 *
 * Uses a fullscreen triangle trick (3 vertices, no vertex buffer) in the
 * vertex shader, and a custom fragment shader for rendering.
 */
export class RenderPipeline {
    /**
     * @param {string} wgslSource - WGSL source containing vs_main and fs_main
     * @param {Object} [options]
     * @param {string} [options.label] - Debug label
     * @param {string} [options.vertexEntryPoint] - Vertex entry point (default: 'vs_main')
     * @param {string} [options.fragmentEntryPoint] - Fragment entry point (default: 'fs_main')
     * @param {string} [options.format] - Target format (default: canvas format)
     */
    constructor(wgslSource, options = {}) {
        const gpu = GPU.get();

        this.label = options.label || 'RenderPipeline';
        const vertexEntryPoint = options.vertexEntryPoint || 'vs_main';
        const fragmentEntryPoint = options.fragmentEntryPoint || 'fs_main';
        const format = options.format || gpu.canvasFormat;

        // Create shader module
        this.module = gpu.createShaderModule(wgslSource, this.label);

        // Create render pipeline
        this.pipeline = gpu.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: this.module,
                entryPoint: vertexEntryPoint
                // No vertex buffers - fullscreen triangle is generated in shader
            },
            fragment: {
                module: this.module,
                entryPoint: fragmentEntryPoint,
                targets: [{ format }]
            },
            primitive: {
                topology: 'triangle-list'
            },
            label: this.label
        });

        this._ready = true;
    }

    /**
     * Create a bind group for this pipeline.
     * @param {Array<{binding: number, resource: GPUBindingResource}>} entries
     * @param {number} [group=0] - Bind group index
     * @returns {GPUBindGroup}
     */
    createBindGroup(entries, group = 0) {
        const gpu = GPU.get();
        return gpu.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(group),
            entries: entries.map(e => ({
                binding: e.binding,
                resource: e.resource
            })),
            label: `${this.label} bind group ${group}`
        });
    }

    /**
     * Draw a fullscreen triangle to a render target.
     * @param {GPUBindGroup} bindGroup - Bind group with textures/uniforms
     * @param {GPUTextureView} targetView - Render target (canvas texture view)
     * @param {GPUCommandEncoder} [encoder] - Optional existing encoder
     */
    draw(bindGroup, targetView, encoder = null) {
        const gpu = GPU.get();
        const ownEncoder = !encoder;
        if (ownEncoder) {
            encoder = gpu.createCommandEncoder(this.label);
        }

        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: targetView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 }
            }],
            label: this.label
        });

        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3); // Fullscreen triangle - 3 vertices, no vertex buffer
        pass.end();

        if (ownEncoder) {
            gpu.submit([encoder.finish()]);
        }
    }

    /**
     * No-op for compatibility - WebGPU pipelines are created synchronously.
     */
    async waitReady() {
        // WebGPU pipeline creation is synchronous
    }

    /**
     * Clean up GPU resources.
     */
    destroy() {
        this.pipeline = null;
        this.module = null;
    }
}
