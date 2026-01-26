#version 300 es
precision highp float;

/**
 * Audio Reduction Stage 3: 4x4 → 2x1
 * 
 * Final reduction that outputs sound parameters directly.
 * 
 * Input (4x4 with deltas):
 *   R: Δ World Resources    G: Δ Units    B: Combat+Depletion*100    A: Factory Activity
 *   
 * Output (2x1 = 2 pixels):
 *   Pixel 0 (Continuous loop volumes, 0.0-1.0):
 *     R: mining_volume     - Driven by resource depletion rate
 *     G: combat_volume     - Driven by combat score
 *     B: factory_hum       - Driven by factory activity (deposits + spawning)
 *     A: swarm_volume      - Driven by unit count changes
 *     
 *   Pixel 1 (Triggers and meta):
 *     R: spawn_rate        - Number of spawns (0-5+)
 *     G: explosion_rate    - Number of factory cells destroyed (0-3+)
 *     B: ambient_intensity - Overall activity level
 *     A: depletion_rate    - Resource blobs fully depleted (0-5+)
 */

uniform sampler2D u_deltas;         // 4x4 delta texture
uniform sampler2D u_currentFac;     // 16x16 factory data (for total resources)
uniform vec2 u_inputResolution;     // (4, 4) for deltas
uniform vec2 u_facResolution;       // (16, 16) for factory data

// Normalization constants (tuned for 256x256 grid)
const float MINING_DIVISOR = 20.0;      // Resources mined to reach full volume
const float COMBAT_DIVISOR = 10.0;      // Combat score for full volume
const float FACTORY_DIVISOR = 100.0;    // Factory resources for full hum
const float SWARM_DIVISOR = 50.0;       // Unit count for full swarm sound
const float ACTIVITY_DIVISOR = 100.0;   // Overall activity normalization

in vec2 v_uv;
out vec4 fragColor;

void main() {
    // Output pixel position (0 or 1, always y=0)
    float outX = floor(gl_FragCoord.x);
    
    // Sum all 16 pixels of the 4x4 delta texture
    float totalDeltaResources = 0.0;
    float totalDeltaUnits = 0.0;
    float totalCombat = 0.0;
    float totalFactoryActivity = 0.0;
    float totalDepletionEvents = 0.0;
    
    for (float y = 0.0; y < 4.0; y += 1.0) {
        for (float x = 0.0; x < 4.0; x += 1.0) {
            vec4 delta = texture(u_deltas, (vec2(x, y) + 0.5) / u_inputResolution);
            totalDeltaResources += delta.r;
            totalDeltaUnits += delta.g;
            
            // Unpack combat and depletion from B channel (combat + depletion*100)
            float packedValue = delta.b;
            float depletion = floor(packedValue / 100.0);
            float combat = packedValue - depletion * 100.0;
            totalCombat += combat;
            totalDepletionEvents += depletion;
            
            totalFactoryActivity += delta.a;  // Factory activity (deposits + spawning)
        }
    }
    
    // Count total factories for explosion detection (factory cells destroyed)
    float totalFactoryCells = 0.0;
    float prevTotalFactoryCells = 0.0;
    for (float y = 0.0; y < 16.0; y += 1.0) {
        for (float x = 0.0; x < 16.0; x += 1.0) {
            vec4 fac = texture(u_currentFac, (vec2(x, y) + 0.5) / u_facResolution);
            totalFactoryCells += fac.r + fac.g;  // P1 + P2 factory cell counts
        }
    }
    
    // Compute sound parameters
    float miningVolume = clamp(-totalDeltaResources / MINING_DIVISOR, 0.0, 1.0);
    float combatVolume = clamp(totalCombat / COMBAT_DIVISOR, 0.0, 1.0);
    // Factory hum based on ACTIVITY (deposits + spawning), not static resources
    float factoryHum = clamp(totalFactoryActivity / 10.0, 0.0, 1.0);
    float swarmVolume = clamp(abs(totalDeltaUnits) / SWARM_DIVISOR, 0.0, 1.0);
    
    float spawnRate = clamp(max(0.0, totalDeltaUnits), 0.0, 5.0);
    // For explosions, we'd need factory cell delta - approximate from combat
    float explosionRate = clamp(totalCombat / 5.0, 0.0, 3.0);
    float ambientIntensity = clamp(
        (abs(totalDeltaResources) + abs(totalDeltaUnits) + totalCombat + totalFactoryActivity) / ACTIVITY_DIVISOR,
        0.0, 1.0
    );
    
    // Depletion rate (resource blob fully mined)
    float depletionRate = clamp(totalDepletionEvents, 0.0, 5.0);
    
    if (outX < 0.5) {
        // Pixel 0: Continuous loop volumes
        fragColor = vec4(miningVolume, combatVolume, factoryHum, swarmVolume);
    } else {
        // Pixel 1: Triggers and meta
        fragColor = vec4(spawnRate, explosionRate, ambientIntensity, depletionRate);
    }
}

