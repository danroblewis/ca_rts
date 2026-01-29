/**
 * GPU - Singleton class managing the WebGL2 context.
 * 
 * This class ensures only ONE WebGL2 context exists for the entire application.
 * All GPU operations go through this single context.
 */

let instance = null;

export class GPU {
    /**
     * Initialize the GPU singleton with a canvas element.
     * Can only be called once - subsequent calls throw an error.
     * @param {HTMLCanvasElement} canvas 
     * @returns {GPU}
     */
    static init(canvas) {
        if (instance !== null) {
            throw new Error('GPU.init() can only be called once. Use GPU.get() to access the instance.');
        }
        instance = new GPU(canvas);
        return instance;
    }

    /**
     * Get the GPU singleton instance.
     * @returns {GPU}
     */
    static get() {
        if (instance === null) {
            throw new Error('GPU not initialized. Call GPU.init(canvas) first.');
        }
        return instance;
    }

    /**
     * @param {HTMLCanvasElement} canvas 
     */
    constructor(canvas) {
        if (instance !== null) {
            throw new Error('Use GPU.init() or GPU.get() instead of new GPU()');
        }

        this.canvas = canvas;

        // Create WebGL2 context with appropriate settings
        this.gl = canvas.getContext('webgl2', {
            alpha: false,
            depth: false,
            stencil: false,
            antialias: false,
            preserveDrawingBuffer: false,
            powerPreference: 'high-performance'
        });

        if (!this.gl) {
            throw new Error('WebGL2 is not supported in this browser');
        }

        // Check for required extensions
        this.extColorBufferFloat = this.gl.getExtension('EXT_color_buffer_float');
        if (!this.extColorBufferFloat) {
            console.error('CRITICAL: EXT_color_buffer_float not available - float textures will NOT work as render targets!');
            console.error('This extension is required for GPU compute operations.');
            console.error('Your GPU/driver may not support rendering to float textures.');
        } else {
            console.log('EXT_color_buffer_float enabled - float texture rendering supported');
        }

        // Check for parallel shader compile extension (for faster loading)
        this.extParallelCompile = this.gl.getExtension('KHR_parallel_shader_compile');
        if (this.extParallelCompile) {
            console.log('KHR_parallel_shader_compile available - using parallel compilation');
        }

        // Create the fullscreen quad geometry (used for all compute operations)
        this._createFullscreenQuad();

        console.log('WebGL2 context created successfully');
    }

    /**
     * Check if a shader is ready (compiled). Only useful with KHR_parallel_shader_compile.
     * @param {WebGLShader} shader
     * @returns {boolean}
     */
    isShaderReady(shader) {
        if (!this.extParallelCompile) return true;
        return this.gl.getShaderParameter(shader, this.extParallelCompile.COMPLETION_STATUS_KHR);
    }

    /**
     * Check if a program is ready (linked). Only useful with KHR_parallel_shader_compile.
     * @param {WebGLProgram} program
     * @returns {boolean}
     */
    isProgramReady(program) {
        if (!this.extParallelCompile) return true;
        return this.gl.getProgramParameter(program, this.extParallelCompile.COMPLETION_STATUS_KHR);
    }

    /**
     * Wait for a program to be ready (linked). Uses requestAnimationFrame polling.
     * @param {WebGLProgram} program
     * @returns {Promise<void>}
     */
    async waitForProgram(program) {
        if (!this.extParallelCompile) return;
        
        while (!this.isProgramReady(program)) {
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
    }

    /**
     * Create a fullscreen quad for rendering compute shaders.
     * This is a single triangle strip that covers the entire viewport.
     */
    _createFullscreenQuad() {
        const gl = this.gl;

        // Fullscreen quad as two triangles (triangle strip)
        // Positions are in clip space (-1 to 1)
        const positions = new Float32Array([
            -1, -1,  // bottom-left
             1, -1,  // bottom-right
            -1,  1,  // top-left
             1,  1   // top-right
        ]);

        // UV coordinates (0 to 1)
        const uvs = new Float32Array([
            0, 0,  // bottom-left
            1, 0,  // bottom-right
            0, 1,  // top-left
            1, 1   // top-right
        ]);

        // Create VAO
        this.quadVAO = gl.createVertexArray();
        gl.bindVertexArray(this.quadVAO);

        // Position buffer (attribute 0)
        this.quadPositionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadPositionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        // UV buffer (attribute 1)
        this.quadUVBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadUVBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

        gl.bindVertexArray(null);
    }

    /**
     * Draw the fullscreen quad.
     * Used by ComputeShader to execute shader programs.
     */
    drawFullscreenQuad() {
        const gl = this.gl;
        gl.bindVertexArray(this.quadVAO);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
    }

    /**
     * Compile a shader from source.
     * @param {number} type - gl.VERTEX_SHADER or gl.FRAGMENT_SHADER
     * @param {string} source - GLSL source code
     * @returns {WebGLShader}
     */
    compileShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const info = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error(`Shader compilation error:\n${info}`);
        }

        return shader;
    }

    /**
     * Link a shader program from vertex and fragment shaders.
     * Note: With KHR_parallel_shader_compile, this returns immediately.
     * Call isProgramReady() or waitForProgram() before checking link status.
     * @param {WebGLShader} vertexShader 
     * @param {WebGLShader} fragmentShader 
     * @returns {WebGLProgram}
     */
    linkProgram(vertexShader, fragmentShader) {
        const gl = this.gl;
        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);

        // With parallel compile, don't check status yet - it will block
        // Error checking is deferred to ComputeShader.waitReady()
        if (!this.extParallelCompile) {
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                const info = gl.getProgramInfoLog(program);
                gl.deleteProgram(program);
                throw new Error(`Program linking error:\n${info}`);
            }
        }

        return program;
    }
}
