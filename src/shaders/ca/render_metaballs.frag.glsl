#version 300 es
precision highp float;

#include "common/cell_types.glsl"

uniform sampler2D u_state;
uniform vec2 u_resolution;

in vec2 v_uv;
out vec4 fragColor;

// Calculate "density" of a cell type in a radius - creates metaball effect
float calcDensity(vec2 uv, float targetType) {
    vec2 texelSize = 1.0 / u_resolution;
    float density = 0.0;
    
    // Sample in a 5x5 area with distance falloff
    for (int dy = -2; dy <= 2; dy++) {
        for (int dx = -2; dx <= 2; dx++) {
            vec2 offset = vec2(float(dx), float(dy));
            vec4 cellSample = texture(u_state, uv + offset * texelSize);
            float sampleType = getCellType(cellSample);
            
            if (sampleType == targetType) {
                // Inverse distance weighting for smooth blending
                float dist = length(offset);
                if (dist < 0.5) dist = 0.5; // Center cell gets max weight
                density += 1.0 / (dist * dist);
            }
        }
    }
    return density;
}

// Calculate unit density with holding info and age - larger radius for more blobby units
// Returns vec3(emptyDensity, holdingDensity, weightedAge)
vec3 calcUnitDensityWithAge(vec2 uv) {
    vec2 texelSize = 1.0 / u_resolution;
    float emptyDensity = 0.0;
    float holdingDensity = 0.0;
    float totalWeight = 0.0;
    float weightedAge = 0.0;
    
    // Larger 9x9 sampling area for units (they're often several pixels apart)
    for (int dy = -4; dy <= 4; dy++) {
        for (int dx = -4; dx <= 4; dx++) {
            vec2 offset = vec2(float(dx), float(dy));
            vec4 cellSample = texture(u_state, uv + offset * texelSize);
            
            if (isMiningUnit(cellSample)) {
                float dist = length(offset);
                if (dist < 0.5) dist = 0.5;
                float weight = 1.0 / (dist * dist);
                
                float age = getUnitAge(cellSample);
                weightedAge += age * weight;
                totalWeight += weight;
                
                if (isHoldingResource(cellSample)) {
                    holdingDensity += weight;
                } else {
                    emptyDensity += weight;
                }
            }
        }
    }
    
    // Normalize age by total weight
    float avgAge = totalWeight > 0.0 ? weightedAge / totalWeight : 0.0;
    return vec3(emptyDensity, holdingDensity, avgAge);
}

// Smooth noise for texture
float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

