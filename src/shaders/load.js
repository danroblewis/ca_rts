/**
 * GLSL Shader Loader with #include Preprocessor
 * 
 * Supports:
 *   #include "path/to/file.glsl"
 *   #include "./relative/path.glsl"
 * 
 * Paths are relative to the including file's directory.
 * Circular includes are detected and prevented.
 * 
 * Note: Duplicate includes are NOT removed by this loader - we rely on GLSL
 * #ifndef guards to handle deduplication at GPU compile time. This ensures
 * correct ordering when the same file is included by multiple siblings.
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
 * 
 * @param {string} source - Shader source code
 * @param {string} filePath - Path of the current file (for resolving relative includes)
 * @param {Set<string>} ancestorChain - Set of files in current include chain (for circular detection)
 * @returns {Promise<string>} - Processed shader source with includes expanded
 */
async function processIncludes(source, filePath, ancestorChain = new Set()) {
    // Detect circular includes (same file in the current chain = infinite loop)
    if (ancestorChain.has(filePath)) {
        throw new Error(`Circular include detected: ${filePath}`);
    }
    
    // Track this file in the ancestor chain for circular detection
    const newAncestorChain = new Set(ancestorChain);
    newAncestorChain.add(filePath);
    
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
    
    // Resolve all paths
    const resolvedPaths = matches.map(m => resolvePath(filePath, m.path));
    
    // Fetch ALL includes in parallel (cache handles network efficiency)
    const fetchPromises = resolvedPaths.map(path => fetchShader(path));
    const includeSources = await Promise.all(fetchPromises);
    
    // Process nested includes in parallel
    // Each branch gets a COPY of the ancestor chain (not shared) to allow
    // the same file to be included by multiple siblings - GLSL #ifndef guards
    // will handle deduplication at compile time
    const processedPromises = includeSources.map((src, i) => 
        processIncludes(src, resolvedPaths[i], new Set(newAncestorChain))
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
    const label = `  📄 ${path.split('/').pop()}`;
    console.time(label);
    const source = await fetchShader(path);
    const result = await processIncludes(source, path);
    console.timeEnd(label);
    return result;
}

/**
 * Clear the shader cache (useful for hot reloading during development).
 */
export function clearShaderCache() {
    shaderCache.clear();
}
