import { GPU } from './GPU.js';

/**
 * Standard vertex shader for fullscreen quad rendering.
 * Used by all compute shaders.
 */
const FULLSCREEN_VERT = `#version 300 es
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_uv;

out vec2 v_uv;

void main() {
    v_uv = a_uv;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

/**
 * ComputeShader - Wrapper for shader programs used in GPU computation.
 * 
 * Combines the standard fullscreen vertex shader with a custom fragment shader.
 */
export class ComputeShader {
    /**
     * @param {string} fragmentSource - GLSL fragment shader source
     */
    constructor(fragmentSource) {
        const gpu = GPU.get();
        const gl = gpu.gl;

        // Compile shaders
        const vertexShader = gpu.compileShader(gl.VERTEX_SHADER, FULLSCREEN_VERT);
        const fragmentShader = gpu.compileShader(gl.FRAGMENT_SHADER, fragmentSource);

        // Store for cleanup
        this._vertexShader = vertexShader;
        this._fragmentShader = fragmentShader;

        // Link program (may be async with KHR_parallel_shader_compile)
        this.program = gpu.linkProgram(vertexShader, fragmentShader);
        this._ready = false;

        // Cache uniform locations
        this.uniforms = {};
    }

    /**
     * Wait for shader to be ready (useful with KHR_parallel_shader_compile).
     * Must be called before using the shader if parallel compile is enabled.
     * @returns {Promise<void>}
     */
    async waitReady() {
        if (this._ready) return;
        
        const gpu = GPU.get();
        const gl = gpu.gl;
        
        await gpu.waitForProgram(this.program);
        
        // Now check for link errors (deferred until compilation complete)
        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
            const info = gl.getProgramInfoLog(this.program);
            gl.deleteProgram(this.program);
            throw new Error(`Program linking error:\n${info}`);
        }
        
        // Clean up individual shaders (they're now part of the program)
        gl.deleteShader(this._vertexShader);
        gl.deleteShader(this._fragmentShader);
        this._vertexShader = null;
        this._fragmentShader = null;
        
        this._ready = true;
    }

    /**
     * Synchronous ready check (for backwards compatibility).
     * Cleans up shaders if not done yet.
     */
    ensureReady() {
        if (this._ready) return;
        
        const gpu = GPU.get();
        const gl = gpu.gl;
        
        // Clean up individual shaders
        if (this._vertexShader) {
            gl.deleteShader(this._vertexShader);
            this._vertexShader = null;
        }
        if (this._fragmentShader) {
            gl.deleteShader(this._fragmentShader);
            this._fragmentShader = null;
        }
        
        this._ready = true;
    }

    /**
     * Get (and cache) a uniform location.
     * @param {string} name - Uniform name
     * @returns {WebGLUniformLocation}
     */
    getUniformLocation(name) {
        if (!(name in this.uniforms)) {
            const gpu = GPU.get();
            this.uniforms[name] = gpu.gl.getUniformLocation(this.program, name);
        }
        return this.uniforms[name];
    }

    /**
     * Use this shader program.
     */
    use() {
        const gpu = GPU.get();
        gpu.gl.useProgram(this.program);
    }

    /**
     * Set a float uniform.
     * @param {string} name 
     * @param {number} value 
     */
    setFloat(name, value) {
        const gpu = GPU.get();
        gpu.gl.uniform1f(this.getUniformLocation(name), value);
    }

    /**
     * Set an integer uniform.
     * @param {string} name 
     * @param {number} value 
     */
    setInt(name, value) {
        const gpu = GPU.get();
        gpu.gl.uniform1i(this.getUniformLocation(name), value);
    }

    /**
     * Set a vec2 uniform.
     * @param {string} name 
     * @param {number} x 
     * @param {number} y 
     */
    setVec2(name, x, y) {
        const gpu = GPU.get();
        gpu.gl.uniform2f(this.getUniformLocation(name), x, y);
    }

    /**
     * Set a vec3 uniform.
     * @param {string} name 
     * @param {number} x 
     * @param {number} y 
     * @param {number} z 
     */
    setVec3(name, x, y, z) {
        const gpu = GPU.get();
        gpu.gl.uniform3f(this.getUniformLocation(name), x, y, z);
    }

    /**
     * Set a vec4 uniform.
     * @param {string} name 
     * @param {number} x 
     * @param {number} y 
     * @param {number} z 
     * @param {number} w 
     */
    setVec4(name, x, y, z, w) {
        const gpu = GPU.get();
        gpu.gl.uniform4f(this.getUniformLocation(name), x, y, z, w);
    }

    /**
     * Bind a texture to a uniform sampler.
     * @param {string} name - Uniform name
     * @param {DataTexture} texture - Texture to bind
     * @param {number} unit - Texture unit (0-15)
     */
    setTexture(name, texture, unit) {
        texture.bind(unit);
        this.setInt(name, unit);
    }

    /**
     * Execute this compute shader by rendering a fullscreen quad.
     * The framebuffer should already be bound.
     */
    dispatch() {
        const gpu = GPU.get();
        gpu.drawFullscreenQuad();
    }

    /**
     * Clean up GPU resources.
     */
    destroy() {
        const gpu = GPU.get();
        gpu.gl.deleteProgram(this.program);
        this.program = null;
        this.uniforms = {};
    }
}
