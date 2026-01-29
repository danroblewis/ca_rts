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
#include "./traits/demolish.glsl"
#include "./traits/attack.glsl"
#include "./traits/combat.glsl"
#include "./traits/resource_movement.glsl"
#include "./traits/missile.glsl"

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
    BuildResult build = evaluateBuild(myPos, u_state, u_resolution);
    DemolishResult demolish = evaluateDemolish(myPos, u_state, u_resolution);
    AttackResult attack = evaluateAttack(myPos, u_state, u_resolution);
    CombatResult combat = evaluateCombat(myPos, u_time, u_state, u_resolution);
    ResourceMoveResult resourceMove = evaluateResourceMovement(myPos, u_time, u_state, u_resolution);
    
    // ========================================================================
    // Extract my role from each trait result
    // ========================================================================
    
    // --- UNIT MOVEMENT ---
    if (movement.happened) {
        // Am I the source? (I become empty)
        if (distance(movement.fromPos, myPos) < 0.5) {
            return encodeEmpty();
        }
        
        // Am I the destination? (I receive the arriving cell)
        if (distance(movement.toPos, myPos) < 0.5) {
            return transformArrival(movement.arrivingCell, myRaw, myPos, u_state, u_resolution);
        }
    }
    
    // --- RESOURCE MOVEMENT ---
    if (resourceMove.happened) {
        // Am I the source? (I become empty)
        if (distance(resourceMove.fromPos, myPos) < 0.5) {
            return encodeEmpty();
        }
        
        // Am I the destination? (I receive the moving resource)
        if (distance(resourceMove.toPos, myPos) < 0.5) {
            // Preserve the resource's phase and amount
            float amount = getResourceAmount(resourceMove.movingCell);
            float phase = getResourcePhase(resourceMove.movingCell);
            return encodeResourceWithPhase(amount, phase);
        }
    }
    
    // --- FACTORY → MISSILE TRANSFORMATION ---
    // Check BEFORE spawning/deposits so the factory can transform even when units want to deposit
    if (isFactory(myType)) {
        FactoryToMissileResult transformation = checkFactoryToMissile(myPos, myRaw, u_state, u_resolution);
        if (transformation.shouldTransform) {
            return transformation.missileCell;
        }
    }
    
    // --- SPAWNING ---
    if (spawning.happened) {
        // Am I the spawn location? (I become the spawned cell)
        if (distance(spawning.spawnPos, myPos) < 0.5) {
            return spawning.spawnedCell;
        }
        
        // Am I part of the 3x3 factory that's spawning? (subtract 1/9 of cost from each cell)
        if (isFactory(myType) && distance(getFactoryPos(myRaw), spawning.factoryCenter) < 0.5) {
            float costPerCell = SPAWN_COST / 9.0;
            float newResources = getFactoryResources(myRaw) - costPerCell;
            // Also count any deposits happening this frame
            int deposits = countDeposits(myPos, getFactoryPos(myRaw), spawning.player, u_state, u_resolution);
            newResources += float(deposits);
            return encodeFactory(max(0.0, newResources), getFactoryPos(myRaw), spawning.player);
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
                getPlayer(myType),
                false,  // no longer holding
                0,      // reset counter
                getUnitSelected(myRaw),  // preserve selection
                0.0,    // reset age (just deposited successfully)
                getUnitFactory(myRaw),
                mem
            );
        }
        
        // Am I the receiving factory? (I gain resources)
        if (distance(deposit.factoryPos, myPos) < 0.5) {
            int factoryPlayer = getPlayer(myType);
            int deposits = countDeposits(myPos, getFactoryPos(myRaw), factoryPlayer, u_state, u_resolution);
            float newResources = getFactoryResources(myRaw) + float(deposits);
            
            // Check if we're also spawning (resource gets spent)
            if (spawning.happened && distance(spawning.spawnerPos, myPos) < 0.5) {
                newResources -= SPAWN_COST;
            }
            
            return encodeFactory(newResources, getFactoryPos(myRaw), factoryPlayer);
        }
    }
    
    // --- BUILD (unbuilt factory construction) ---
    if (build.happened) {
        // Am I the building unit? (I become empty-handed)
        if (distance(build.unitPos, myPos) < 0.5) {
            // Keep the memory we had - we didn't decay it while holding
            MemoryState mem;
            mem.position = getUnitMemoryPos(myRaw);
            mem.freshness = getUnitMemoryFreshness(myRaw);
            mem.hasMemory = mem.freshness > 0.0;
            mem.homesickTimer = 0.0;
            mem.factoryChanged = false;
            mem.newFactoryPos = vec2(-1.0);
            
            return encodeUnit(
                getPlayer(myType),
                false,  // no longer holding
                0,      // reset counter
                getUnitSelected(myRaw),  // preserve selection
                0.0,    // reset age (just built successfully)
                getUnitFactory(myRaw),
                mem
            );
        }
        
        // Am I the unbuilt factory cell being built?
        if (distance(build.blueprintPos, myPos) < 0.5) {
            int builds = countBuilds(myPos, u_state, u_resolution);
            float newBuildProgress = min(getFactoryBuildProgress(myRaw) + float(builds), MAX_BUILD_PER_CELL);
            vec2 center = getFactoryPos(myRaw);
            int factoryPlayer = getPlayer(myType);
            
            // Update this cell's build progress
            // Note: The factory remains TYPE_FACTORY, just with updated G value
            // The "built" status is determined by summing all cells' G values
            return encodeUnbuiltFactory(newBuildProgress, center, factoryPlayer);
        }
    }
    
    // --- DEMOLISH (units destroying marked cells) ---
    if (demolish.happened) {
        // Am I the demolishing unit? (I pick up a resource)
        if (distance(demolish.unitPos, myPos) < 0.5) {
            // Unit picks up a resource from demolishing
            MemoryState mem;
            mem.position = myPos;  // Remember this location
            mem.freshness = 50.0;  // Fresh memory
            mem.hasMemory = true;
            mem.homesickTimer = 0.0;
            mem.factoryChanged = false;
            mem.newFactoryPos = vec2(-1.0);
            
            return encodeUnit(
                getPlayer(myType),
                true,   // now holding a resource
                0,      // reset counter
                getUnitSelected(myRaw),  // preserve selection
                0.0,    // reset age
                getUnitFactory(myRaw),
                mem
            );
        }
        
        // Am I the demolish cell being destroyed?
        if (distance(demolish.demolishPos, myPos) < 0.5) {
            return encodeEmpty();
        }
    }
    
    // --- ATTACK (units destroying enemy factories) ---
    if (attack.happened) {
        // Am I the attacking unit? (I pick up a resource)
        if (distance(attack.unitPos, myPos) < 0.5) {
            // Unit picks up a resource from attacking enemy factory
            MemoryState mem;
            mem.position = vec2(-1.0);  // No memory of enemy factory location
            mem.freshness = 0.0;
            mem.hasMemory = false;
            mem.homesickTimer = 0.0;
            mem.factoryChanged = false;
            mem.newFactoryPos = vec2(-1.0);
            
            return encodeUnit(
                getPlayer(myType),
                true,   // now holding a resource (plundered!)
                0,      // reset counter
                getUnitSelected(myRaw),  // preserve selection
                0.0,    // reset age
                getUnitFactory(myRaw),
                mem
            );
        }
        
        // Am I the factory cell being attacked?
        if (distance(attack.factoryPos, myPos) < 0.5) {
            // Count how many attackers are hitting me
            int attacks = countAttacks(myPos, attack.defenderPlayer, u_state, u_resolution);
            // Factory cell is destroyed by the attack
            return encodeEmpty();
        }
    }
    
    // --- MISSILE EXPLOSION (destroys everything in radius) ---
    vec2 explodingMissile = findExplodingMissileAffecting(myPos, u_state, u_resolution);
    if (explodingMissile.x >= 0.0) {
        // I'm in the explosion radius - get destroyed (unless I'm the missile itself)
        if (!isMissile(myType) || distance(getMissileCenter(myRaw), explodingMissile) > 0.5) {
            return encodeEmpty();
        }
    }
    
    // --- MISSILE ARRIVAL (moving missile cells arriving at this position) ---
    // Must check BEFORE isInMissilePath, so arriving missile cells aren't destroyed
    MissileMovementResult missileArrival = checkMissileArrival(myPos, u_time, u_state, u_resolution);
    if (missileArrival.happened) {
        return missileArrival.arrivingCell;
    }
    
    // --- MISSILE IN PATH (moving missiles destroy everything in front of them) ---
    // Only destroys cells that AREN'T receiving the missile (checked above)
    if (!isMissile(myType) && isInMissilePath(myPos, u_time, u_state, u_resolution)) {
        // I'm in the path of a moving missile - get destroyed
        return encodeEmpty();
    }
    
    // ========================================================================
    // No trait affected me - handle staying in place
    // ========================================================================
    
    // --- MISSILE UPDATE ---
    if (isMissile(myType)) {
        return updateMissileCell(myRaw, myPos, u_time, u_state, u_resolution);
    }
    
    // --- EXPLOSION PARTICLE UPDATE ---
    if (isExplosion(myType)) {
        int lifetime = getExplosionLifetime(myRaw);
        
        // Die if lifetime expired
        if (lifetime <= 0) {
            return encodeEmpty();
        }
        
        // Random walk - pick a random direction
        int randomDir = 1 + int(hash(myPos, u_time) * 8.0);
        vec2 offset = dirToOffset(randomDir);
        vec2 targetPos = myPos + offset;
        
        // Check target cell
        vec4 targetRaw = texture(u_state, (targetPos + 0.5) / u_resolution);
        int targetType = getType(targetRaw);
        
        // If target is empty, move there (handled by arrival logic)
        // If target is not empty and not explosion, destroy it and stay
        if (targetType != TYPE_EMPTY && !isExplosion(targetType)) {
            // We destroy things by staying in place - the target will check for adjacent explosions
            return encodeExplosion(lifetime - 1);
        }
        
        // Decrement lifetime and stay (movement handled by explosion arrival)
        return encodeExplosion(lifetime - 1);
    }
    
    // --- EXPLOSION PARTICLE SPAWNING (from adjacent exploding missile) ---
    if (myType == TYPE_EMPTY) {
        // Check for adjacent exploding missiles that might spawn particles here
        for (int d = 1; d <= 8; d++) {
            vec2 checkPos = myPos + dirToOffset(d);
            vec4 checkRaw = texture(u_state, (checkPos + 0.5) / u_resolution);
            int checkType = getType(checkRaw);
            
            if (isMissile(checkType) && getMissileState(checkRaw) == MISSILE_EXPLODING) {
                // Exploding missile nearby - chance to spawn a particle here
                float spawnChance = hash(myPos + vec2(float(d) * 7.3, 0.0), u_time);
                
                if (spawnChance < 0.3) {  // 30% chance per adjacent exploding missile cell
                    return encodeExplosion(EXPLOSION_PARTICLE_LIFETIME);
                }
            }
        }
    }
    
    // --- EXPLOSION PARTICLE ARRIVAL (random walk into this cell) ---
    if (myType == TYPE_EMPTY) {
        // Check for adjacent explosion particles that might move here
        for (int d = 1; d <= 8; d++) {
            vec2 checkPos = myPos + dirToOffset(d);
            vec4 checkRaw = texture(u_state, (checkPos + 0.5) / u_resolution);
            
            if (isExplosion(getType(checkRaw))) {
                int lifetime = getExplosionLifetime(checkRaw);
                if (lifetime > 0) {
                    // Check if this particle wants to move here
                    int particleDir = 1 + int(hash(checkPos, u_time) * 8.0);
                    vec2 particleOffset = dirToOffset(particleDir);
                    vec2 particleTarget = checkPos + particleOffset;
                    
                    if (distance(particleTarget, myPos) < 0.5) {
                        // This particle is moving to me
                        return encodeExplosion(lifetime - 1);
                    }
                }
            }
        }
    }
    
    // --- EXPLOSION DESTRUCTION (adjacent explosion particle destroys me) ---
    if (myType != TYPE_EMPTY && !isExplosion(myType) && !isMissile(myType)) {
        for (int d = 1; d <= 8; d++) {
            vec2 checkPos = myPos + dirToOffset(d);
            vec4 checkRaw = texture(u_state, (checkPos + 0.5) / u_resolution);
            
            if (isExplosion(getType(checkRaw))) {
                // Adjacent explosion particle - I get destroyed!
                return encodeEmpty();
            }
        }
    }
    
    if (isUnit(myType)) {
        // Unit staying in place - might be blocked, update counter
        int counter = getUnitCounter(myRaw);
        bool walking = float(counter) >= STATIONARY_THRESHOLD;
        bool holding = getUnitHolding(myRaw);
        float age = getUnitAge(myRaw);
        int myPlayer = getPlayer(myType);
        
        int newCounter;
        if (walking) {
            // Already in walking mode, keep counter high (don't decrement when blocked in walking mode)
            // Only successful moves decrement counter (in transformArrival)
            newCounter = counter;
        } else {
            // Not walking yet, increment toward threshold
            newCounter = counter + 1;
            // When we JUST reach the threshold, boost to max to ensure walking mode sticks
            if (float(newCounter) >= STATIONARY_THRESHOLD && float(counter) < STATIONARY_THRESHOLD) {
                newCounter = 15;  // Max counter value, will take many successful moves to exit
            }
        }
        
        // Get factory position early for age calculation
        vec2 factoryPos = getUnitFactory(myRaw);
        
        // Age handling:
        // - If holding, don't age (carrying resource is productive)
        // - If near factory, heal (reduce age)
        // - If not holding and far from factory, increment age (starving)
        // - Combat damage is added as age (pushing toward death)
        // - If age reaches MAX_AGE, unit dies!
        float newAge = age;
        // Only heal near BUILT factories (unbuilt factories don't provide healing)
        bool nearFactory = (factoryPos.x >= 0.0 && distance(myPos, factoryPos) <= FACTORY_SAFE_ZONE);
        bool factoryIsBuilt = nearFactory && isFactoryBuilt(factoryPos, u_state, u_resolution);
        
        // Apply combat damage first (if we lost a fight this frame)
        if (combat.tookDamage) {
            newAge = age + combat.damageAmount;
            if (newAge >= MAX_AGE) {
                // Unit died in combat!
                return encodeEmpty();
            }
        } else if (holding) {
            // Don't age while carrying resources
            newAge = age;
        } else if (factoryIsBuilt) {
            // Heal while near BUILT factory - reduce age
            newAge = max(0.0, age - 2.0);  // Heal twice as fast as starving
        } else {
            // Starving - increment age
            newAge = age + 1.0;
            if (newAge >= MAX_AGE) {
                // Unit starved to death!
                return encodeEmpty();
            }
        }
        
        // Only decay/evaluate memory when not holding
        MemoryState mem;
        
        // Check if our factory still exists - if not, forget it!
        // This handles deleted factories - unit becomes "homeless"
        if (factoryPos.x >= 0.0 && isNearFactoryLocation(myPos, factoryPos) && !factoryExistsAt(factoryPos, u_state, u_resolution)) {
            factoryPos = vec2(-1.0);  // Factory was deleted, become homeless
        }
        
        // Check for visible factories OF SAME PLAYER - units adopt visible factories of their team
        vec2 visibleFactory = findVisibleFactory(myPos, myPlayer, u_state, u_resolution);
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
            mem = evaluateMemory(myPos, myRaw, myPlayer, u_state, u_resolution);
            // If we learned from another unit, adopt their factory too!
            if (mem.factoryChanged) {
                factoryPos = mem.newFactoryPos;
            }
        }
        
        return encodeUnit(
            myPlayer,
            holding,
            newCounter,
            getUnitSelected(myRaw),  // preserve selection
            newAge,
            factoryPos,
            mem
        );
    }
    
    if (isFactory(myType)) {
        // Factory not spawning - just count deposits
        int myPlayer = getPlayer(myType);
        int deposits = countDeposits(myPos, getFactoryPos(myRaw), myPlayer, u_state, u_resolution);
        float newResources = getFactoryResources(myRaw) + float(deposits);
        return encodeFactory(newResources, getFactoryPos(myRaw), myPlayer);
    }
    
    // Note: Factories (both built and unbuilt) are handled above in the FACTORY case
    // and through the BUILD trait. No separate TYPE_FACTORY_BLUEPRINT handling needed.
    
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
