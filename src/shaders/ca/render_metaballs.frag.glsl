#version 300 es
precision highp float;

#include "common/cell_types.glsl"

uniform sampler2D u_state;
uniform vec2 u_resolution;       // Grid resolution (e.g., 256x256)
uniform vec2 u_canvasResolution; // Canvas resolution (e.g., 1920x1080)
uniform float u_time;
uniform float u_metaballScale;   // Scale factor for metaball effect (0.5 = tighter, 2.0 = blobbier)

in vec2 v_uv;
out vec4 fragColor;

// Higher quality sampling - uses fractional positions for smoother blending
// u_metaballScale controls how blobby the effect is (1.0 = default, <1 = tighter, >1 = blobbier)
float calcDensityHQ(vec2 uv, float targetType) {
    vec2 texelSize = 1.0 / u_resolution;
    float density = 0.0;
    
    // Calculate position within grid cell (0-1)
    vec2 gridPos = uv * u_resolution;
    vec2 cellFrac = fract(gridPos);
    
    // Scale affects the distance falloff - higher scale = more spread
    float scale = max(0.1, u_metaballScale);
    float minDist = 0.3 / scale;  // Minimum distance clamp scales inversely
    
    // Sample in a 5x5 area with sub-cell distance weighting
    for (int dy = -2; dy <= 2; dy++) {
        for (int dx = -2; dx <= 2; dx++) {
            vec2 offset = vec2(float(dx), float(dy));
            vec2 sampleUV = uv + offset * texelSize;
            vec4 cellSample = texture(u_state, sampleUV);
            float sampleType = getCellType(cellSample);
            
            if (sampleType == targetType) {
                // Use sub-cell position for smoother distance calculation
                vec2 cellCenter = offset + vec2(0.5) - cellFrac;
                float dist = length(cellCenter) / scale;  // Scale affects distance
                if (dist < minDist) dist = minDist; // Stronger center
                density += 1.0 / (dist * dist);
            }
        }
    }
    return density;
}

// Calculate "density" of a cell type in a radius - creates metaball effect
float calcDensity(vec2 uv, float targetType) {
    return calcDensityHQ(uv, targetType);
}

// Calculate factory density with build status info for a specific player
// Returns vec3(builtDensity, unbuiltDensity, averageBuildProgress)
vec3 calcFactoryDensityForPlayer(vec2 uv, float targetPlayer) {
    vec2 texelSize = 1.0 / u_resolution;
    float builtDensity = 0.0;
    float unbuiltDensity = 0.0;
    float totalBuildProgress = 0.0;
    float totalUnbuiltWeight = 0.0;
    
    // Sub-cell position for smoother distance
    vec2 gridPos = uv * u_resolution;
    vec2 cellFrac = fract(gridPos);
    
    float scale = max(0.1, u_metaballScale);
    float minDist = 0.3 / scale;
    
    for (int dy = -2; dy <= 2; dy++) {
        for (int dx = -2; dx <= 2; dx++) {
            vec2 offset = vec2(float(dx), float(dy));
            vec4 cellSample = texture(u_state, uv + offset * texelSize);
            
            if (isMiningFactory(cellSample) && getPlayerFromCell(cellSample) == targetPlayer) {
                vec2 cellCenter = offset + vec2(0.5) - cellFrac;
                float dist = length(cellCenter) / scale;
                if (dist < minDist) dist = minDist;
                float weight = 1.0 / (dist * dist);
                
                // Check if this factory is built or unbuilt
                vec2 center = getFactoryPosition(cellSample);
                float totalProgress = sumFactoryBuildProgress(center, u_state, u_resolution);
                
                if (totalProgress >= BUILD_THRESHOLD) {
                    builtDensity += weight;
                } else {
                    unbuiltDensity += weight;
                    float progress = totalProgress / BUILD_THRESHOLD;
                    totalBuildProgress += progress * weight;
                    totalUnbuiltWeight += weight;
                }
            }
        }
    }
    
    float avgProgress = totalUnbuiltWeight > 0.0 ? totalBuildProgress / totalUnbuiltWeight : 0.0;
    return vec3(builtDensity, unbuiltDensity, avgProgress);
}

