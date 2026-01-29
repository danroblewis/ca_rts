import fs from 'fs';
import path from 'path';

// Simple shader include preprocessor
async function processIncludes(source, filePath, depth = 0) {
    const includeRegex = /^[ \t]*#include\s+["<]([^">]+)[">]\s*$/gm;
    
    let match;
    while ((match = includeRegex.exec(source)) !== null) {
        const includePath = match[1];
        let resolvedPath;
        
        // Resolve path
        const baseDir = path.dirname(filePath);
        if (includePath.startsWith('./') || includePath.startsWith('../')) {
            resolvedPath = path.join(baseDir, includePath);
        } else {
            resolvedPath = path.join('src/shaders', includePath);
        }
        
        console.log(`${'  '.repeat(depth)}Including: ${includePath} -> ${resolvedPath}`);
        
        const includeSource = fs.readFileSync(resolvedPath, 'utf8');
        const processedInclude = await processIncludes(includeSource, resolvedPath, depth + 1);
        
        const header = `\n// >>> BEGIN ${includePath}\n`;
        const footer = `\n// <<< END ${includePath}\n`;
        
        source = source.substring(0, match.index) + 
                 header + processedInclude.trim() + footer +
                 source.substring(match.index + match[0].length);
        
        // Reset regex since we modified the source
        includeRegex.lastIndex = 0;
    }
    
    return source;
}

// Main
const shaderPath = 'src/shaders/ca/render_metaballs.frag.glsl';
const source = fs.readFileSync(shaderPath, 'utf8');
const processed = await processIncludes(source, shaderPath);

const lines = processed.split('\n');
console.log(`\nTotal lines: ${lines.length}`);
console.log('\n=== Lines 570-595 ===\n');
for (let i = 569; i < 595 && i < lines.length; i++) {
    console.log(`${(i + 1).toString().padStart(4)}: ${lines[i]}`);
}

