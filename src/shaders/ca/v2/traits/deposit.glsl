/**
 * Deposit Trait - THE canonical deposit evaluation
 * 
 * Units holding resources can deposit at their factory OR build unbuilt factories.
 * This is the SINGLE SOURCE OF TRUTH for deposits.
 * 
 * Factory states:
 * - Unbuilt: sum of G (build progress) across 3x3 < BUILD_THRESHOLD
 * - Built: sum of G (build progress) across 3x3 >= BUILD_THRESHOLD, G now represents resources
 */

#ifndef DEPOSIT_GLSL
#define DEPOSIT_GLSL

#include "../core/types.glsl"
#include "../core/traits.glsl"

// ============================================================================
// Factory Built Status Helpers
// Note: sumFactoryBuildProgress and isFactoryBuilt are defined in types.glsl
// ============================================================================

// Check if a specific factory cell is part of a built factory
bool isFactoryCellBuilt(vec4 factoryCell, sampler2D state, vec2 resolution) {
    vec2 center = getFactoryPos(factoryCell);
    return isFactoryBuilt(center, state, resolution);
}

// ============================================================================
// Deposit Result
// ============================================================================

struct DepositResult {
    bool happened;
    vec2 unitPos;
    vec2 factoryPos;
};

// ============================================================================
// Build Result (for blueprint construction)
// ============================================================================

struct BuildResult {
    bool happened;
    vec2 unitPos;
    vec2 blueprintPos;
};

