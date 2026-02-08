import { GPU } from './GPU.js';

/**
 * ComputePipeline - WebGPU compute pipeline for CA simulation.
 *
 * Replaces the old ComputeShader (which used fragment shaders over fullscreen quads).
 * Now uses actual compute shaders dispatched as workgroups.
 */
export class ComputePipeline {
    /**
     * @param {string} wgslSource - WGSL compute shader source
     * @param {Object} [options]
     * @param {string} [options.label] - Debug label
     * @param {string} [options.entryPoint] - Entry point name (default: 'main')
     * @param {GPUBindGroupLayout[]} [options.bindGroupLayouts] - Explicit bind group layouts
     */
    constructor(wgslSource, options = {}) {
        const gpu = GPU.get();

        this.label = options.label || 'ComputePipeline';
        this.entryPoint = options.entryPoint || 'main';

        // Create shader module
        this.module = gpu.createShaderModule(wgslSource, this.label);

        // Create pipeline (auto layout)
        this.pipeline = gpu.device.createComputePipeline({
            layout: options.bindGroupLayouts
                ? gpu.device.createPipelineLayout({ bindGroupLayouts: options.bindGroupLayouts })
                : 'auto',
            compute: {
                module: this.module,
                entryPoint: this.entryPoint
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
     * Dispatch compute work.
     * @param {GPUBindGroup} bindGroup - Bind group with textures/uniforms
     * @param {number} workgroupsX - Number of workgroups in X
     * @param {number} workgroupsY - Number of workgroups in Y
     * @param {number} [workgroupsZ=1] - Number of workgroups in Z
     * @param {GPUCommandEncoder} [encoder] - Optional existing encoder
     */
    dispatch(bindGroup, workgroupsX, workgroupsY, workgroupsZ = 1, encoder = null) {
        const gpu = GPU.get();
        const ownEncoder = !encoder;
        if (ownEncoder) {
            encoder = gpu.createCommandEncoder(this.label);
        }

        const pass = encoder.beginComputePass({ label: this.label });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(workgroupsX, workgroupsY, workgroupsZ);
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
        // WebGPU pipelines don't need explicit cleanup
        this.pipeline = null;
        this.module = null;
    }
}
