/**
 * Combat Trait - Unit vs Unit fighting
 * 
 * When two enemy units are adjacent, they fight.
 * Combat uses a coin flip to determine who takes damage.
 * Damage is applied as aging (pushing unit closer to death).
 */

#ifndef COMBAT_GLSL
#define COMBAT_GLSL

#include "../core/types.glsl"
#include "../core/traits.glsl"
#include "../core/random.glsl"

// Combat damage (age increase when losing a fight)
// With MAX_AGE=500, this means ~3-4 lost fights to die
const float COMBAT_DAMAGE = 150.0;

// ============================================================================
// Combat Result
// ============================================================================

struct CombatResult {
    bool inCombat;        // Am I adjacent to an enemy unit?
    bool tookDamage;      // Did I lose the coin flip and take damage?
    float damageAmount;   // How much age to add
    vec2 enemyPos;        // Position of the enemy I'm fighting
};

// ============================================================================
// THE CANONICAL COMBAT EVALUATION
// 
// A unit adjacent to an enemy unit will fight.
// Combat is resolved with a coin flip based on both positions.
// The loser takes damage (their age increases).
// ============================================================================

CombatResult evaluateCombat(vec2 myPos, float time, sampler2D state, vec2 resolution) {
    CombatResult result;
    result.inCombat = false;
    result.tookDamage = false;
    result.damageAmount = 0.0;
    result.enemyPos = vec2(-1.0);
    
    vec4 myRaw = texture(state, (myPos + 0.5) / resolution);
    int myType = getType(myRaw);
    
    // Only units fight
    if (!isUnit(myType)) {
        return result;
    }
    
    int myPlayer = getPlayer(myType);
    
    // Check all 8 neighbors (cardinal + diagonal) for enemy units
    for (int d = 1; d <= 8; d++) {
        vec2 neighborPos = myPos + dirToOffset(d);
        vec4 neighborRaw = texture(state, (neighborPos + 0.5) / resolution);
        int neighborType = getType(neighborRaw);
        
        // Is this an enemy unit?
        if (isUnit(neighborType)) {
            int enemyPlayer = getPlayer(neighborType);
            if (enemyPlayer != myPlayer) {
                result.inCombat = true;
                result.enemyPos = neighborPos;
                
                // Coin flip: use hash of combined positions + time
                // We need consistent results for both cells, so use sorted coordinates
                vec2 minPos = min(myPos, neighborPos);
                vec2 maxPos = max(myPos, neighborPos);
                float combatSeed = minPos.x + minPos.y * 256.0 + maxPos.x * 65536.0 + time * 0.01;
                float coinFlip = hash(minPos + maxPos, combatSeed);
                
                // Determine winner: coin flip < 0.5 means lower-position wins
                // We need to know if WE are the lower position
                bool iAmLowerPos = (myPos.x + myPos.y * 256.0) < (neighborPos.x + neighborPos.y * 256.0);
                bool lowerWins = coinFlip < 0.5;
                
                // I take damage if: (I'm lower AND lower loses) OR (I'm higher AND higher loses)
                if ((iAmLowerPos && !lowerWins) || (!iAmLowerPos && lowerWins)) {
                    result.tookDamage = true;
                    result.damageAmount = COMBAT_DAMAGE;
                }
                
                // Only process one combat per frame
                return result;
            }
        }
    }
    
    return result;
}

#endif