void main() {
    vec2 pixelPos = v_uv * u_resolution;
    
    // Background with subtle gradient
    vec3 bgColor = mix(
        vec3(0.02, 0.04, 0.08),
        vec3(0.06, 0.08, 0.12),
        v_uv.y
    );
    
    vec3 color = bgColor;
    
    // Calculate densities for each type
    float resourceDensity = calcDensity(v_uv, CELL_RESOURCE);
    float factoryDensity = calcDensity(v_uv, CELL_MINING_FACTORY);
    vec3 unitInfo = calcUnitDensityWithAge(v_uv);
    float emptyUnitDensity = unitInfo.x;
    float holdingUnitDensity = unitInfo.y;
    float avgAge = unitInfo.z;
    float ageRatio = avgAge / MAX_AGE;  // 0 = fresh, 1 = about to die
    
    // Thresholds for blob effect (lower = more blobby/connected)
    float resourceThreshold = 0.8;
    float unitThreshold = 0.3;  // Low threshold so single units show as blobs
    float factoryThreshold = 1.0;
    
    // Resources - golden blobs
    if (resourceDensity > resourceThreshold) {
        float blobStrength = smoothstep(resourceThreshold, resourceThreshold + 2.0, resourceDensity);
        
        // Rich gold color with subtle variation
        float n = hash(floor(pixelPos * 0.3));
        vec3 goldDark = vec3(0.65, 0.45, 0.08);
        vec3 goldBright = vec3(1.0, 0.8, 0.25);
        vec3 resourceColor = mix(goldDark, goldBright, blobStrength * 0.6 + n * 0.2);
        
        // Inner glow
        float innerGlow = smoothstep(resourceThreshold, resourceThreshold + 4.0, resourceDensity);
        resourceColor += vec3(0.2, 0.15, 0.0) * innerGlow;
        
        color = mix(color, resourceColor, blobStrength);
    }
    
    // Mining units - cyan (empty) or green (holding) blobs, with age-based fading
    float totalUnitDensity = emptyUnitDensity + holdingUnitDensity;
    
    // Age-based color modifiers
    float fadeStart = 0.3;  // Start fading at 30% age
    float deathFlashStart = 0.9;  // Flash starts at 90% age
    float ageBrightness = 1.0;
    vec3 ageColorMod = vec3(1.0);
    
    if (ageRatio >= fadeStart && ageRatio < deathFlashStart) {
        // Aging - gradually darken
        float fadeFactor = (ageRatio - fadeStart) / (deathFlashStart - fadeStart);
        ageBrightness = 1.0 - fadeFactor * 0.7;  // Fade to 30% brightness
    } else if (ageRatio >= deathFlashStart) {
        // Death flash - bright white burst then rapid fade
        float deathProgress = (ageRatio - deathFlashStart) / (1.0 - deathFlashStart);
        if (deathProgress < 0.3) {
            // White flash
            float flashIntensity = deathProgress / 0.3;
            ageColorMod = mix(vec3(0.3), vec3(3.0), flashIntensity);  // Oversaturate for flash
        } else {
            // Rapid fade out
            float fadeOut = (deathProgress - 0.3) / 0.7;
            ageBrightness = mix(1.5, 0.1, fadeOut);
            ageColorMod = vec3(1.0);
        }
    }
    
    // Outer glow first (shows even at low density)
    if (totalUnitDensity > unitThreshold * 0.3) {
        float holdingRatio = holdingUnitDensity / max(totalUnitDensity, 0.001);
        float glowStrength = smoothstep(0.0, unitThreshold, totalUnitDensity);
        vec3 glowColor = mix(vec3(0.05, 0.25, 0.4), vec3(0.1, 0.35, 0.1), holdingRatio);
        glowColor *= ageBrightness * ageColorMod;
        color = color + glowColor * glowStrength * 0.6;
    }
    
    // Main blob
    if (totalUnitDensity > unitThreshold) {
        float blobStrength = smoothstep(unitThreshold, unitThreshold + 1.5, totalUnitDensity);
        
        // Blend between cyan and green based on holding ratio
        float holdingRatio = holdingUnitDensity / max(totalUnitDensity, 0.001);
        
        vec3 cyanColor = vec3(0.3, 0.8, 1.0) * ageBrightness * ageColorMod;
        vec3 greenColor = vec3(0.4, 0.95, 0.4) * ageBrightness * ageColorMod;
        vec3 unitColor = mix(cyanColor, greenColor, holdingRatio);
        
        // Brighter core for dense groups
        float coreGlow = smoothstep(unitThreshold + 1.0, unitThreshold + 4.0, totalUnitDensity);
        unitColor += vec3(0.2) * coreGlow * ageBrightness;
        
        color = mix(color, unitColor, blobStrength);
    }
    
    // Walls - solid gray blocks
    float wallDensity = calcDensity(v_uv, CELL_WALL);
    if (wallDensity > 0.5) {
        float blobStrength = smoothstep(0.5, 2.0, wallDensity);
        
        // Dark gray stone-like color
        vec3 grayDark = vec3(0.25, 0.25, 0.28);
        vec3 grayLight = vec3(0.45, 0.45, 0.5);
        vec3 wallColor = mix(grayDark, grayLight, blobStrength * 0.5);
        
        // Subtle variation using position
        float n = fract(sin(dot(floor(v_uv * u_resolution), vec2(12.9898, 78.233))) * 43758.5453);
        wallColor += vec3(0.05) * n - vec3(0.025);
        
        color = mix(color, wallColor, blobStrength * 0.95);
    }
    
    // Factory - purple/magenta blob with energy glow
    if (factoryDensity > factoryThreshold) {
        float blobStrength = smoothstep(factoryThreshold, factoryThreshold + 1.5, factoryDensity);
        
        // Get resource count from center cell
        vec4 centerCell = texture(u_state, v_uv);
        float resources = 0.0;
        if (isMiningFactory(centerCell)) {
            resources = getFactoryResourceCount(centerCell);
        }
        float energyLevel = min(resources / 10.0, 1.0);
        
        // Purple base with energy brightness
        vec3 purpleDark = vec3(0.4, 0.1, 0.5);
        vec3 purpleBright = vec3(0.8, 0.3, 1.0);
        vec3 factoryColor = mix(purpleDark, purpleBright, 0.3 + energyLevel * 0.7);
        
        // Energy core glow
        float coreGlow = smoothstep(factoryThreshold, factoryThreshold + 2.0, factoryDensity);
        factoryColor += vec3(0.2, 0.1, 0.3) * coreGlow * energyLevel;
        
        color = mix(color, factoryColor, blobStrength);
    }
    
    // Subtle vignette
    float vignette = 1.0 - length(v_uv - 0.5) * 0.3;
    color *= vignette;
    
    // Slight gamma for nicer colors
    color = pow(color, vec3(0.95));
    
    fragColor = vec4(color, 1.0);
}
