#version 300 es
precision highp float;

/**
 * Audio Reduction Stage 2: 16x16 → 4x4
 * 
 * Sums 4x4 regions of the stage 1 output.
 * Also computes temporal deltas by comparing to previous frame.
 * 
 * Input (current + previous 16x16 textures):
 *   R: P1 units    G: P2 units    B: Resources    A: Combat
 *   
 * Output per pixel (includes deltas):
 *   R: Δ Resources (negative = mining happened)
 *   G: Δ Units (P1 + P2 combined, positive = spawns)
 *   B: Current combat score + depletion events (packed: combat + depletion*100)
 *   A: Factory activity
 */

uniform sampler2D u_current;        // Current frame 16x16 (pass 0 output)
uniform sampler2D u_previous;       // Previous frame 16x16 (from N frames ago)
uniform sampler2D u_currentFac;     // Current frame 16x16 (pass 1 - factories)
uniform sampler2D u_previousFac;    // Previous frame 16x16 (pass 1 - factories)
uniform vec2 u_inputResolution;     // Input resolution (16, 16)
uniform vec2 u_outputResolution;    // Output resolution (4, 4)

in vec2 v_uv;
out vec4 fragColor;

void main() {
    // Output pixel position (0-3, 0-3)
    vec2 outPos = floor(gl_FragCoord.xy);
    
    // Region of input to sample (4x4 pixels per output pixel)
    float regionSize = u_inputResolution.x / u_outputResolution.x;  // 4
    vec2 regionStart = outPos * regionSize;
    
    // Accumulators for current frame
    float currUnits = 0.0;
    float currResources = 0.0;
    float currCombat = 0.0;
    float currFactories = 0.0;
    float currFactoryResources = 0.0;
    
    // Accumulators for previous frame
    float prevUnits = 0.0;
    float prevResources = 0.0;
    float prevFactories = 0.0;
    float prevFactoryResources = 0.0;
    
    // Sum all pixels in this 4x4 region (each pixel = 16x16 game cells, so region = 64x64 cells)
    for (float dy = 0.0; dy < regionSize; dy += 1.0) {
        for (float dx = 0.0; dx < regionSize; dx += 1.0) {
            vec2 samplePos = (regionStart + vec2(dx, dy) + 0.5) / u_inputResolution;
            
            // Current frame data
            vec4 curr = texture(u_current, samplePos);
            vec4 currF = texture(u_currentFac, samplePos);
            currUnits += curr.r + curr.g;  // P1 + P2 units
            currResources += curr.b;
            currCombat += curr.a;
            currFactories += currF.r + currF.g;  // P1 + P2 factories
            currFactoryResources += currF.b + currF.a;
            
            // Previous frame data
            vec4 prev = texture(u_previous, samplePos);
            vec4 prevF = texture(u_previousFac, samplePos);
            prevUnits += prev.r + prev.g;
            prevResources += prev.b;
            prevFactories += prevF.r + prevF.g;
            prevFactoryResources += prevF.b + prevF.a;
        }
    }
    
    // Multi-scale depletion detection:
    // Detect when a 64x64 region has been significantly depleted
    // (lots of mining happened AND very few resources remain)
    float deltaResources = currResources - prevResources;  // Negative = mining
    float significantMining = -deltaResources;  // Positive when mining happened
    
    // Depletion event: mined a decent amount AND remaining is low
    // This catches "a blob was just finished" rather than "any region went empty"
    // Thresholds: mined > 5 resources, remaining < 20 resources in 64x64 region
    float depletionEvents = 0.0;
    if (significantMining > 5.0 && currResources < 20.0) {
        // Scale by how much was mined (more satisfying for bigger clearings)
        depletionEvents = clamp(significantMining / 10.0, 0.5, 3.0);
    }
    
    // Compute remaining deltas
    float deltaUnits = currUnits - prevUnits;              // Positive = spawns
    // Factory activity = absolute change in factory resources (deposits + spawning)
    float factoryActivity = abs(currFactoryResources - prevFactoryResources);
    
    // Pack combat and depletion into B channel (combat + depletion * 100)
    float packedCombatDepletion = currCombat + depletionEvents * 100.0;
    
    // Pack: R=world resource delta, G=unit delta, B=combat+depletion, A=factory activity
    fragColor = vec4(deltaResources, deltaUnits, packedCombatDepletion, factoryActivity);
}

