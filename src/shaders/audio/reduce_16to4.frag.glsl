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
 *   B: Current combat score
 *   A: Δ Factories (negative = destruction)
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
    
    // Sum all pixels in this 4x4 region
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
    
    // Compute deltas
    float deltaResources = currResources - prevResources;  // Negative = mining
    float deltaUnits = currUnits - prevUnits;              // Positive = spawns
    // Factory activity = absolute change in factory resources (deposits + spawning)
    float factoryActivity = abs(currFactoryResources - prevFactoryResources);
    
    // Pack: R=world resource delta, G=unit delta, B=combat, A=factory activity
    fragColor = vec4(deltaResources, deltaUnits, currCombat, factoryActivity);
}