// ============================================================================
// THE CANONICAL DEPOSIT EVALUATION
// 
// A holding unit adjacent to its BUILT factory will deposit.
// Only built factories can receive deposits.
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
        
        // Check neighbors for my factory (must be BUILT)
        for (int d = 1; d <= 4; d++) {
            vec2 neighborPos = myPos + dirToOffset(d);
            vec4 neighborRaw = texture(state, (neighborPos + 0.5) / resolution);
            
            if (getType(neighborRaw) == TYPE_FACTORY) {
                vec2 fPos = getFactoryPos(neighborRaw);
                // Must be our factory AND must be built
                if (distance(fPos, myFactory) < 0.5 && isFactoryBuilt(fPos, state, resolution)) {
                    result.happened = true;
                    result.unitPos = myPos;
                    result.factoryPos = neighborPos;
                    return result;
                }
            }
        }
    }
    
    // ========================================
    // CASE 2: I'm a BUILT factory - is a unit depositing to me?
    // ========================================
    if (myType == TYPE_FACTORY) {
        vec2 mySelfPos = getFactoryPos(myRaw);
        
        // Only accept deposits if we're built
        if (!isFactoryBuilt(mySelfPos, state, resolution)) {
            return result;
        }
        
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

// ============================================================================
// THE CANONICAL BUILD EVALUATION
// 
// A holding unit adjacent to an UNBUILT factory will build it.
// Priority: deposit to own BUILT factory first, then build unbuilt factories.
// ============================================================================

BuildResult evaluateBuild(vec2 myPos, sampler2D state, vec2 resolution) {
    BuildResult result;
    result.happened = false;
    result.unitPos = vec2(-1.0);
    result.blueprintPos = vec2(-1.0);  // Now represents unbuilt factory position
    
    vec4 myRaw = texture(state, (myPos + 0.5) / resolution);
    int myType = getType(myRaw);
    
    // ========================================
    // CASE 1: I'm a holding unit - am I building an unbuilt factory?
    // ========================================
    if (myType == TYPE_UNIT && getUnitHolding(myRaw)) {
        vec2 myFactory = getUnitFactory(myRaw);
        
        // First check if I would deposit to my own BUILT factory (that takes priority)
        for (int d = 1; d <= 4; d++) {
            vec2 neighborPos = myPos + dirToOffset(d);
            vec4 neighborRaw = texture(state, (neighborPos + 0.5) / resolution);
            
            if (getType(neighborRaw) == TYPE_FACTORY) {
                vec2 fPos = getFactoryPos(neighborRaw);
                // Only deposit takes priority if factory is BUILT
                if (distance(fPos, myFactory) < 0.5 && isFactoryBuilt(fPos, state, resolution)) {
                    // Would deposit to built factory, not build
                    return result;
                }
            }
        }
        
        // Check neighbors for unbuilt factory cells that aren't at max build
        for (int d = 1; d <= 4; d++) {
            vec2 neighborPos = myPos + dirToOffset(d);
            vec4 neighborRaw = texture(state, (neighborPos + 0.5) / resolution);
            
            if (getType(neighborRaw) == TYPE_FACTORY) {
                vec2 fPos = getFactoryPos(neighborRaw);
                // Only build if factory is NOT built yet
                if (!isFactoryBuilt(fPos, state, resolution)) {
                    float buildProgress = getFactoryBuildProgress(neighborRaw);
                    if (buildProgress < MAX_BUILD_PER_CELL) {
                        result.happened = true;
                        result.unitPos = myPos;
                        result.blueprintPos = neighborPos;
                        return result;
                    }
                }
            }
        }
    }
    
    // ========================================
    // CASE 2: I'm an unbuilt factory cell - is a unit building me?
    // ========================================
    if (myType == TYPE_FACTORY) {
        vec2 myCenter = getFactoryPos(myRaw);
        
        // Only accept builds if we're NOT built yet
        if (isFactoryBuilt(myCenter, state, resolution)) {
            return result;
        }
        
        float myBuildProgress = getFactoryBuildProgress(myRaw);
        if (myBuildProgress >= MAX_BUILD_PER_CELL) {
            return result;  // This cell is already at max
        }
        
        for (int d = 1; d <= 4; d++) {
            vec2 neighborPos = myPos + dirToOffset(d);
            vec4 neighborRaw = texture(state, (neighborPos + 0.5) / resolution);
            
            if (getType(neighborRaw) == TYPE_UNIT && getUnitHolding(neighborRaw)) {
                vec2 theirFactory = getUnitFactory(neighborRaw);
                
                // Check if they would deposit to their BUILT factory instead
                bool wouldDeposit = false;
                for (int d2 = 1; d2 <= 4; d2++) {
                    vec2 checkPos = neighborPos + dirToOffset(d2);
                    vec4 checkRaw = texture(state, (checkPos + 0.5) / resolution);
                    if (getType(checkRaw) == TYPE_FACTORY) {
                        vec2 fPos = getFactoryPos(checkRaw);
                        // Only blocks if it's their factory AND it's built
                        if (distance(fPos, theirFactory) < 0.5 && isFactoryBuilt(fPos, state, resolution)) {
                            wouldDeposit = true;
                            break;
                        }
                    }
                }
                
                if (!wouldDeposit) {
                    result.happened = true;
                    result.unitPos = neighborPos;
                    result.blueprintPos = myPos;
                    return result;
                }
            }
        }
    }
    
    return result;
}

// Count all builds happening to an unbuilt factory cell
int countBuilds(vec2 factoryCellPos, sampler2D state, vec2 resolution) {
    int count = 0;
    vec4 cellRaw = texture(state, (factoryCellPos + 0.5) / resolution);
    
    if (getType(cellRaw) != TYPE_FACTORY) {
        return 0;
    }
    
    vec2 center = getFactoryPos(cellRaw);
    
    // Don't count builds if factory is already built
    if (isFactoryBuilt(center, state, resolution)) {
        return 0;
    }
    
    float currentBuild = getFactoryBuildProgress(cellRaw);
    
    // Don't count builds if this cell is already at max
    if (currentBuild >= MAX_BUILD_PER_CELL) {
        return 0;
    }
    
    for (int d = 1; d <= 4; d++) {
        vec2 neighborPos = factoryCellPos + dirToOffset(d);
        vec4 neighborRaw = texture(state, (neighborPos + 0.5) / resolution);
        
        if (getType(neighborRaw) == TYPE_UNIT && getUnitHolding(neighborRaw)) {
            vec2 theirFactory = getUnitFactory(neighborRaw);
            
            // Check if they would deposit to their BUILT factory instead
            bool wouldDeposit = false;
            for (int d2 = 1; d2 <= 4; d2++) {
                vec2 checkPos = neighborPos + dirToOffset(d2);
                vec4 checkRaw = texture(state, (checkPos + 0.5) / resolution);
                if (getType(checkRaw) == TYPE_FACTORY) {
                    vec2 fPos = getFactoryPos(checkRaw);
                    // Only blocks if it's their factory AND it's built
                    if (distance(fPos, theirFactory) < 0.5 && isFactoryBuilt(fPos, state, resolution)) {
                        wouldDeposit = true;
                        break;
                    }
                }
            }
            
            if (!wouldDeposit) {
                count++;
            }
        }
    }
    
    return count;
}

#endif
