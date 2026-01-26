#version 300 es
precision highp float;

/**
 * JFA Island Count - Reduction shader to count unique islands
 * 
 * After JFA completes, each island has exactly ONE "root" cell where label == position.
 * This shader counts those roots via hierarchical reduction.
 * 
 * Stage 1 (256x256 → 16x16): Count roots in each 16x16 region
 * Stage 2 (16x16 → 1x1): Sum all regions
 */

uniform sampler2D u_labels;         // JFA result (or previous reduction stage)
uniform vec2 u_inputResolution;     // Input resolution
uniform vec2 u_outputResolution;    // Output resolution
uniform int u_stage;                // 0 = count roots, 1 = sum counts

in vec2 v_uv;
out vec4 fragColor;

void main() {
    vec2 outPos = floor(gl_FragCoord.xy);
    float regionSize = u_inputResolution.x / u_outputResolution.x;
    vec2 regionStart = outPos * regionSize;
    
    float count = 0.0;
    
    if (u_stage == 0) {
        // Stage 0: Count root cells (label == position) in each region
        for (float dy = 0.0; dy < regionSize; dy += 1.0) {
            for (float dx = 0.0; dx < regionSize; dx += 1.0) {
                vec2 worldPos = regionStart + vec2(dx, dy);
                vec4 cell = texture(u_labels, (worldPos + 0.5) / u_inputResolution);
                
                // Check if this is a root (label == position AND is resource)
                if (cell.b > 0.5) {  // Is resource
                    vec2 label = cell.rg;
                    if (abs(label.x - worldPos.x) < 0.5 && abs(label.y - worldPos.y) < 0.5) {
                        count += 1.0;
                    }
                }
            }
        }
    } else {
        // Stage 1+: Sum counts from previous stage
        for (float dy = 0.0; dy < regionSize; dy += 1.0) {
            for (float dx = 0.0; dx < regionSize; dx += 1.0) {
                vec2 samplePos = (regionStart + vec2(dx, dy) + 0.5) / u_inputResolution;
                vec4 prev = texture(u_labels, samplePos);
                count += prev.r;  // Previous stage stores count in R
            }
        }
    }
    
    // Store count in R, preserve other channels for debugging
    fragColor = vec4(count, 0.0, 0.0, 0.0);
}

