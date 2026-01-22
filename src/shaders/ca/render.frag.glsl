#version 300 es
precision highp float;

#include "common/cell_types.glsl"

uniform sampler2D u_state;
uniform vec2 u_resolution;

in vec2 v_uv;
out vec4 fragColor;

// Sample cell type at offset
float sampleType(vec2 uv, vec2 offset) {
    vec2 texelSize = 1.0 / u_resolution;
    return getCellType(texture(u_state, uv + offset * texelSize));
}

// Count same-type neighbors for blob effect
float countSameNeighbors(vec2 uv, float myType) {
    float count = 0.0;
    vec2 texelSize = 1.0 / u_resolution;
    
    for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
            if (dx == 0 && dy == 0) continue;
            vec2 offset = vec2(float(dx), float(dy));
            float neighborType = getCellType(texture(u_state, uv + offset * texelSize));
            if (neighborType == myType) {
                count += 1.0;
            }
        }
    }
    return count;
}

// Smooth noise for texture
float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
    vec2 texelSize = 1.0 / u_resolution;
    vec2 pixelPos = v_uv * u_resolution;
    
    vec4 cell = texture(u_state, v_uv);
    float cellType = getCellType(cell);
    
    // Sub-pixel position within the cell (0-1)
    vec2 subPixel = fract(pixelPos);
    vec2 cellCenter = vec2(0.5);
    float distFromCenter = length(subPixel - cellCenter);
    
    vec3 color;
    float alpha = 1.0;
    
    // Background gradient
    vec3 bgColor = mix(
        vec3(0.04, 0.06, 0.1),   // Dark blue at bottom
        vec3(0.08, 0.1, 0.16),   // Slightly lighter at top
        v_uv.y
    );
    
    if (cellType == CELL_EMPTY) {
        color = bgColor;
        
        // Add subtle grid lines
        float gridLine = 0.0;
        if (fract(pixelPos.x) < 0.08 || fract(pixelPos.y) < 0.08) {
            gridLine = 0.02;
        }
        color += vec3(gridLine);
    }
    else if (cellType == CELL_RESOURCE) {
        // Gold/amber resources with blob effect
        float neighbors = countSameNeighbors(v_uv, CELL_RESOURCE);
        float blobFactor = neighbors / 8.0;
        
        // Organic blob shape - more round at edges
        float radius = 0.35 + blobFactor * 0.15;
        float blob = 1.0 - smoothstep(radius - 0.1, radius + 0.1, distFromCenter);
        
        // Rich gold color with variation
        float n = noise(pixelPos * 0.5);
        vec3 goldDark = vec3(0.7, 0.5, 0.1);
        vec3 goldBright = vec3(1.0, 0.85, 0.3);
        color = mix(goldDark, goldBright, 0.5 + n * 0.5);
        
        // Shiny highlight
        float highlight = pow(max(0.0, 1.0 - distFromCenter * 2.5), 3.0);
        color += vec3(0.3, 0.25, 0.1) * highlight;
        
        // Blend with background at edges
        color = mix(bgColor, color, blob);
    }
    else if (cellType == CELL_MINING_UNIT) {
        bool holding = isHoldingResource(cell);
        
        // Circular unit with glow
        float radius = 0.4;
        float blob = 1.0 - smoothstep(radius - 0.15, radius, distFromCenter);
        float glow = 1.0 - smoothstep(0.0, 0.6, distFromCenter);
        
        vec3 coreColor;
        vec3 glowColor;
        
        if (holding) {
            // Carrying resource - warm green/yellow
            coreColor = vec3(0.4, 0.95, 0.3);
            glowColor = vec3(0.2, 0.6, 0.1);
        } else {
            // Searching - cool cyan/blue
            coreColor = vec3(0.3, 0.85, 1.0);
            glowColor = vec3(0.1, 0.4, 0.6);
        }
        
        // Core with bright center
        float centerBright = pow(max(0.0, 1.0 - distFromCenter * 2.0), 2.0);
        color = coreColor + vec3(0.3) * centerBright;
        
        // Outer glow
        color = mix(bgColor + glowColor * glow * 0.5, color, blob);
    }
    else if (cellType == CELL_MINING_FACTORY) {
        float resources = getFactoryResourceCount(cell);
        float resourceGlow = min(resources / 10.0, 1.0);
        
        // Factory is a square-ish building with glow
        vec2 squareDist = abs(subPixel - cellCenter);
        float boxDist = max(squareDist.x, squareDist.y);
        float box = 1.0 - smoothstep(0.3, 0.4, boxDist);
        
        // Purple/magenta base
        vec3 baseColor = vec3(0.5, 0.15, 0.6);
        vec3 brightColor = vec3(0.8, 0.3, 1.0);
        color = mix(baseColor, brightColor, resourceGlow);
        
        // Energy glow based on resources
        float pulse = sin(resources * 0.5) * 0.1 + 0.9;
        float glow = (1.0 - smoothstep(0.0, 0.7, boxDist)) * resourceGlow * pulse;
        
        // Add glow
        color = mix(bgColor + vec3(0.3, 0.1, 0.4) * glow, color, box);
        
        // Center bright spot
        float center = pow(max(0.0, 1.0 - boxDist * 3.0), 2.0);
        color += vec3(0.2, 0.1, 0.3) * center * resourceGlow;
    }
    else {
        // Unknown - red for debugging
        color = vec3(1.0, 0.0, 0.0);
    }
    
    // Subtle vignette
    float vignette = 1.0 - length(v_uv - 0.5) * 0.4;
    color *= vignette;
    
    // Gamma correction for nicer colors
    color = pow(color, vec3(0.9));
    
    fragColor = vec4(color, 1.0);
}
