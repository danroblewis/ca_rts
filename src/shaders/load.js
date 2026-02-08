/**
 * Shader Loader with #include Preprocessor
 *
 * Supports both GLSL (.glsl) and WGSL (.wgsl) files:
 *   #include "path/to/file.wgsl"
 *   #include "./relative/path.wgsl"
 *
 * Paths are relative to the including file's directory.
 * Circular includes are detected and prevented.
 * Duplicate includes are tracked and skipped to reduce shader size.
 *
 * Processing is done depth-first, in order, so that nested dependencies
 * are resolved before sibling includes can claim them.
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
// Cache buster timestamp - refreshed on page load to ensure fresh shaders
const CACHE_BUSTER = Date.now();

async function fetchShader(path) {
    if (shaderCache.has(path)) {
        return shaderCache.get(path);
    }
    
    // Add cache-busting parameter to bypass browser cache during development
    const response = await fetch(`${path}?v=${CACHE_BUSTER}`);
    if (!response.ok) {
        throw new Error(`Failed to load shader: ${path} (${response.status})`);
    }
    
    const source = await response.text();
    shaderCache.set(path, source);
    return source;
}

/**
 * Process #include directives in shader source.
 * Uses depth-first, in-order processing so nested includes are resolved
 * before sibling includes can claim them as duplicates.
 * 
 * @param {string} source - Shader source code
 * @param {string} filePath - Path of the current file (for resolving relative includes)
 * @param {Set<string>} includedFiles - Set of already-included file paths (shared across all recursion)
 * @param {Set<string>} ancestorChain - Set of files in current include chain (for circular detection)
 * @returns {Promise<string>} - Processed shader source with includes expanded
 */
async function processIncludes(source, filePath, includedFiles, ancestorChain = new Set()) {
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
    
    // Process includes IN ORDER (not parallel) to ensure correct deduplication
    // This is critical: nested includes must be resolved before siblings claim them
    const processedSources = [];
    const shouldInclude = [];
    
    for (const m of matches) {
        const resolvedPath = resolvePath(filePath, m.path);
        
        // Check if already included
        if (includedFiles.has(resolvedPath)) {
            shouldInclude.push(false);
            processedSources.push('');
        } else {
            // Mark as included BEFORE processing (prevents circular refs in siblings)
            includedFiles.add(resolvedPath);
            shouldInclude.push(true);
            
            // Fetch and process this include (depth-first)
            const includeSource = await fetchShader(resolvedPath);
            const processed = await processIncludes(includeSource, resolvedPath, includedFiles, new Set(newAncestorChain));
            processedSources.push(processed);
        }
    }
    
    // Replace includes in reverse order (so indices stay valid)
    for (let i = matches.length - 1; i >= 0; i--) {
        const m = matches[i];
        const includeSource = processedSources[i];
        
        let replacement;
        if (!shouldInclude[i]) {
            // Already included elsewhere, just add a comment
            replacement = `\n// [DEDUPED] ${m.path}\n`;
        } else {
            // Add markers for debugging
            const header = `\n// >>> BEGIN ${m.path}\n`;
            const footer = `\n// <<< END ${m.path}\n`;
            replacement = header + includeSource.trim() + footer;
        }
        
        // Replace the #include directive
        source = source.substring(0, m.index) + replacement +
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
    
    // Create fresh deduplication set for this shader load
    const includedFiles = new Set();
    
    const source = await fetchShader(path);
    const result = await processIncludes(source, path, includedFiles);
    
    // Log shader size
    const lines = result.split('\n').length;
    const sizeKB = (result.length / 1024).toFixed(1);
    console.warn(`  📊 ${path.split('/').pop()}: ${lines} lines, ${sizeKB} KB (${includedFiles.size} unique includes)`);
    
    console.timeEnd(label);
    return result;
}

/**
 * Clear the shader cache (useful for hot reloading during development).
 */
export function clearShaderCache() {
    shaderCache.clear();
}
