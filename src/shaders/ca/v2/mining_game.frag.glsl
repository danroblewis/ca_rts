#version 300 es
precision highp float;

/**
 * Mining Game v2 - Trait-Based Cellular Automata
 * 
 * Architecture:
 * 1. Each trait has ONE canonical evaluation function
 * 2. Every pixel calls the same trait evaluators
 * 3. Each pixel extracts its role from the evaluation results
 * 4. Conservation is guaranteed because source/destination agree
 * 
 * To add a new trait:
 *   1. Create traits/new_trait.glsl with evaluateNewTrait()
 *   2. Include it here
 *   3. Add role extraction in compute()
 * 
 * To add a new mobile type:
 *   1. Add type constant in core/types.glsl
 *   2. Add trait in core/traits.glsl getTraits()
 *   3. Add direction logic in traits/movement.glsl getMobileDirection()
 */

#include "./core/types.glsl"
#include "./core/traits.glsl"
#include "./traits/memory.glsl"
#include "./traits/movement.glsl"
#include "./traits/spawning.glsl"
#include "./traits/deposit.glsl"

uniform sampler2D u_state;
uniform vec2 u_resolution;
uniform float u_time;

in vec2 v_uv;
out vec4 fragColor;

// ============================================================================
// Compute - Evaluate all traits and return the new cell state
// ============================================================================

vec4 compute(vec2 myPos, vec4 myRaw, int myType) {
    
    // ========================================================================
    // Evaluate all traits that might affect me
    // ========================================================================
    
    MovementResult movement = evaluateMovement(myPos, u_state, u_resolution, u_time);
    SpawnResult spawning = evaluateSpawning(myPos, u_state, u_resolution);
    DepositResult deposit = evaluateDeposit(myPos, u_state, u_resolution);
    
    // ========================================================================
    // Extract my role from each trait result
    // ========================================================================
    
    // --- MOVEMENT ---
    if (movement.happened) {
        // Am I the source? (I become empty)
        if (distance(movement.fromPos, myPos) < 0.5) {
            return encodeEmpty();
        }
        
        // Am I the destination? (I receive the arriving cell)
        if (distance(movement.toPos, myPos) < 0.5) {
            return transformArrival(movement.arrivingCell, myRaw, myPos);
        }
    }
    
    // --- SPAWNING ---
    if (spawning.happened) {
        // Am I the spawn location? (I become the spawned cell)
        if (distance(spawning.spawnPos, myPos) < 0.5) {
            return spawning.spawnedCell;
        }
        
        // Am I the spawner? (I spend resources)
        if (distance(spawning.spawnerPos, myPos) < 0.5) {
            float newResources = getFactoryResources(myRaw) - SPAWN_COST;
            // Also count any deposits happening this frame
            int deposits = countDeposits(myPos, getFactoryPos(myRaw), u_state, u_resolution);
            newResources += float(deposits);
            return encodeFactory(newResources, getFactoryPos(myRaw));
        }
    }
    
    // --- DEPOSIT ---
    if (deposit.happened) {
        // Am I the depositing unit? (I become empty-handed)
        if (distance(deposit.unitPos, myPos) < 0.5) {
            // Keep the memory we had - we didn't decay it while holding
            MemoryState mem;
            mem.position = getUnitMemoryPos(myRaw);
            mem.freshness = getUnitMemoryFreshness(myRaw);
            mem.hasMemory = mem.freshness > 0.0;
            mem.homesickTimer = 0.0;
            mem.factoryChanged = false;
            mem.newFactoryPos = vec2(-1.0);
            
            return encodeUnit(
                false,  // no longer holding
                0,      // reset counter
                getUnitFactory(myRaw),
                mem
            );
        }
        
        // Am I the receiving factory? (I gain resources)
        if (distance(deposit.factoryPos, myPos) < 0.5) {
            int deposits = countDeposits(myPos, getFactoryPos(myRaw), u_state, u_resolution);
            float newResources = getFactoryResources(myRaw) + float(deposits);
            
            // Check if we're also spawning (resource gets spent)
            if (spawning.happened && distance(spawning.spawnerPos, myPos) < 0.5) {
                newResources -= SPAWN_COST;
            }
            
            return encodeFactory(newResources, getFactoryPos(myRaw));
        }
    }
    
    // ========================================================================
    // No trait affected me - handle staying in place
    // ========================================================================
    
    if (myType == TYPE_UNIT) {
        // Unit staying in place - might be blocked, update counter
        int counter = getUnitCounter(myRaw);
        bool walking = float(counter) >= STATIONARY_THRESHOLD;
        bool holding = getUnitHolding(myRaw);
        
        int newCounter;
        if (walking) {
            newCounter = max(0, counter - 1);  // Decrement in walking mode
        } else {
            newCounter = counter + 1;  // Increment toward threshold
        }
        
        // Only decay/evaluate memory when not holding
        MemoryState mem;
        vec2 factoryPos = getUnitFactory(myRaw);
        
        // Check if our factory still exists - if not, forget it!
        // This handles deleted factories - unit becomes "homeless"
        if (factoryPos.x >= 0.0 && isNearFactoryLocation(myPos, factoryPos) && !factoryExistsAt(factoryPos, u_state, u_resolution)) {
            factoryPos = vec2(-1.0);  // Factory was deleted, become homeless
        }
        
        // Check for visible factories - units ALWAYS adopt visible factories
        vec2 visibleFactory = findVisibleFactory(myPos, u_state, u_resolution);
        if (visibleFactory.x >= 0.0 && distance(visibleFactory, factoryPos) > 0.5) {
            factoryPos = visibleFactory;  // Adopt the visible factory as new home
        }
        
        if (holding) {
            // Keep memory intact while carrying resource
            mem.position = getUnitMemoryPos(myRaw);
            mem.freshness = getUnitMemoryFreshness(myRaw);
            mem.hasMemory = mem.freshness > 0.0;
            mem.factoryChanged = false;
        } else {
            mem = evaluateMemory(myPos, myRaw, u_state, u_resolution);
            // If we learned from another unit, adopt their factory too!
            if (mem.factoryChanged) {
                factoryPos = mem.newFactoryPos;
            }
        }
        
        return encodeUnit(
            holding,
            newCounter,
            factoryPos,
            mem
        );
    }
    
    if (myType == TYPE_FACTORY) {
        // Factory not spawning - just count deposits
        int deposits = countDeposits(myPos, getFactoryPos(myRaw), u_state, u_resolution);
        float newResources = getFactoryResources(myRaw) + float(deposits);
        return encodeFactory(newResources, getFactoryPos(myRaw));
    }
    
    // Everything else stays as-is
    return myRaw;
}

// ============================================================================
// Main - Entry point
// ============================================================================

void main() {
    vec2 myPos = floor(v_uv * u_resolution);
    vec4 myRaw = texture(u_state, (myPos + 0.5) / u_resolution);
    int myType = getType(myRaw);
    
    fragColor = compute(myPos, myRaw, myType);
}
