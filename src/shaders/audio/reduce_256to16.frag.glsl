#version 300 es
precision highp float;

/**
 * Audio Reduction Stage 1: 256x256 → 16x16
 * 
 * Each output pixel covers a 16x16 region of the game state.
 * Counts cells by type and computes combat scores.
 * 
 * Output per pixel:
 *   R: P1 units count
 *   G: P2 units count  
 *   B: Total resources in region
 *   A: Combat score (units adjacent to enemy factories)
 *   
 * A second pass outputs:
 *   R: P1 factories count (cells, not structures)
 *   G: P2 factories count
 *   B: P1 factory total resources
 *   A: P2 factory total resources
 */

#include "./constants.glsl"

uniform sampler2D u_state;          // Game state texture (256x256)
uniform vec2 u_inputResolution;     // Input resolution (256, 256)
uniform vec2 u_outputResolution;    // Output resolution (16, 16)
uniform int u_pass;                 // 0 = units/resources/combat, 1 = factories

in vec2 v_uv;
out vec4 fragColor;

// Check if a cell at worldPos has an adjacent enemy factory
float computeCombatScore(vec2 worldPos, float cellType) {
    if (!isUnit(cellType)) return 0.0;
    
    int unitPlayer = getPlayer(cellType);
    float score = 0.0;
    
    // Check 4 neighbors
    vec2 offsets[4];
    offsets[0] = vec2(1.0, 0.0);
    offsets[1] = vec2(-1.0, 0.0);
    offsets[2] = vec2(0.0, 1.0);
    offsets[3] = vec2(0.0, -1.0);
    
    for (int i = 0; i < 4; i++) {
        vec2 neighborPos = worldPos + offsets[i];
        vec4 neighborCell = texture(u_state, (neighborPos + 0.5) / u_inputResolution);
        float neighborType = floor(neighborCell.r + 0.5);
        
        if (isFactory(neighborType)) {
            int factoryPlayer = getPlayer(neighborType);
            if (factoryPlayer != unitPlayer && factoryPlayer != 0) {
                score += 1.0;
            }
        }
    }
    
    return score;
}

void main() {
    // Output pixel position (0-15, 0-15)
    vec2 outPos = floor(gl_FragCoord.xy);
    
    // Region of input to sample (16x16 cells per output pixel)
    float regionSize = u_inputResolution.x / u_outputResolution.x;  // 16
    vec2 regionStart = outPos * regionSize;
    
    // Accumulators
    float p1Units = 0.0;
    float p2Units = 0.0;
    float resources = 0.0;
    float combatScore = 0.0;
    float p1Factories = 0.0;
    float p2Factories = 0.0;
    float p1FactoryResources = 0.0;
    float p2FactoryResources = 0.0;
    
    // Sample all cells in this region
    for (float dy = 0.0; dy < regionSize; dy += 1.0) {
        for (float dx = 0.0; dx < regionSize; dx += 1.0) {
            vec2 worldPos = regionStart + vec2(dx, dy);
            vec4 cell = texture(u_state, (worldPos + 0.5) / u_inputResolution);
            float cellType = floor(cell.r + 0.5);
            
            // Count by type
            if (isP1Unit(cellType)) {
                p1Units += 1.0;
            } else if (isP2Unit(cellType)) {
                p2Units += 1.0;
            } else if (cellType == CELL_RESOURCE) {
                resources += cell.g;  // Resource amount
            } else if (isP1Factory(cellType)) {
                p1Factories += 1.0;
                p1FactoryResources += getFactoryResources(cell);
            } else if (isP2Factory(cellType)) {
                p2Factories += 1.0;
                p2FactoryResources += getFactoryResources(cell);
            }
            
            // Combat score
            combatScore += computeCombatScore(worldPos, cellType);
        }
    }
    
    if (u_pass == 0) {
        // Pass 0: Units, resources, combat
        fragColor = vec4(p1Units, p2Units, resources, combatScore);
    } else {
        // Pass 1: Factories and their resources
        fragColor = vec4(p1Factories, p2Factories, p1FactoryResources, p2FactoryResources);
    }
}

