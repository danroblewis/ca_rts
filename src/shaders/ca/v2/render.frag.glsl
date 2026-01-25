#version 300 es
precision highp float;

#include "./core/types.glsl"

uniform sampler2D u_state;
uniform vec2 u_resolution;

in vec2 v_uv;
out vec4 fragColor;

void main() {
    vec4 raw = texture(u_state, v_uv);
    int cellType = getType(raw);
    vec2 pos = floor(v_uv * u_resolution);
    
    vec3 color;
    
    if (cellType == TYPE_EMPTY) {
        color = vec3(0.08, 0.1, 0.14);
    }
    else if (cellType == TYPE_RESOURCE) {
        color = vec3(0.9, 0.7, 0.2);
    }
    else if (cellType == TYPE_UNIT) {
        float age = getUnitAge(raw);
        float ageRatio = age / MAX_AGE;  // 0 = fresh, 1 = about to die
        
        vec3 baseColor;
        if (getUnitHolding(raw)) {
            baseColor = vec3(0.3, 0.9, 0.4);  // Green = carrying
        } else {
            baseColor = vec3(0.2, 0.7, 0.9);  // Cyan = searching
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
    else if (cellType == TYPE_FACTORY) {
        // Check if factory is built or unbuilt
        vec2 factoryCenter = getFactoryPos(raw);
        float totalBuildProgress = sumFactoryBuildProgress(factoryCenter, u_state, u_resolution);
        bool isBuilt = totalBuildProgress >= BUILD_THRESHOLD;
        
        if (isBuilt) {
            // Built factory - bright purple
            float brightness = 0.5 + min(getFactoryResources(raw) / 10.0, 0.5);
            color = vec3(0.7, 0.2, 0.8) * brightness;
        } else {
            // Unbuilt factory - dimmer, show build progress
            float buildProgress = getFactoryBuildProgress(raw);
            float progress = buildProgress / MAX_BUILD_PER_CELL;  // 0-1 for this cell
            
            // Dimmer purple that gets brighter as it's built
            float baseBrightness = 0.2;
            float maxBrightness = 0.6;
            float brightness = baseBrightness + progress * (maxBrightness - baseBrightness);
            
            // Pulsing effect to show it's unbuilt
            float pulse = 0.8 + 0.2 * sin(factoryCenter.x * 0.5 + factoryCenter.y * 0.5);
            
            color = vec3(0.5, 0.2, 0.7) * brightness * pulse;  // Purple-ish, dimmer
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
