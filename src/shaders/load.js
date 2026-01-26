/**
 * GLSL Shader Loader with #include Preprocessor
 * 
 * Supports:
 *   #include "path/to/file.glsl"
 *   #include "./relative/path.glsl"
 * 
 * Paths are relative to the including file's directory.
 * Circular includes are detected and prevented.
 */

const shaderCache = new Map();

/**
 * Resolve a path relative to a base path.
 * @param {string} basePath - The path of the file doing the include
 * @param {string} includePath - The path being included
 * @returns {string} - Resolved absolute path
 */
function resolvePath(basePath, includePath) {
    // Get directory of the base file
    const baseDir = basePath.substring(0, basePath.lastIndexOf('/') + 1);
    
    // Handle relative paths
    if (includePath.startsWith('./')) {
        return baseDir + includePath.substring(2);
    } else if (includePath.startsWith('../')) {
        // Handle parent directory references
        let dir = baseDir;
        let path = includePath;
        while (path.startsWith('../')) {
            dir = dir.substring(0, dir.lastIndexOf('/', dir.length - 2) + 1);
            path = path.substring(3);
        }
        return dir + path;
    } else {
        // Absolute path from shader root
        return './src/shaders/' + includePath;
    }
}

/**
 * Fetch a shader file (with caching).
 * @param {string} path - Path to the shader file
 * @returns {Promise<string>} - Raw shader source
 */
async function fetchShader(path) {
    if (shaderCache.has(path)) {
        return shaderCache.get(path);
    }
    
    const response = await fetch(path);
    if (!response.ok) {
        throw new Error(`Failed to load shader: ${path} (${response.status})`);
    }
    
    const source = await response.text();
    shaderCache.set(path, source);
    return source;
}

/**
 * Process #include directives in shader source.
 * @param {string} source - Shader source code
 * @param {string} filePath - Path of the current file (for resolving relative includes)
 * @param {Set<string>} included - Set of already-included files (for circular detection)
 * @returns {Promise<string>} - Processed shader source with includes expanded
 */
async function processIncludes(source, filePath, included = new Set()) {
    // Detect circular includes
    if (included.has(filePath)) {
        throw new Error(`Circular include detected: ${filePath}`);
    }
    included.add(filePath);
    
    // Match #include "path" or #include <path>
    const includeRegex = /^[ \t]*#include\s+["<]([^">]+)[">]\s*$/gm;
    
    // Find all includes
    const matches = [];
    let match;
    while ((match = includeRegex.exec(source)) !== null) {
        matches.push({
            fullMatch: match[0],
            path: match[1],
            index: match.index
        });
    }
    
    // If no includes, return early
    if (matches.length === 0) {
        return source;
    }
    
    // Fetch ALL includes in parallel for better performance
    const resolvedPaths = matches.map(m => resolvePath(filePath, m.path));
    const fetchPromises = resolvedPaths.map(path => fetchShader(path));
    const includeSources = await Promise.all(fetchPromises);
    
    // Process nested includes in parallel too
    const processedPromises = includeSources.map((src, i) => 
        processIncludes(src, resolvedPaths[i], new Set(included))
    );
    const processedSources = await Promise.all(processedPromises);
    
    // Replace includes in reverse order (so indices stay valid)
    for (let i = matches.length - 1; i >= 0; i--) {
        const m = matches[i];
        const includeSource = processedSources[i];
        
        // Add markers for debugging
        const header = `\n// >>> BEGIN ${m.path}\n`;
        const footer = `\n// <<< END ${m.path}\n`;
        
        // Replace the #include directive with the file contents
        source = source.substring(0, m.index) + 
                 header + includeSource.trim() + footer +
                 source.substring(m.index + m.fullMatch.length);
    }
    
    return source;
}

/**
 * Load a shader file with #include preprocessing.
 * @param {string} path - Path to the shader file
 * @returns {Promise<string>} - Fully processed shader source
 */
export async function loadShader(path) {
    const source = await fetchShader(path);
    return await processIncludes(source, path);
}

/**
 * Clear the shader cache (useful for hot reloading during development).
 */
export function clearShaderCache() {
    shaderCache.clear();
}
