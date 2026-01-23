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
 *   3. Add role extraction in main update logic
 * 
 * To add a new mobile type:
 *   1. Add type constant in core/types.glsl
 *   2. Add trait in core/traits.glsl getTraits()
 *   3. Add direction logic in traits/movement.glsl getMobileDirection()
 */

#include "./core/types.glsl"
#include "./core/traits.glsl"
#include "./traits/movement.glsl"
#include "./traits/spawning.glsl"
#include "./traits/deposit.glsl"

uniform sampler2D u_state;
uniform vec2 u_resolution;
uniform float u_time;

in vec2 v_uv;
out vec4 fragColor;

// ============================================================================
// Main Update - Evaluate all traits and extract my role
// ============================================================================

void main() {
    vec2 myPos = floor(v_uv * u_resolution);
    vec4 myRaw = texture(u_state, (myPos + 0.5) / u_resolution);
    int myType = getType(myRaw);
    
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
            fragColor = encodeEmpty();
            return;
        }
        
        // Am I the destination? (I receive the arriving cell)
        if (distance(movement.toPos, myPos) < 0.5) {
            vec4 arriving = transformArrival(movement.arrivingCell, myRaw, myPos);
            fragColor = arriving;
            return;
        }
    }
    
    // --- SPAWNING ---
    if (spawning.happened) {
        // Am I the spawn location? (I become the spawned cell)
        if (distance(spawning.spawnPos, myPos) < 0.5) {
            fragColor = spawning.spawnedCell;
            return;
        }
        
        // Am I the spawner? (I spend resources)
        if (distance(spawning.spawnerPos, myPos) < 0.5) {
            float newResources = getFactoryResources(myRaw) - SPAWN_COST;
            // Also count any deposits happening this frame
            int deposits = countDeposits(myPos, getFactoryPos(myRaw), u_state, u_resolution);
            newResources += float(deposits);
            fragColor = encodeFactory(newResources, getFactoryPos(myRaw));
            return;
        }
    }
    
    // --- DEPOSIT ---
    if (deposit.happened) {
        // Am I the depositing unit? (I become empty-handed)
        if (distance(deposit.unitPos, myPos) < 0.5) {
            // Use Memory trait to evaluate memory state
            MemoryState mem = evaluateMemory(myPos, myRaw, u_state, u_resolution);
            
            fragColor = encodeUnit(
                false,  // no longer holding
                0,      // reset counter
                getUnitFactory(myRaw),
                mem.position,
                mem.freshness
            );
            return;
        }
        
        // Am I the receiving factory? (I gain resources)
        if (distance(deposit.factoryPos, myPos) < 0.5) {
            int deposits = countDeposits(myPos, getFactoryPos(myRaw), u_state, u_resolution);
            float newResources = getFactoryResources(myRaw) + float(deposits);
            
            // Check if we're also spawning (resource gets spent)
            if (spawning.happened && distance(spawning.spawnerPos, myPos) < 0.5) {
                newResources -= SPAWN_COST;
            }
            
            fragColor = encodeFactory(newResources, getFactoryPos(myRaw));
            return;
        }
    }
    
    // ========================================================================
    // No trait affected me - handle staying in place
    // ========================================================================
    
    if (myType == TYPE_UNIT) {
        // Unit staying in place - might be blocked, update counter
        int counter = getUnitCounter(myRaw);
        bool walking = float(counter) >= STATIONARY_THRESHOLD;
        
        int newCounter;
        if (walking) {
            newCounter = max(0, counter - 1);  // Decrement in walking mode
        } else {
            newCounter = counter + 1;  // Increment toward threshold
        }
        
        // Use Memory trait to evaluate memory state
        MemoryState mem = evaluateMemory(myPos, myRaw, u_state, u_resolution);
        
        fragColor = encodeUnit(
            getUnitHolding(myRaw),
            newCounter,
            getUnitFactory(myRaw),
            mem.position,
            mem.freshness
        );
        return;
    }
    
    if (myType == TYPE_FACTORY) {
        // Factory not spawning - just count deposits
        int deposits = countDeposits(myPos, getFactoryPos(myRaw), u_state, u_resolution);
        float newResources = getFactoryResources(myRaw) + float(deposits);
        fragColor = encodeFactory(newResources, getFactoryPos(myRaw));
        return;
    }
    
    // Everything else stays as-is
    fragColor = myRaw;
}
