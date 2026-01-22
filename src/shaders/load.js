/**
 * Load a shader file from the server.
 * @param {string} path - Path to the shader file
 * @returns {Promise<string>} - Shader source code
 */
export async function loadShader(path) {
    const response = await fetch(path);
    if (!response.ok) {
        throw new Error(`Failed to load shader: ${path}`);
    }
    return await response.text();
}
