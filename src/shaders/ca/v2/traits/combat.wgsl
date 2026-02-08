// Combat Trait - Unit vs Unit fighting
//
// When two enemy units are adjacent, they fight.
// Combat uses a coin flip to determine who takes damage.
// Damage is applied as aging (pushing unit closer to death).

#include "../core/types.wgsl"
#include "../core/traits.wgsl"
#include "../core/random.wgsl"

// Combat damage (age increase when losing a fight)
// With MAX_AGE=500, this means ~3-4 lost fights to die
const COMBAT_DAMAGE: f32 = 150.0;

// ============================================================================
// Combat Result
// ============================================================================

struct CombatResult {
    inCombat: bool,        // Am I adjacent to an enemy unit?
    tookDamage: bool,      // Did I lose the coin flip and take damage?
    damageAmount: f32,     // How much age to add
    enemyPos: vec2f,       // Position of the enemy I'm fighting
};

// ============================================================================
// THE CANONICAL COMBAT EVALUATION
//
// A unit adjacent to an enemy unit will fight.
// Combat is resolved with a coin flip based on both positions.
// The loser takes damage (their age increases).
// ============================================================================

fn evaluateCombat(myPos: vec2f, time: f32, state: texture_2d<f32>, resolution: vec2f) -> CombatResult {
    var result: CombatResult;
    result.inCombat = false;
    result.tookDamage = false;
    result.damageAmount = 0.0;
    result.enemyPos = vec2f(-1.0);

    let myRaw: vec4f = textureLoad(state, vec2i(myPos), 0);
    let myType: i32 = getType(myRaw);

    // Only units fight
    if (!isUnit(myType)) {
        return result;
    }

    let myPlayer: i32 = getPlayer(myType);

    // Check all 8 neighbors (cardinal + diagonal) for enemy units
    for (var d: i32 = 1; d <= 8; d++) {
        let neighborPos: vec2f = myPos + dirToOffset(d);
        let neighborRaw: vec4f = textureLoad(state, vec2i(neighborPos), 0);
        let neighborType: i32 = getType(neighborRaw);

        // Is this an enemy unit?
        if (isUnit(neighborType)) {
            let enemyPlayer: i32 = getPlayer(neighborType);
            if (enemyPlayer != myPlayer) {
                result.inCombat = true;
                result.enemyPos = neighborPos;

                // Coin flip: use hash of combined positions + time
                // We need consistent results for both cells, so use sorted coordinates
                let minPos: vec2f = min(myPos, neighborPos);
                let maxPos: vec2f = max(myPos, neighborPos);

                // Create a combined position for hashing that's consistent for both cells
                let combatPos: vec2f = minPos + maxPos * 256.0;
                let coinFlip: f32 = hash(combatPos, time);

                // Coin flip: < 0.5 means lower-position wins
                let lowerWins: bool = coinFlip < 0.5;

                // Determine if we are the "lower position" (deterministic ordering)
                let iAmLowerPos: bool = (myPos.x + myPos.y * 256.0) < (neighborPos.x + neighborPos.y * 256.0);

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
