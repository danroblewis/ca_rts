#version 300 es
precision highp float;

#include "common/cell_types.glsl"

// ============================================================================
// CONFIGURATION
// ============================================================================

// Number of previous frames to sample for temporal anti-aliasing (1-8)
// Higher = smoother motion blur but more GPU cost
// Only affects moving units (static elements always use current frame only)
#define TEMPORAL_FRAME_COUNT 4

// Kernel sizes for density sampling (radius, so 2 = 5x5, 3 = 7x7, 4 = 9x9)
#define STATIC_KERNEL_RADIUS 2      // For resources, walls, factories (5x5)
#define UNIT_KERNEL_RADIUS 2        // For units - current frame (5x5)
#define UNIT_TEMPORAL_KERNEL_RADIUS 2  // For units - older frames (5x5)

// Temporal trail smoothing - higher = smoother/wider trails, lower = tighter
#define TEMPORAL_BLUR_SIGMA 0.8

// ============================================================================
// UNIFORMS
// ============================================================================

// Ring buffer of 8 frame textures for temporal anti-aliasing
// u_state0 = newest (current), u_state7 = oldest
uniform sampler2D u_state0;
uniform sampler2D u_state1;
uniform sampler2D u_state2;
uniform sampler2D u_state3;
uniform sampler2D u_state4;
uniform sampler2D u_state5;
uniform sampler2D u_state6;
uniform sampler2D u_state7;

// Alias for compatibility - u_state points to current frame
#define u_state u_state0

uniform vec2 u_resolution;       // Grid resolution (e.g., 256x256)
uniform vec2 u_canvasResolution; // Canvas resolution (e.g., 1920x1080)
uniform float u_time;
uniform float u_metaballScale;   // Scale factor for metaball effect (0.5 = tighter, 2.0 = blobbier)
uniform int u_frameCount;        // Number of frames to blend (1-8, default 8)
uniform float u_temporalBlend;   // Temporal blend strength (0 = no blend, 1 = full blend)

// Selection system
// Selection is now stored directly in unit data (G channel bit 5), no separate texture needed
uniform float u_currentPlayer;   // Current player (1.0 or 2.0) - only their selected units are shown

// Selection UI (rendered in shader instead of DOM)
uniform float u_isSelecting;     // 1.0 if currently dragging a selection box
uniform vec2 u_selectionStart;   // Selection box start corner (UV coords, 0-1)
uniform vec2 u_selectionEnd;     // Selection box end corner (UV coords, 0-1)
uniform float u_hasActiveSelection; // 1.0 if there's an active selection awaiting command
uniform vec2 u_commandPos;       // Command indicator position (UV coords, 0-1)

// Sample from a specific frame by index
vec4 sampleFrame(int frame, vec2 uv) {
    if (frame == 0) return texture(u_state0, uv);
    if (frame == 1) return texture(u_state1, uv);
    if (frame == 2) return texture(u_state2, uv);
    if (frame == 3) return texture(u_state3, uv);
    if (frame == 4) return texture(u_state4, uv);
    if (frame == 5) return texture(u_state5, uv);
    if (frame == 6) return texture(u_state6, uv);
    return texture(u_state7, uv);
}

// Temporal weight for a frame (exponential decay)
// Frame 0 (newest) = 1.0, older frames decay
float temporalWeight(int frame) {
    return pow(0.7, float(frame));
}

in vec2 v_uv;
out vec4 fragColor;

// ============================================================================
// UNIFIED DENSITY CALCULATION
// ============================================================================
// Instead of sampling the neighborhood multiple times (once per cell type),
// we sample ONCE and accumulate all densities in a single pass.
// This reduces texture samples from ~125 to ~25 for static elements.

struct AllDensities {
    // Static elements (current frame only)
    float resourceDens;
    float wallDens;
    float demolishDens;
    
    // Player 1 factories
    float p1FactoryBuilt;
    float p1FactoryUnbuilt;
    float p1BuildProgress;
    float p1UnbuiltWeight;
    
    // Player 2 factories  
    float p2FactoryBuilt;
    float p2FactoryUnbuilt;
    float p2BuildProgress;
    float p2UnbuiltWeight;
};

