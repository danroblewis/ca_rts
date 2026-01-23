/**
 * Deposit Trait - THE canonical deposit evaluation
 * 
 * Units holding resources can deposit at their factory.
 * This is the SINGLE SOURCE OF TRUTH for deposits.
 */

#ifndef DEPOSIT_GLSL
#define DEPOSIT_GLSL

#include "../core/types.glsl"
#include "../core/traits.glsl"

// ============================================================================
// Deposit Result
// ============================================================================

struct DepositResult {
    bool happened;
    vec2 unitPos;
    vec2 factoryPos;
};

// ============================================================================
// THE CANONICAL DEPOSIT EVALUATION
// 
// A holding unit adjacent to its factory will deposit.
// ============================================================================

DepositResult evaluateDeposit(vec2 myPos, sampler2D state, vec2 resolution) {
    DepositResult result;
    result.happened = false;
    result.unitPos = vec2(-1.0);
    result.factoryPos = vec2(-1.0);
    
    vec4 myRaw = texture(state, (myPos + 0.5) / resolution);
    int myType = getType(myRaw);
    
    // ========================================
    // CASE 1: I'm a holding unit - am I depositing?
    // ========================================
    if (myType == TYPE_UNIT && getUnitHolding(myRaw)) {
        vec2 myFactory = getUnitFactory(myRaw);
        
        // Check neighbors for my factory
        for (int d = 1; d <= 4; d++) {
            vec2 neighborPos = myPos + dirToOffset(d);
            vec4 neighborRaw = texture(state, (neighborPos + 0.5) / resolution);
            
            if (getType(neighborRaw) == TYPE_FACTORY) {
                vec2 fPos = getFactoryPos(neighborRaw);
                if (distance(fPos, myFactory) < 0.5) {
                    result.happened = true;
                    result.unitPos = myPos;
                    result.factoryPos = neighborPos;
                    return result;
                }
            }
        }
    }
    
    // ========================================
    // CASE 2: I'm a factory - is a unit depositing to me?
    // ========================================
    if (myType == TYPE_FACTORY) {
        vec2 mySelfPos = getFactoryPos(myRaw);
        
        for (int d = 1; d <= 4; d++) {
            vec2 neighborPos = myPos + dirToOffset(d);
            vec4 neighborRaw = texture(state, (neighborPos + 0.5) / resolution);
            
            if (getType(neighborRaw) == TYPE_UNIT && getUnitHolding(neighborRaw)) {
                vec2 theirFactory = getUnitFactory(neighborRaw);
                if (distance(theirFactory, mySelfPos) < 0.5) {
                    result.happened = true;
                    result.unitPos = neighborPos;
                    result.factoryPos = myPos;
                    return result;
                }
            }
        }
    }
    
    return result;
}

// Count all deposits happening to a factory
int countDeposits(vec2 factoryPos, vec2 factorySelfPos, sampler2D state, vec2 resolution) {
    int count = 0;
    
    for (int d = 1; d <= 4; d++) {
        vec2 neighborPos = factoryPos + dirToOffset(d);
        vec4 neighborRaw = texture(state, (neighborPos + 0.5) / resolution);
        
        if (getType(neighborRaw) == TYPE_UNIT && getUnitHolding(neighborRaw)) {
            vec2 theirFactory = getUnitFactory(neighborRaw);
            if (distance(theirFactory, factorySelfPos) < 0.5) {
                count++;
            }
        }
    }
    
    return count;
}

#endif