// Legacy function for backward compatibility - calculates combined density for both players
vec3 calcFactoryDensityWithStatus(vec2 uv) {
    vec3 p1 = calcFactoryDensityForPlayer(uv, PLAYER_1);
    vec3 p2 = calcFactoryDensityForPlayer(uv, PLAYER_2);
    return vec3(p1.x + p2.x, p1.y + p2.y, max(p1.z, p2.z));
}

// Calculate unit density with holding info and age for a specific player
// Returns vec3(emptyDensity, holdingDensity, weightedAge)
vec3 calcUnitDensityForPlayer(vec2 uv, float targetPlayer) {
    vec2 texelSize = 1.0 / u_resolution;
    float emptyDensity = 0.0;
    float holdingDensity = 0.0;
    float totalWeight = 0.0;
    float weightedAge = 0.0;
    
    // Sub-cell position for smoother distance
    vec2 gridPos = uv * u_resolution;
    vec2 cellFrac = fract(gridPos);
    
    float scale = max(0.1, u_metaballScale);
    float minDist = 0.3 / scale;
    
    // Larger 9x9 sampling area for units (they're often several pixels apart)
    for (int dy = -4; dy <= 4; dy++) {
        for (int dx = -4; dx <= 4; dx++) {
            vec2 offset = vec2(float(dx), float(dy));
            vec4 cellSample = texture(u_state, uv + offset * texelSize);
            
            if (isMiningUnit(cellSample) && getPlayerFromCell(cellSample) == targetPlayer) {
                // Use sub-cell position for smoother distance
                vec2 cellCenter = offset + vec2(0.5) - cellFrac;
                float dist = length(cellCenter) / scale;
                if (dist < minDist) dist = minDist;
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

// Legacy function for backward compatibility
vec3 calcUnitDensityWithAge(vec2 uv) {
    vec3 p1 = calcUnitDensityForPlayer(uv, PLAYER_1);
    vec3 p2 = calcUnitDensityForPlayer(uv, PLAYER_2);
    return vec3(p1.x + p2.x, p1.y + p2.y, max(p1.z, p2.z));
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
    
    // Calculate densities for each type - separated by player
    float resourceDensity = calcDensity(v_uv, CELL_RESOURCE);
    
    // Player 1 factories (purple)
    vec3 p1FactoryInfo = calcFactoryDensityForPlayer(v_uv, PLAYER_1);
    float p1BuiltFactoryDensity = p1FactoryInfo.x;
    float p1UnbuiltFactoryDensity = p1FactoryInfo.y;
    float p1BuildProgress = p1FactoryInfo.z;
    
    // Player 2 factories (green)
    vec3 p2FactoryInfo = calcFactoryDensityForPlayer(v_uv, PLAYER_2);
    float p2BuiltFactoryDensity = p2FactoryInfo.x;
    float p2UnbuiltFactoryDensity = p2FactoryInfo.y;
    float p2BuildProgress = p2FactoryInfo.z;
    
    // Combined factory densities for compatibility
    float builtFactoryDensity = p1BuiltFactoryDensity + p2BuiltFactoryDensity;
    float unbuiltFactoryDensity = p1UnbuiltFactoryDensity + p2UnbuiltFactoryDensity;
    float buildProgress = max(p1BuildProgress, p2BuildProgress);
    
    // Player 1 units (cyan/green)
    vec3 p1UnitInfo = calcUnitDensityForPlayer(v_uv, PLAYER_1);
    float p1EmptyUnitDensity = p1UnitInfo.x;
    float p1HoldingUnitDensity = p1UnitInfo.y;
    float p1AvgAge = p1UnitInfo.z;
    
    // Player 2 units (orange/red)
    vec3 p2UnitInfo = calcUnitDensityForPlayer(v_uv, PLAYER_2);
    float p2EmptyUnitDensity = p2UnitInfo.x;
    float p2HoldingUnitDensity = p2UnitInfo.y;
    float p2AvgAge = p2UnitInfo.z;
    
    // Combined for compatibility
    float emptyUnitDensity = p1EmptyUnitDensity + p2EmptyUnitDensity;
    float holdingUnitDensity = p1HoldingUnitDensity + p2HoldingUnitDensity;
    float avgAge = max(p1AvgAge, p2AvgAge);
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
    
    // Mining units - different colors per player, with age-based fading
    float fadeStart = 0.3;  // Start fading at 30% age
    float deathFlashStart = 0.9;  // Flash starts at 90% age
    
    // Player 1 units - cyan (empty) or green (holding)
    float p1TotalUnitDensity = p1EmptyUnitDensity + p1HoldingUnitDensity;
    if (p1TotalUnitDensity > unitThreshold * 0.3) {
        float p1AgeRatio = p1AvgAge / MAX_AGE;
        float ageBrightness = 1.0;
        vec3 ageColorMod = vec3(1.0);
        
        if (p1AgeRatio >= fadeStart && p1AgeRatio < deathFlashStart) {
            float fadeFactor = (p1AgeRatio - fadeStart) / (deathFlashStart - fadeStart);
            ageBrightness = 1.0 - fadeFactor * 0.7;
        } else if (p1AgeRatio >= deathFlashStart) {
            float deathProgress = (p1AgeRatio - deathFlashStart) / (1.0 - deathFlashStart);
            if (deathProgress < 0.3) {
                float flashIntensity = deathProgress / 0.3;
                ageColorMod = mix(vec3(0.3), vec3(3.0), flashIntensity);
            } else {
                float fadeOut = (deathProgress - 0.3) / 0.7;
                ageBrightness = mix(1.5, 0.1, fadeOut);
            }
        }
        
        float holdingRatio = p1HoldingUnitDensity / max(p1TotalUnitDensity, 0.001);
        float glowStrength = smoothstep(0.0, unitThreshold, p1TotalUnitDensity);
        vec3 glowColor = mix(vec3(0.05, 0.25, 0.4), vec3(0.1, 0.35, 0.1), holdingRatio);
        glowColor *= ageBrightness * ageColorMod;
        color = color + glowColor * glowStrength * 0.6;
        
        if (p1TotalUnitDensity > unitThreshold) {
            float blobStrength = smoothstep(unitThreshold, unitThreshold + 1.5, p1TotalUnitDensity);
            vec3 cyanColor = vec3(0.3, 0.8, 1.0) * ageBrightness * ageColorMod;
            vec3 greenColor = vec3(0.4, 0.95, 0.4) * ageBrightness * ageColorMod;
            vec3 unitColor = mix(cyanColor, greenColor, holdingRatio);
            float coreGlow = smoothstep(unitThreshold + 1.0, unitThreshold + 4.0, p1TotalUnitDensity);
            unitColor += vec3(0.2) * coreGlow * ageBrightness;
            color = mix(color, unitColor, blobStrength);
        }
    }
    
    // Player 2 units - orange (empty) or red (holding)
    float p2TotalUnitDensity = p2EmptyUnitDensity + p2HoldingUnitDensity;
    if (p2TotalUnitDensity > unitThreshold * 0.3) {
        float p2AgeRatio = p2AvgAge / MAX_AGE;
        float ageBrightness = 1.0;
        vec3 ageColorMod = vec3(1.0);
        
        if (p2AgeRatio >= fadeStart && p2AgeRatio < deathFlashStart) {
            float fadeFactor = (p2AgeRatio - fadeStart) / (deathFlashStart - fadeStart);
            ageBrightness = 1.0 - fadeFactor * 0.7;
        } else if (p2AgeRatio >= deathFlashStart) {
            float deathProgress = (p2AgeRatio - deathFlashStart) / (1.0 - deathFlashStart);
            if (deathProgress < 0.3) {
                float flashIntensity = deathProgress / 0.3;
                ageColorMod = mix(vec3(0.3), vec3(3.0), flashIntensity);
            } else {
                float fadeOut = (deathProgress - 0.3) / 0.7;
                ageBrightness = mix(1.5, 0.1, fadeOut);
            }
        }
        
        float holdingRatio = p2HoldingUnitDensity / max(p2TotalUnitDensity, 0.001);
        float glowStrength = smoothstep(0.0, unitThreshold, p2TotalUnitDensity);
        // Orange/red glow for player 2
        vec3 glowColor = mix(vec3(0.4, 0.2, 0.05), vec3(0.35, 0.1, 0.1), holdingRatio);
        glowColor *= ageBrightness * ageColorMod;
        color = color + glowColor * glowStrength * 0.6;
        
        if (p2TotalUnitDensity > unitThreshold) {
            float blobStrength = smoothstep(unitThreshold, unitThreshold + 1.5, p2TotalUnitDensity);
            // Orange (empty) to red (holding) for player 2
            vec3 orangeColor = vec3(1.0, 0.6, 0.2) * ageBrightness * ageColorMod;
            vec3 redColor = vec3(0.95, 0.3, 0.3) * ageBrightness * ageColorMod;
            vec3 unitColor = mix(orangeColor, redColor, holdingRatio);
            float coreGlow = smoothstep(unitThreshold + 1.0, unitThreshold + 4.0, p2TotalUnitDensity);
            unitColor += vec3(0.2) * coreGlow * ageBrightness;
            color = mix(color, unitColor, blobStrength);
        }
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
    
    // Player 1 Built Factory - purple/magenta blob with energy glow
    if (p1BuiltFactoryDensity > factoryThreshold) {
        float blobStrength = smoothstep(factoryThreshold, factoryThreshold + 1.5, p1BuiltFactoryDensity);
        
        vec4 centerCell = texture(u_state, v_uv);
        float resources = 0.0;
        if (isMiningFactory(centerCell) && isPlayer1(centerCell)) {
            resources = getFactoryResourceCount(centerCell);
        }
        float energyLevel = min(resources / 10.0, 1.0);
        
        vec3 purpleDark = vec3(0.4, 0.1, 0.5);
        vec3 purpleBright = vec3(0.8, 0.3, 1.0);
        vec3 factoryColor = mix(purpleDark, purpleBright, 0.3 + energyLevel * 0.7);
        
        float coreGlow = smoothstep(factoryThreshold, factoryThreshold + 2.0, p1BuiltFactoryDensity);
        factoryColor += vec3(0.2, 0.1, 0.3) * coreGlow * energyLevel;
        
        if (energyLevel > 0.3) {
            float pulse = sin(u_time * 4.0) * 0.5 + 0.5;
            factoryColor += vec3(1.0, 0.5, 1.0) * pulse * energyLevel * 0.3;
            float sparkle = fract(sin(dot(pixelPos + u_time * 10.0, vec2(12.9898, 78.233))) * 43758.5453);
            if (sparkle > 0.95 && energyLevel > 0.5) {
                factoryColor += vec3(0.5, 0.3, 0.6);
            }
        }
        color = mix(color, factoryColor, blobStrength);
    }
    
    // Player 2 Built Factory - green/teal blob with energy glow
    if (p2BuiltFactoryDensity > factoryThreshold) {
        float blobStrength = smoothstep(factoryThreshold, factoryThreshold + 1.5, p2BuiltFactoryDensity);
        
        vec4 centerCell = texture(u_state, v_uv);
        float resources = 0.0;
        if (isMiningFactory(centerCell) && isPlayer2(centerCell)) {
            resources = getFactoryResourceCount(centerCell);
        }
        float energyLevel = min(resources / 10.0, 1.0);
        
        vec3 greenDark = vec3(0.1, 0.4, 0.3);
        vec3 greenBright = vec3(0.3, 0.9, 0.5);
        vec3 factoryColor = mix(greenDark, greenBright, 0.3 + energyLevel * 0.7);
        
        float coreGlow = smoothstep(factoryThreshold, factoryThreshold + 2.0, p2BuiltFactoryDensity);
        factoryColor += vec3(0.1, 0.3, 0.2) * coreGlow * energyLevel;
        
        if (energyLevel > 0.3) {
            float pulse = sin(u_time * 4.0) * 0.5 + 0.5;
            factoryColor += vec3(0.4, 1.0, 0.6) * pulse * energyLevel * 0.3;
            float sparkle = fract(sin(dot(pixelPos + u_time * 10.0, vec2(12.9898, 78.233))) * 43758.5453);
            if (sparkle > 0.95 && energyLevel > 0.5) {
                factoryColor += vec3(0.3, 0.6, 0.4);
            }
        }
        color = mix(color, factoryColor, blobStrength);
    }
    
    // Player 1 Unbuilt Factory - grayish/dim purple
    if (p1UnbuiltFactoryDensity > factoryThreshold) {
        float blobStrength = smoothstep(factoryThreshold, factoryThreshold + 1.5, p1UnbuiltFactoryDensity);
        
        vec3 grayColor = vec3(0.25, 0.22, 0.28);
        vec3 purpleColor = vec3(0.5, 0.2, 0.6);
        vec3 unbuiltColor = mix(grayColor, purpleColor, p1BuildProgress);
        
        float constructPulse = sin(u_time * 2.0) * 0.5 + 0.5;
        unbuiltColor += vec3(0.05, 0.02, 0.08) * constructPulse;
        float grid = step(0.5, fract(pixelPos.x * 0.5)) * step(0.5, fract(pixelPos.y * 0.5));
        unbuiltColor *= 0.9 + grid * 0.1;
        
        color = mix(color, unbuiltColor, blobStrength);
    }
    
    // Player 2 Unbuilt Factory - grayish/dim green
    if (p2UnbuiltFactoryDensity > factoryThreshold) {
        float blobStrength = smoothstep(factoryThreshold, factoryThreshold + 1.5, p2UnbuiltFactoryDensity);
        
        vec3 grayColor = vec3(0.22, 0.25, 0.23);
        vec3 greenColor = vec3(0.2, 0.5, 0.3);
        vec3 unbuiltColor = mix(grayColor, greenColor, p2BuildProgress);
        
        float constructPulse = sin(u_time * 2.0) * 0.5 + 0.5;
        unbuiltColor += vec3(0.02, 0.08, 0.04) * constructPulse;
        float grid = step(0.5, fract(pixelPos.x * 0.5)) * step(0.5, fract(pixelPos.y * 0.5));
        unbuiltColor *= 0.9 + grid * 0.1;
        
        color = mix(color, unbuiltColor, blobStrength);
    }
    
    // Demolish cells - red/orange warning color with flashing
    float demolishDensity = calcDensity(v_uv, CELL_DEMOLISH);
    if (demolishDensity > factoryThreshold) {
        float blobStrength = smoothstep(factoryThreshold, factoryThreshold + 1.5, demolishDensity);
        
        // Flashing red/orange warning
        float flash = sin(u_time * 6.0) * 0.5 + 0.5;
        vec3 redColor = vec3(0.8, 0.2, 0.1);
        vec3 orangeColor = vec3(1.0, 0.5, 0.1);
        vec3 demolishColor = mix(redColor, orangeColor, flash);
        
        // Add some destruction particles
        float sparks = fract(sin(dot(pixelPos + u_time * 20.0, vec2(12.9898, 78.233))) * 43758.5453);
        if (sparks > 0.9) {
            demolishColor += vec3(0.5, 0.3, 0.0);
        }
        
        color = mix(color, demolishColor, blobStrength);
    }
    
    // Subtle vignette
    float vignette = 1.0 - length(v_uv - 0.5) * 0.3;
    color *= vignette;
    
    // Slight gamma for nicer colors
    color = pow(color, vec3(0.95));
    
    fragColor = vec4(color, 1.0);
}
