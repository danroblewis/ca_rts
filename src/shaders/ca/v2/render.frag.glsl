#version 300 es
precision highp float;

#include "./core/types.glsl"

// Ring buffer of 8 frame textures for temporal anti-aliasing
// Debug shader only uses u_state0 (current frame), but all are declared
// for compatibility with the render loop
uniform sampler2D u_state0;
uniform sampler2D u_state1;
uniform sampler2D u_state2;
uniform sampler2D u_state3;
uniform sampler2D u_state4;
uniform sampler2D u_state5;
uniform sampler2D u_state6;
uniform sampler2D u_state7;

// Alias for compatibility
#define u_state u_state0

uniform vec2 u_resolution;
uniform vec2 u_canvasResolution;  // Not used but declared for compatibility
uniform float u_metaballScale;    // Not used but declared for compatibility
uniform int u_frameCount;         // Not used but declared for compatibility
uniform float u_temporalBlend;    // Not used but declared for compatibility

// Camera/viewport uniforms for pan and zoom
uniform vec2 u_cameraPos;         // Camera center in grid coordinates
uniform float u_cameraZoom;       // Zoom level (1.0 = full map visible, 2.0 = half map visible)

// UI uniforms (declared for compatibility, not all used in debug shader)
uniform float u_currentPlayer;
uniform float u_isSelecting;
uniform vec2 u_selectionStart;
uniform vec2 u_selectionEnd;
uniform float u_hasActiveSelection;
uniform vec2 u_mousePos;
uniform float u_shiftHeld;
uniform float u_deleteRadius;

in vec2 v_uv;
out vec4 fragColor;

// Transform screen UV (0-1) to world UV (0-1) based on camera position and zoom
vec2 screenToWorldUV(vec2 screenUV) {
    // Convert screen UV to centered coords (-0.5 to 0.5)
    vec2 centered = screenUV - 0.5;
    
    // Scale by zoom (higher zoom = smaller visible area)
    vec2 scaled = centered / u_cameraZoom;
    
    // Offset by camera position (convert camera pos from grid coords to UV)
    vec2 cameraUV = u_cameraPos / u_resolution;
    
    // Final world UV
    return scaled + cameraUV;
}

// Check if world UV is within valid bounds (0-1)
bool isInBounds(vec2 worldUV) {
    return worldUV.x >= 0.0 && worldUV.x <= 1.0 && 
           worldUV.y >= 0.0 && worldUV.y <= 1.0;
}

void main() {
    // Transform screen UV to world UV based on camera position and zoom
    vec2 worldUV = screenToWorldUV(v_uv);
    
    // Check if we're viewing outside the map bounds
    if (!isInBounds(worldUV)) {
        fragColor = vec4(0.02, 0.03, 0.05, 1.0);  // Dark out-of-bounds
        return;
    }
    
    vec4 raw = texture(u_state, worldUV);
    int cellType = getType(raw);
    vec2 pos = floor(worldUV * u_resolution);
    
    vec3 color;
    
    if (cellType == TYPE_EMPTY) {
        color = vec3(0.08, 0.1, 0.14);
    }
    else if (cellType == TYPE_RESOURCE) {
        color = vec3(0.9, 0.7, 0.2);
    }
    else if (isUnit(cellType)) {
        float age = getUnitAge(raw);
        float ageRatio = age / MAX_AGE;  // 0 = fresh, 1 = about to die
        int player = getPlayer(cellType);
        
        vec3 baseColor;
        if (player == PLAYER_1) {
            // Player 1: Purple/magenta theme (matches factories)
            if (getUnitHolding(raw)) {
                baseColor = vec3(0.95, 0.4, 0.8);  // Magenta = carrying
            } else {
                baseColor = vec3(0.6, 0.4, 1.0);  // Purple = searching
            }
        } else {
            // Player 2: Green theme (matches factories)
            if (getUnitHolding(raw)) {
                baseColor = vec3(0.4, 0.95, 0.35);  // Bright green = carrying
            } else {
                baseColor = vec3(0.3, 0.85, 0.7);  // Teal = searching
            }
        }
        
        // Age effect: fade to darker as unit gets older
        float fadeStart = 0.3;  // Start fading at 30% age
        float deathFlashStart = 0.9;  // Flash starts at 90% age
        
        if (ageRatio < fadeStart) {
            // Young and healthy - full brightness
            color = baseColor;
        } else if (ageRatio < deathFlashStart) {
            // Aging - gradually darken
            float fadeFactor = (ageRatio - fadeStart) / (deathFlashStart - fadeStart);
            color = baseColor * (1.0 - fadeFactor * 0.7);  // Fade to 30% brightness
        } else {
            // Death flash - bright white burst then rapid fade
            float deathProgress = (ageRatio - deathFlashStart) / (1.0 - deathFlashStart);
            if (deathProgress < 0.3) {
                // White flash
                float flashIntensity = deathProgress / 0.3;
                color = mix(baseColor * 0.3, vec3(1.0, 1.0, 1.0), flashIntensity);
            } else {
                // Rapid fade out
                float fadeOut = (deathProgress - 0.3) / 0.7;
                color = mix(vec3(1.0, 1.0, 1.0), vec3(0.05), fadeOut);
            }
        }
    }
    else if (isFactory(cellType)) {
        // Check if factory is built or unbuilt
        vec2 factoryCenter = getFactoryPos(raw);
        float totalBuildProgress = sumFactoryBuildProgress(factoryCenter, u_state, u_resolution);
        bool isBuilt = totalBuildProgress >= BUILD_THRESHOLD;
        int player = getPlayer(cellType);
        
        // Player 1 = purple, Player 2 = green
        vec3 builtColor = (player == PLAYER_1) ? vec3(0.7, 0.2, 0.8) : vec3(0.2, 0.8, 0.4);
        vec3 unbuiltColor = (player == PLAYER_1) ? vec3(0.5, 0.2, 0.7) : vec3(0.2, 0.6, 0.3);
        
        if (isBuilt) {
            // Built factory - bright color
            float brightness = 0.5 + min(getFactoryResources(raw) / 10.0, 0.5);
            color = builtColor * brightness;
        } else {
            // Unbuilt factory - dimmer, show build progress
            float buildProgress = getFactoryBuildProgress(raw);
            float progress = buildProgress / MAX_BUILD_PER_CELL;  // 0-1 for this cell
            
            // Dimmer color that gets brighter as it's built
            float baseBrightness = 0.2;
            float maxBrightness = 0.6;
            float brightness = baseBrightness + progress * (maxBrightness - baseBrightness);
            
            // Pulsing effect to show it's unbuilt
            float pulse = 0.8 + 0.2 * sin(factoryCenter.x * 0.5 + factoryCenter.y * 0.5);
            
            color = unbuiltColor * brightness * pulse;
        }
    }
    else if (cellType == TYPE_WALL) {
        color = vec3(0.35, 0.35, 0.4);  // Gray wall
    }
    else if (cellType == TYPE_DEMOLISH) {
        // Demolish marker - red/orange to indicate marked for destruction
        vec2 demolishCenter = getDemolishCenter(raw);
        float pulse = 0.7 + 0.3 * sin(demolishCenter.x * 0.3 + demolishCenter.y * 0.3);
        color = vec3(0.9, 0.3, 0.2) * 0.6 * pulse;  // Red-orange, pulsing
    }
    else {
        color = vec3(1.0, 0.0, 0.0);  // Red = unknown
    }
    
    fragColor = vec4(color, 1.0);
}
