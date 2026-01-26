#version 300 es
precision highp float;

/**
 * JFA Step - Propagate labels to neighbors at step distance
 * 
 * Each cell looks at 8 neighbors at distance 'stepSize' and adopts
 * a neighbor's label if:
 *   1. The neighbor has a valid label (is/was a resource)
 *   2. Tie-breaker: prefer smaller coordinates (consistent ordering)
 * 
 * Run this shader log2(resolution) times with stepSize = resolution/2, resolution/4, ... 1
 */

uniform sampler2D u_labels;         // Current label texture
uniform vec2 u_resolution;          // Grid resolution (256, 256)
uniform float u_stepSize;           // Current step size (128, 64, 32, 16, 8, 4, 2, 1)

in vec2 v_uv;
out vec4 fragColor;

// Compare two labels - returns true if a is "better" (smaller coords, or b is invalid)
bool isBetterLabel(vec2 a, vec2 b) {
    // Invalid labels have negative coords
    bool aValid = a.x >= 0.0;
    bool bValid = b.x >= 0.0;
    
    if (!aValid && !bValid) return false;
    if (aValid && !bValid) return true;
    if (!aValid && bValid) return false;
    
    // Both valid: prefer smaller y, then smaller x
    if (a.y < b.y) return true;
    if (a.y > b.y) return false;
    return a.x < b.x;
}

void main() {
    vec2 pos = floor(gl_FragCoord.xy);
    vec4 current = texture(u_labels, (pos + 0.5) / u_resolution);
    
    // If this cell is not a resource (B channel = 0), keep it empty
    if (current.b < 0.5) {
        fragColor = current;
        return;
    }
    
    vec2 bestLabel = current.rg;
    float isResource = current.b;
    float resourceAmount = current.a;
    
    // Check 8 neighbors at stepSize distance
    for (float dy = -1.0; dy <= 1.0; dy += 1.0) {
        for (float dx = -1.0; dx <= 1.0; dx += 1.0) {
            if (dx == 0.0 && dy == 0.0) continue;
            
            vec2 neighborPos = pos + vec2(dx, dy) * u_stepSize;
            
            // Bounds check
            if (neighborPos.x < 0.0 || neighborPos.x >= u_resolution.x ||
                neighborPos.y < 0.0 || neighborPos.y >= u_resolution.y) {
                continue;
            }
            
            vec4 neighbor = texture(u_labels, (neighborPos + 0.5) / u_resolution);
            
            // Only consider neighbors that are resources
            if (neighbor.b < 0.5) continue;
            
            vec2 neighborLabel = neighbor.rg;
            
            if (isBetterLabel(neighborLabel, bestLabel)) {
                bestLabel = neighborLabel;
            }
        }
    }
    
    fragColor = vec4(bestLabel, isResource, resourceAmount);
}