// Calculate all static densities in a single pass (one texture sample per cell)
AllDensities calcAllStaticDensities(vec2 uv) {
    AllDensities d;
    d.resourceDens = 0.0;
    d.wallDens = 0.0;
    d.demolishDens = 0.0;
    d.p1FactoryBuilt = 0.0;
    d.p1FactoryUnbuilt = 0.0;
    d.p1BuildProgress = 0.0;
    d.p1UnbuiltWeight = 0.0;
    d.p2FactoryBuilt = 0.0;
    d.p2FactoryUnbuilt = 0.0;
    d.p2BuildProgress = 0.0;
    d.p2UnbuiltWeight = 0.0;
    
    vec2 texelSize = 1.0 / u_resolution;
    vec2 gridPos = uv * u_resolution;
    vec2 cellFrac = fract(gridPos);
    
    float scale = max(0.1, u_metaballScale);
    float minDist = 0.3 / scale;
    
    // Single pass over the neighborhood
    for (int dy = -STATIC_KERNEL_RADIUS; dy <= STATIC_KERNEL_RADIUS; dy++) {
        for (int dx = -STATIC_KERNEL_RADIUS; dx <= STATIC_KERNEL_RADIUS; dx++) {
            vec2 offset = vec2(float(dx), float(dy));
            vec2 sampleUV = uv + offset * texelSize;
            vec4 cellSample = texture(u_state, sampleUV);
            
            // Calculate weight based on distance
            vec2 cellCenter = offset + vec2(0.5) - cellFrac;
            float dist = length(cellCenter) / scale;
            if (dist < minDist) dist = minDist;
            float weight = 1.0 / (dist * dist);
            
            // Accumulate densities based on cell type
            float cellType = getCellType(cellSample);
            
            if (cellType == CELL_RESOURCE) {
                d.resourceDens += weight;
            }
            else if (cellType == CELL_WALL) {
                d.wallDens += weight;
            }
            else if (cellType == CELL_DEMOLISH) {
                d.demolishDens += weight;
            }
            else if (isMiningFactory(cellSample)) {
                float player = getPlayerFromCell(cellSample);
                vec2 center = getFactoryPosition(cellSample);
                float totalProgress = sumFactoryBuildProgress(center, u_state, u_resolution);
                bool isBuilt = totalProgress >= BUILD_THRESHOLD;
                
                if (player == PLAYER_1) {
                    if (isBuilt) {
                        d.p1FactoryBuilt += weight;
                    } else {
                        d.p1FactoryUnbuilt += weight;
                        d.p1BuildProgress += (totalProgress / BUILD_THRESHOLD) * weight;
                        d.p1UnbuiltWeight += weight;
                    }
                } else {
                    if (isBuilt) {
                        d.p2FactoryBuilt += weight;
                    } else {
                        d.p2FactoryUnbuilt += weight;
                        d.p2BuildProgress += (totalProgress / BUILD_THRESHOLD) * weight;
                        d.p2UnbuiltWeight += weight;
                    }
                }
            }
        }
    }
    
    return d;
}

