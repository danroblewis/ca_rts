// Attack Trait - THE canonical attack evaluation
//
// Non-holding units adjacent to enemy factories will attack them.
// When attacked, a factory cell is destroyed and the unit picks up a resource.
// This is the SINGLE SOURCE OF TRUTH for attacking.

#include "../core/types.wgsl"
#include "../core/traits.wgsl"

// ============================================================================
// Attack Result
// ============================================================================

struct AttackResult {
    happened: bool,
    unitPos: vec2f,
    factoryPos: vec2f,      // Position of the factory cell being attacked
    attackerPlayer: i32,    // Player who is attacking
    defenderPlayer: i32,    // Player being attacked
};

// ============================================================================
// THE CANONICAL ATTACK EVALUATION
//
// A non-holding unit adjacent to an enemy factory will attack it.
// The factory cell is destroyed and the unit picks up a resource.
// ============================================================================

fn evaluateAttack(myPos: vec2f, state: texture_2d<f32>, resolution: vec2f) -> AttackResult {
    var result: AttackResult;
    result.happened = false;
    result.unitPos = vec2f(-1.0);
    result.factoryPos = vec2f(-1.0);
    result.attackerPlayer = 0;
    result.defenderPlayer = 0;

    let myRaw: vec4f = textureLoad(state, vec2i(myPos), 0);
    let myType: i32 = getType(myRaw);

    // ========================================
    // CASE 1: I'm a non-holding unit - am I attacking an enemy factory?
    // ========================================
    if (isUnit(myType) && !getUnitHolding(myRaw)) {
        let myPlayer: i32 = getPlayer(myType);

        // Check neighbors for enemy factories (all 8 directions)
        for (var d: i32 = 1; d <= 8; d++) {
            let neighborPos: vec2f = myPos + dirToOffset(d);
            let neighborRaw: vec4f = textureLoad(state, vec2i(neighborPos), 0);
            let neighborType: i32 = getType(neighborRaw);

            // Is this an enemy factory?
            if (isFactory(neighborType)) {
                let factoryPlayer: i32 = getPlayer(neighborType);
                if (factoryPlayer != myPlayer) {
                    result.happened = true;
                    result.unitPos = myPos;
                    result.factoryPos = neighborPos;
                    result.attackerPlayer = myPlayer;
                    result.defenderPlayer = factoryPlayer;
                    return result;
                }
            }
        }
    }

    // ========================================
    // CASE 2: I'm a factory - is an enemy unit attacking me?
    // ========================================
    if (isFactory(myType)) {
        let myPlayer: i32 = getPlayer(myType);

        // Check all 8 directions since units can move diagonally
        for (var d: i32 = 1; d <= 8; d++) {
            let neighborPos: vec2f = myPos + dirToOffset(d);
            let neighborRaw: vec4f = textureLoad(state, vec2i(neighborPos), 0);
            let neighborType: i32 = getType(neighborRaw);

            // Is this an enemy unit that's not holding?
            if (isUnit(neighborType) && !getUnitHolding(neighborRaw)) {
                let unitPlayer: i32 = getPlayer(neighborType);
                if (unitPlayer != myPlayer) {
                    result.happened = true;
                    result.unitPos = neighborPos;
                    result.factoryPos = myPos;
                    result.attackerPlayer = unitPlayer;
                    result.defenderPlayer = myPlayer;
                    return result;
                }
            }
        }
    }

    return result;
}

// Count how many enemy units are attacking a specific factory position
fn countAttacks(factoryPos: vec2f, factoryPlayer: i32, state: texture_2d<f32>, resolution: vec2f) -> i32 {
    var attacks: i32 = 0;

    // Check all 8 directions since units can move diagonally
    for (var d: i32 = 1; d <= 8; d++) {
        let neighborPos: vec2f = factoryPos + dirToOffset(d);
        let neighborRaw: vec4f = textureLoad(state, vec2i(neighborPos), 0);
        let neighborType: i32 = getType(neighborRaw);

        // Is this an enemy unit that's not holding?
        if (isUnit(neighborType) && !getUnitHolding(neighborRaw)) {
            let unitPlayer: i32 = getPlayer(neighborType);
            if (unitPlayer != factoryPlayer) {
                attacks++;
            }
        }
    }

    return attacks;
}
