/**
 * Attack Trait - THE canonical attack evaluation
 * 
 * Non-holding units adjacent to enemy factories will attack them.
 * When attacked, a factory cell is destroyed and the unit picks up a resource.
 * This is the SINGLE SOURCE OF TRUTH for attacking.
 */

#ifndef ATTACK_GLSL
#define ATTACK_GLSL

#include "../core/types.glsl"
#include "../core/traits.glsl"

// ============================================================================
// Attack Result
// ============================================================================

struct AttackResult {
    bool happened;
    vec2 unitPos;
    vec2 factoryPos;      // Position of the factory cell being attacked
    int attackerPlayer;   // Player who is attacking
    int defenderPlayer;   // Player being attacked
};

// ============================================================================
// THE CANONICAL ATTACK EVALUATION
// 
// A non-holding unit adjacent to an enemy factory will attack it.
// The factory cell is destroyed and the unit picks up a resource.
// ============================================================================

AttackResult evaluateAttack(vec2 myPos, sampler2D state, vec2 resolution) {
    AttackResult result;
    result.happened = false;
    result.unitPos = vec2(-1.0);
    result.factoryPos = vec2(-1.0);
    result.attackerPlayer = 0;
    result.defenderPlayer = 0;
    
    vec4 myRaw = texture(state, (myPos + 0.5) / resolution);
    int myType = getType(myRaw);
    
    // ========================================
    // CASE 1: I'm a non-holding unit - am I attacking an enemy factory?
    // ========================================
    if (isUnit(myType) && !getUnitHolding(myRaw)) {
        int myPlayer = getPlayer(myType);
        
        // Check neighbors for enemy factories (all 8 directions)
        for (int d = 1; d <= 8; d++) {
            vec2 neighborPos = myPos + dirToOffset(d);
            vec4 neighborRaw = texture(state, (neighborPos + 0.5) / resolution);
            int neighborType = getType(neighborRaw);
            
            // Is this an enemy factory?
            if (isFactory(neighborType)) {
                int factoryPlayer = getPlayer(neighborType);
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
        int myPlayer = getPlayer(myType);
        
        // Check all 8 directions since units can move diagonally
        for (int d = 1; d <= 8; d++) {
            vec2 neighborPos = myPos + dirToOffset(d);
            vec4 neighborRaw = texture(state, (neighborPos + 0.5) / resolution);
            int neighborType = getType(neighborRaw);
            
            // Is this an enemy unit that's not holding?
            if (isUnit(neighborType) && !getUnitHolding(neighborRaw)) {
                int unitPlayer = getPlayer(neighborType);
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
int countAttacks(vec2 factoryPos, int factoryPlayer, sampler2D state, vec2 resolution) {
    int attacks = 0;
    
    // Check all 8 directions since units can move diagonally
    for (int d = 1; d <= 8; d++) {
        vec2 neighborPos = factoryPos + dirToOffset(d);
        vec4 neighborRaw = texture(state, (neighborPos + 0.5) / resolution);
        int neighborType = getType(neighborRaw);
        
        // Is this an enemy unit that's not holding?
        if (isUnit(neighborType) && !getUnitHolding(neighborRaw)) {
            int unitPlayer = getPlayer(neighborType);
            if (unitPlayer != factoryPlayer) {
                attacks++;
            }
        }
    }
    
    return attacks;
}

#endif