// Legacy function for single cell type density (still used for some cases)
float calcDensityHQ(vec2 uv, float targetType) {
    vec2 texelSize = 1.0 / u_resolution;
    float density = 0.0;
    
    vec2 gridPos = uv * u_resolution;
    vec2 cellFrac = fract(gridPos);
    
    float scale = max(0.1, u_metaballScale);
    float minDist = 0.3 / scale;
    
    for (int dy = -STATIC_KERNEL_RADIUS; dy <= STATIC_KERNEL_RADIUS; dy++) {
        for (int dx = -STATIC_KERNEL_RADIUS; dx <= STATIC_KERNEL_RADIUS; dx++) {
            vec2 offset = vec2(float(dx), float(dy));
            vec2 sampleUV = uv + offset * texelSize;
            vec4 cellSample = texture(u_state, sampleUV);
            float sampleType = getCellType(cellSample);
            
            if (sampleType == targetType) {
                vec2 cellCenter = offset + vec2(0.5) - cellFrac;
                float dist = length(cellCenter) / scale;
                if (dist < minDist) dist = minDist;
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
// NO temporal blending - factories are static
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
// Uses temporal anti-aliasing for smoother unit motion (units are the only moving entities)
vec3 calcUnitDensityForPlayer(vec2 uv, float targetPlayer) {
    vec2 texelSize = 1.0 / u_resolution;
    float emptyDensity = 0.0;
    float holdingDensity = 0.0;
    float totalWeight = 0.0;
    float weightedAge = 0.0;
    float totalTemporalWeight = 0.0;
    
    // Sub-cell position for smoother distance
    vec2 gridPos = uv * u_resolution;
    vec2 cellFrac = fract(gridPos);
    
    float scale = max(0.1, u_metaballScale);
    float minDist = 0.3 / scale;
    
    // Temporal sampling - use TEMPORAL_FRAME_COUNT frames
    // Frame 0 gets larger kernel, older frames get smaller kernel for speed
    int numFrames = min(clamp(u_frameCount, 1, 8), TEMPORAL_FRAME_COUNT);
    float blendStrength = clamp(u_temporalBlend, 0.0, 1.0);
    
    for (int frame = 0; frame < TEMPORAL_FRAME_COUNT; frame++) {
        if (frame >= numFrames) break;
        
        float frameWeight = (frame == 0) ? 1.0 : temporalWeight(frame) * blendStrength;
        totalTemporalWeight += frameWeight;
        
        // Use configurable kernel sizes
        int kernelSize = (frame == 0) ? UNIT_KERNEL_RADIUS : UNIT_TEMPORAL_KERNEL_RADIUS;
        
        for (int dy = -UNIT_KERNEL_RADIUS; dy <= UNIT_KERNEL_RADIUS; dy++) {
            if (abs(dy) > kernelSize) continue;
            for (int dx = -UNIT_KERNEL_RADIUS; dx <= UNIT_KERNEL_RADIUS; dx++) {
                if (abs(dx) > kernelSize) continue;
                
                vec2 offset = vec2(float(dx), float(dy));
                vec4 cellSample = sampleFrame(frame, uv + offset * texelSize);
                
                if (isMiningUnit(cellSample) && getPlayerFromCell(cellSample) == targetPlayer) {
                    // Use sub-cell position for smoother distance
                    vec2 cellCenter = offset + vec2(0.5) - cellFrac;
                    float dist = length(cellCenter) / scale;
                    if (dist < minDist) dist = minDist;
                    float weight = (1.0 / (dist * dist)) * frameWeight;
                    
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
    }
    
    // Normalize by temporal weights
    float norm = max(totalTemporalWeight, 1.0);
    float avgAge = totalWeight > 0.0 ? weightedAge / totalWeight : 0.0;
    return vec3(emptyDensity / norm, holdingDensity / norm, avgAge);
}

// Legacy function for backward compatibility
vec3 calcUnitDensityWithAge(vec2 uv) {
    vec3 p1 = calcUnitDensityForPlayer(uv, PLAYER_1);
    vec3 p2 = calcUnitDensityForPlayer(uv, PLAYER_2);
    return vec3(p1.x + p2.x, p1.y + p2.y, max(p1.z, p2.z));
}

// ============================================================================
// SELECTION DENSITY CALCULATION
// ============================================================================
// Returns selection density for units of a specific player
// Only samples current frame (frame 0) since selection state is updated per-frame

float calcSelectionDensity(vec2 uv, float targetPlayer) {
    // Only render selection for the current player viewing the game
    if (targetPlayer != u_currentPlayer) return 0.0;
    
    vec2 texelSize = 1.0 / u_resolution;
    float selectionDensity = 0.0;
    
    vec2 gridPos = uv * u_resolution;
    vec2 cellFrac = fract(gridPos);
    
    float scale = max(0.1, u_metaballScale);
    float minDist = 0.3 / scale;
    
    // Sample current frame only for selection
    for (int dy = -UNIT_KERNEL_RADIUS; dy <= UNIT_KERNEL_RADIUS; dy++) {
        for (int dx = -UNIT_KERNEL_RADIUS; dx <= UNIT_KERNEL_RADIUS; dx++) {
            vec2 offset = vec2(float(dx), float(dy));
            vec2 sampleUV = uv + offset * texelSize;
            vec4 cellSample = texture(u_state0, sampleUV);
            
            // Check if this is a unit of the target player
            if (isMiningUnit(cellSample) && getPlayerFromCell(cellSample) == targetPlayer) {
                // Check if this unit is selected (stored in G channel bit 5)
                if (getUnitSelected(cellSample)) {
                    vec2 cellCenter = offset + vec2(0.5) - cellFrac;
                    float dist = length(cellCenter) / scale;
                    if (dist < minDist) dist = minDist;
                    float weight = 1.0 / (dist * dist);
                    selectionDensity += weight;
                }
            }
        }
    }
    
    return selectionDensity;
}

// ============================================
// PROCEDURAL NOISE FUNCTIONS FOR ROCK TEXTURE
// ============================================

// Fast hash functions
float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
}

// Gradient noise (Perlin-like)
float gradientNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    
    // Quintic interpolation for smoother derivatives
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Fractional Brownian Motion - layered noise for rock texture detail
float fbm(vec2 p, int octaves) {
    float value = 0.0;
    float amplitude = 0.5;
    float frequency = 1.0;
    float totalAmplitude = 0.0;
    
    for (int i = 0; i < 6; i++) {
        if (i >= octaves) break;
        value += amplitude * gradientNoise(p * frequency);
        totalAmplitude += amplitude;
        frequency *= 2.0;
        amplitude *= 0.5;
    }
    
    return value / totalAmplitude;
}

// Voronoi noise - creates cell-like patterns for rock cracks and grain
vec3 voronoi(vec2 p) {
    vec2 n = floor(p);
    vec2 f = fract(p);
    
    float minDist = 1.0;
    float secondMinDist = 1.0;
    vec2 minPoint = vec2(0.0);
    
    for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
            vec2 neighbor = vec2(float(i), float(j));
            vec2 point = hash2(n + neighbor);
            vec2 diff = neighbor + point - f;
            float dist = length(diff);
            
            if (dist < minDist) {
                secondMinDist = minDist;
                minDist = dist;
                minPoint = point;
            } else if (dist < secondMinDist) {
                secondMinDist = dist;
            }
        }
    }
    
    // Return: minDist, edge distance (for cracks), cell id
    float edgeDist = secondMinDist - minDist;
    return vec3(minDist, edgeDist, hash(minPoint * 100.0));
}

// Domain warping - distorts coordinates for organic look
vec2 warpDomain(vec2 p, float strength) {
    float n1 = fbm(p, 3);
    float n2 = fbm(p + vec2(5.2, 1.3), 3);
    return p + vec2(n1, n2) * strength;
}

// ============================================
// ROCK TEXTURE GENERATOR
// ============================================
// Combines multiple techniques:
// - Voronoi for crack patterns and granularity
// - FBM for surface variation
// - Domain warping for organic irregularity
// - Edge distortion for rough rock outlines

struct RockTexture {
    float brightness;    // Overall brightness/value
    float roughness;     // Surface roughness (for edge treatment)
    float cracks;        // Crack intensity
    float grain;         // Fine grain detail
};

RockTexture calcRockTexture(vec2 uv, float scale) {
    RockTexture rock;
    
    // Warp the domain for organic shape
    vec2 warpedUV = warpDomain(uv * scale, 0.3);
    
    // Large-scale Voronoi for major rock structure
    vec3 vor1 = voronoi(warpedUV * 2.0);
    
    // Medium-scale Voronoi for grain
    vec3 vor2 = voronoi(warpedUV * 6.0);
    
    // Fine FBM for surface detail
    float detail = fbm(warpedUV * 8.0, 4);
    
    // Combine for brightness - darker in cracks, lighter on faces
    rock.brightness = 0.5 + 0.3 * vor1.x + 0.15 * vor2.x + 0.1 * detail;
    
    // Cracks are where voronoi edges meet (low edge distance)
    rock.cracks = 1.0 - smoothstep(0.0, 0.15, vor1.y);
    
    // Roughness from FBM
    rock.roughness = fbm(warpedUV * 4.0, 3);
    
    // Grain from smaller voronoi
    rock.grain = vor2.z;
    
    return rock;
}

// Calculate rock edge - distorted metaball boundary for natural rock shape
float calcRockEdge(vec2 uv, float baseDensity, float threshold, float scale) {
    // Use noise to distort the threshold, creating irregular edges
    vec2 warpedUV = warpDomain(uv * scale, 0.2);
    float edgeNoise = fbm(warpedUV * 3.0, 3);
    
    // Vary the threshold based on noise - this creates jagged rock edges
    float adjustedThreshold = threshold * (0.85 + edgeNoise * 0.3);
    
    return smoothstep(adjustedThreshold, adjustedThreshold + 1.5, baseDensity);
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
    
    // Calculate ALL static densities in a single pass (massive perf improvement)
    AllDensities d = calcAllStaticDensities(v_uv);
    
    // Extract values from unified calculation
    float resourceDensity = d.resourceDens;
    
    // Player 1 factories (purple)
    float p1BuiltFactoryDensity = d.p1FactoryBuilt;
    float p1UnbuiltFactoryDensity = d.p1FactoryUnbuilt;
    float p1BuildProgress = d.p1UnbuiltWeight > 0.0 ? d.p1BuildProgress / d.p1UnbuiltWeight : 0.0;
    
    // Player 2 factories (green)
    float p2BuiltFactoryDensity = d.p2FactoryBuilt;
    float p2UnbuiltFactoryDensity = d.p2FactoryUnbuilt;
    float p2BuildProgress = d.p2UnbuiltWeight > 0.0 ? d.p2BuildProgress / d.p2UnbuiltWeight : 0.0;
    
    // Combined factory densities for compatibility
    float builtFactoryDensity = p1BuiltFactoryDensity + p2BuiltFactoryDensity;
    float unbuiltFactoryDensity = p1UnbuiltFactoryDensity + p2UnbuiltFactoryDensity;
    float buildProgress = max(p1BuildProgress, p2BuildProgress);
    
    // Player 1 units (purple/magenta)
    vec3 p1UnitInfo = calcUnitDensityForPlayer(v_uv, PLAYER_1);
    float p1EmptyUnitDensity = p1UnitInfo.x;
    float p1HoldingUnitDensity = p1UnitInfo.y;
    float p1AvgAge = p1UnitInfo.z;
    
    // Player 2 units (teal/green)
    vec3 p2UnitInfo = calcUnitDensityForPlayer(v_uv, PLAYER_2);
    float p2EmptyUnitDensity = p2UnitInfo.x;
    float p2HoldingUnitDensity = p2UnitInfo.y;
    float p2AvgAge = p2UnitInfo.z;
    
    // Selection densities (only for current player's units)
    float p1SelectionDensity = calcSelectionDensity(v_uv, PLAYER_1);
    float p2SelectionDensity = calcSelectionDensity(v_uv, PLAYER_2);
    
    // Combined for compatibility
    float emptyUnitDensity = p1EmptyUnitDensity + p2EmptyUnitDensity;
    float holdingUnitDensity = p1HoldingUnitDensity + p2HoldingUnitDensity;
    float avgAge = max(p1AvgAge, p2AvgAge);
    float ageRatio = avgAge / MAX_AGE;  // 0 = fresh, 1 = about to die
    
    // Thresholds for blob effect (lower = more blobby/connected)
    float resourceThreshold = 0.8;
    float unitThreshold = 0.3;  // Low threshold so single units show as blobs
    float factoryThreshold = 1.0;
    
    // Resources - ROCK TEXTURE with procedural detail
    // Use irregular rock edge instead of smooth metaball
    float rockEdge = calcRockEdge(v_uv, resourceDensity, resourceThreshold, 8.0);
    
    if (rockEdge > 0.01) {
        // Calculate rock texture at this pixel
        RockTexture rock = calcRockTexture(v_uv, 12.0);
        
        // Base rock colors - gold/amber ore with stone undertones
        vec3 stoneBase = vec3(0.35, 0.30, 0.22);     // Gray-brown stone
        vec3 oreDark = vec3(0.55, 0.38, 0.12);       // Dark amber
        vec3 oreMid = vec3(0.75, 0.55, 0.18);        // Medium gold
        vec3 oreBright = vec3(0.95, 0.78, 0.28);     // Bright gold highlight
        
        // Mix stone and ore based on grain pattern
        vec3 baseColor = mix(stoneBase, oreDark, rock.grain);
        
        // Add brightness variation from rock texture
        baseColor = mix(baseColor, oreMid, rock.brightness * 0.7);
        
        // Highlights on high points
        float highlight = smoothstep(0.7, 0.9, rock.brightness);
        baseColor = mix(baseColor, oreBright, highlight * 0.5);
        
        // Darken cracks significantly
        baseColor *= 1.0 - rock.cracks * 0.6;
        
        // Add subtle color variation in the cracks (darker, more saturated)
        vec3 crackColor = vec3(0.25, 0.15, 0.05);
        baseColor = mix(baseColor, crackColor, rock.cracks * 0.4);
        
        // Depth shading - darker at edges using the rock edge value
        float depthShade = smoothstep(0.0, 0.5, rockEdge);
        baseColor *= 0.7 + depthShade * 0.3;
        
        // Very subtle inner glow for valuable ore look
        float innerGlow = smoothstep(0.3, 0.8, rockEdge);
        baseColor += vec3(0.08, 0.05, 0.0) * innerGlow;
        
        // Apply with rock edge as alpha (irregular boundary)
        color = mix(color, baseColor, rockEdge);
    }
    
    // Mining units - different colors per player, with age-based fading
    float fadeStart = 0.3;  // Start fading at 30% age
    float deathFlashStart = 0.9;  // Flash starts at 90% age
    
    // Player 1 units - purple/magenta theme (matches their factories)
    float p1TotalUnitDensity = p1EmptyUnitDensity + p1HoldingUnitDensity;
    bool p1IsSelected = p1SelectionDensity > 0.1;  // Check if any selected units here
    if (p1TotalUnitDensity > unitThreshold * 0.3) {
        float p1AgeRatio = p1AvgAge / MAX_AGE;
        float ageBrightness = 1.0;
        vec3 ageColorMod = vec3(1.0);
        float newbornScale = 1.0;  // Size multiplier for newborn units
        
        // Newborn glow effect (negative age)
        if (p1AvgAge < 0.0) {
            float newbornProgress = -p1AvgAge / (-NEWBORN_AGE);  // 1.0 at spawn, 0.0 when mature
            ageBrightness = 1.0 + newbornProgress * 1.5;  // Extra bright
            ageColorMod = vec3(1.0 + newbornProgress * 0.5);  // Whiter
            newbornScale = 1.0 + newbornProgress * 0.5;  // 50% larger at spawn
        } else if (p1AgeRatio >= fadeStart && p1AgeRatio < deathFlashStart) {
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
        
        // Selection effect - make selected units brighter and pulse
        float selectionBrightness = 1.0;
        float selectionPulse = 0.0;
        if (p1IsSelected) {
            selectionBrightness = 1.5;  // 50% brighter
            selectionPulse = sin(u_time * 4.0) * 0.3 + 0.3;  // Gentle pulse
        }
        
        // Apply newborn scale to make newborns appear larger
        float scaledDensity = p1TotalUnitDensity * newbornScale;
        float holdingRatio = p1HoldingUnitDensity / max(p1TotalUnitDensity, 0.001);
        float glowStrength = smoothstep(0.0, unitThreshold, scaledDensity);
        // Purple glow tones matching P1 factory
        vec3 glowColor = mix(vec3(0.25, 0.1, 0.35), vec3(0.4, 0.15, 0.5), holdingRatio);
        glowColor *= ageBrightness * ageColorMod * selectionBrightness;
        color = color + glowColor * glowStrength * 0.6;
        
        if (scaledDensity > unitThreshold) {
            float blobStrength = smoothstep(unitThreshold, unitThreshold + 1.5, scaledDensity);
            // Light purple (empty) to bright magenta (holding) for player 1
            vec3 purpleColor = vec3(0.6, 0.4, 1.0) * ageBrightness * ageColorMod;
            vec3 magentaColor = vec3(0.95, 0.4, 0.8) * ageBrightness * ageColorMod;
            vec3 unitColor = mix(purpleColor, magentaColor, holdingRatio);
            
            // Selection effect - add bright white outline/ring
            if (p1IsSelected) {
                unitColor *= selectionBrightness;
                // Add pulsing white highlight
                unitColor += vec3(1.0, 1.0, 1.0) * selectionPulse;
                // Make selected units slightly larger appearance with outer glow
                float outerRing = smoothstep(unitThreshold * 0.5, unitThreshold, scaledDensity);
                color += vec3(1.0, 0.9, 1.0) * outerRing * 0.4 * (1.0 + selectionPulse);
            }
            
            float coreGlow = smoothstep(unitThreshold + 1.0, unitThreshold + 4.0, scaledDensity);
            unitColor += vec3(0.2) * coreGlow * ageBrightness;
            color = mix(color, unitColor, blobStrength);
        }
    }
    
    // Player 2 units - green theme (matches their factories)
    float p2TotalUnitDensity = p2EmptyUnitDensity + p2HoldingUnitDensity;
    bool p2IsSelected = p2SelectionDensity > 0.1;  // Check if any selected units here
    if (p2TotalUnitDensity > unitThreshold * 0.3) {
        float p2AgeRatio = p2AvgAge / MAX_AGE;
        float ageBrightness = 1.0;
        vec3 ageColorMod = vec3(1.0);
        float newbornScale = 1.0;  // Size multiplier for newborn units
        
        // Newborn glow effect (negative age)
        if (p2AvgAge < 0.0) {
            float newbornProgress = -p2AvgAge / (-NEWBORN_AGE);  // 1.0 at spawn, 0.0 when mature
            ageBrightness = 1.0 + newbornProgress * 1.5;  // Extra bright
            ageColorMod = vec3(1.0 + newbornProgress * 0.5);  // Whiter
            newbornScale = 1.0 + newbornProgress * 0.5;  // 50% larger at spawn
        } else if (p2AgeRatio >= fadeStart && p2AgeRatio < deathFlashStart) {
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
        
        // Selection effect - make selected units brighter and pulse
        float selectionBrightness = 1.0;
        float selectionPulse = 0.0;
        if (p2IsSelected) {
            selectionBrightness = 1.5;  // 50% brighter
            selectionPulse = sin(u_time * 4.0) * 0.3 + 0.3;  // Gentle pulse
        }
        
        // Apply newborn scale to make newborns appear larger
        float scaledDensity = p2TotalUnitDensity * newbornScale;
        float holdingRatio = p2HoldingUnitDensity / max(p2TotalUnitDensity, 0.001);
        float glowStrength = smoothstep(0.0, unitThreshold, scaledDensity);
        // Green glow tones matching P2 factory
        vec3 glowColor = mix(vec3(0.1, 0.3, 0.15), vec3(0.15, 0.4, 0.1), holdingRatio);
        glowColor *= ageBrightness * ageColorMod * selectionBrightness;
        color = color + glowColor * glowStrength * 0.6;
        
        if (scaledDensity > unitThreshold) {
            float blobStrength = smoothstep(unitThreshold, unitThreshold + 1.5, scaledDensity);
            // Teal (empty) to bright green (holding) for player 2
            vec3 tealColor = vec3(0.3, 0.85, 0.7) * ageBrightness * ageColorMod;
            vec3 greenColor = vec3(0.4, 0.95, 0.35) * ageBrightness * ageColorMod;
            vec3 unitColor = mix(tealColor, greenColor, holdingRatio);
            
            // Selection effect - add bright white outline/ring
            if (p2IsSelected) {
                unitColor *= selectionBrightness;
                // Add pulsing white highlight
                unitColor += vec3(1.0, 1.0, 1.0) * selectionPulse;
                // Make selected units slightly larger appearance with outer glow
                float outerRing = smoothstep(unitThreshold * 0.5, unitThreshold, scaledDensity);
                color += vec3(0.9, 1.0, 0.9) * outerRing * 0.4 * (1.0 + selectionPulse);
            }
            
            float coreGlow = smoothstep(unitThreshold + 1.0, unitThreshold + 4.0, scaledDensity);
            unitColor += vec3(0.2) * coreGlow * ageBrightness;
            color = mix(color, unitColor, blobStrength);
        }
    }
    
    // Walls - ROCK TEXTURE stone blocks (using unified density)
    float wallDensity = d.wallDens;
    float wallEdge = calcRockEdge(v_uv, wallDensity, 0.5, 6.0);
    
    if (wallEdge > 0.01) {
        // Calculate rock texture for walls (different scale than ore)
        RockTexture rock = calcRockTexture(v_uv, 8.0);
        
        // Gray stone colors
        vec3 stoneDark = vec3(0.18, 0.18, 0.20);
        vec3 stoneMid = vec3(0.32, 0.32, 0.35);
        vec3 stoneLight = vec3(0.48, 0.48, 0.52);
        
        // Base color from grain
        vec3 wallColor = mix(stoneDark, stoneMid, rock.grain);
        
        // Add brightness variation
        wallColor = mix(wallColor, stoneLight, rock.brightness * 0.5);
        
        // Darken cracks
        wallColor *= 1.0 - rock.cracks * 0.5;
        
        // Crack color (darker gray)
        vec3 crackColor = vec3(0.08, 0.08, 0.10);
        wallColor = mix(wallColor, crackColor, rock.cracks * 0.3);
        
        // Edge darkening
        float depthShade = smoothstep(0.0, 0.4, wallEdge);
        wallColor *= 0.75 + depthShade * 0.25;
        
        color = mix(color, wallColor, wallEdge * 0.95);
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
    
    // Demolish cells - red/orange warning color with flashing (using unified density)
    float demolishDensity = d.demolishDens;
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
    
    // ========================================================================
    // Selection UI Overlay
    // ========================================================================
    
    // Selection box (while dragging)
    if (u_isSelecting > 0.5) {
        vec2 boxMin = min(u_selectionStart, u_selectionEnd);
        vec2 boxMax = max(u_selectionStart, u_selectionEnd);
        
        // Check if we're on the border of the selection box
        float borderWidth = 2.0 / u_canvasResolution.x;  // 2 pixels wide
        
        bool inBox = v_uv.x >= boxMin.x && v_uv.x <= boxMax.x && 
                     v_uv.y >= boxMin.y && v_uv.y <= boxMax.y;
        bool inInnerBox = v_uv.x >= boxMin.x + borderWidth && v_uv.x <= boxMax.x - borderWidth && 
                          v_uv.y >= boxMin.y + borderWidth && v_uv.y <= boxMax.y - borderWidth;
        
        if (inBox) {
            if (!inInnerBox) {
                // Border - white with some transparency
                color = mix(color, vec3(1.0), 0.8);
            } else {
                // Interior - slight tint
                color = mix(color, vec3(1.0), 0.1);
            }
        }
    }
    
    // Command indicator (crosshair at cursor when selection is active)
    if (u_hasActiveSelection > 0.5) {
        vec2 cursorDist = abs(v_uv - u_commandPos);
        float pixelSize = 1.0 / u_canvasResolution.x;
        
        // Crosshair parameters
        float crossSize = 15.0 * pixelSize;    // Size of crosshair arms
        float crossWidth = 2.0 * pixelSize;    // Width of crosshair lines
        float gapSize = 4.0 * pixelSize;       // Gap in center
        
        // Horizontal line
        bool onHorizontal = cursorDist.y < crossWidth && 
                           cursorDist.x > gapSize && cursorDist.x < crossSize;
        // Vertical line
        bool onVertical = cursorDist.x < crossWidth && 
                         cursorDist.y > gapSize && cursorDist.y < crossSize;
        
        if (onHorizontal || onVertical) {
            // Animated pulse
            float pulse = sin(u_time * 4.0) * 0.2 + 0.8;
            vec3 crosshairColor = vec3(1.0, 0.85, 0.3) * pulse;  // Golden yellow
            color = mix(color, crosshairColor, 0.9);
        }
        
        // Center dot
        float centerDist = length(cursorDist);
        if (centerDist < 3.0 * pixelSize) {
            color = vec3(1.0, 0.85, 0.3);  // Golden yellow
        }
    }
    
    // Subtle vignette
    float vignette = 1.0 - length(v_uv - 0.5) * 0.3;
    color *= vignette;
    
    // Slight gamma for nicer colors
    color = pow(color, vec3(0.95));
    
    fragColor = vec4(color, 1.0);
}
