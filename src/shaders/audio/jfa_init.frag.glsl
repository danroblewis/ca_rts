#version 300 es
precision highp float;

/**
 * JFA Initialization - Label each resource cell with its own coordinates
 * 
 * Output:
 *   RG: Label coordinates (x, y) - or (-1, -1) if not a resource
 *   B: 1.0 if resource, 0.0 otherwise
 *   A: Resource amount (for potential weighting)
 */

uniform sampler2D u_state;          // Game state texture
uniform vec2 u_resolution;          // Grid resolution (256, 256)

// Cell type constants (must match game)
const float CELL_RESOURCE = 1.0;

in vec2 v_uv;
out vec4 fragColor;

void main() {
    vec2 pos = floor(gl_FragCoord.xy);
    vec4 cell = texture(u_state, (pos + 0.5) / u_resolution);
    float cellType = floor(cell.r + 0.5);
    
    if (cellType == CELL_RESOURCE) {
        // Resource cell: label = own position
        fragColor = vec4(pos.x, pos.y, 1.0, cell.g);
    } else {
        // Non-resource: invalid label
        fragColor = vec4(-1.0, -1.0, 0.0, 0.0);
    }
}

