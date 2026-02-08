// Mining Game v2 - Trait-Based Cellular Automata (WebGPU Compute Shader)
//
// Architecture:
// 1. Each trait has ONE canonical evaluation function
// 2. Every pixel calls the same trait evaluators
// 3. Each pixel extracts its role from the evaluation results
// 4. Conservation is guaranteed because source/destination agree

#include "./core/types.wgsl"
#include "./core/traits.wgsl"
#include "./traits/memory.wgsl"
#include "./traits/movement.wgsl"
#include "./traits/spawning.wgsl"
#include "./traits/deposit.wgsl"
#include "./traits/demolish.wgsl"
#include "./traits/attack.wgsl"
#include "./traits/combat.wgsl"
#include "./traits/resource_movement.wgsl"
#include "./traits/missile.wgsl"

@group(0) @binding(0) var u_state: texture_2d<f32>;
@group(0) @binding(1) var u_output: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> params: SimParams;

struct SimParams {
    resolution: vec2f,
    time: f32,
    _pad: f32,
}

// ============================================================================
// Compute - Evaluate all traits and return the new cell state
// ============================================================================

fn compute(myPos: vec2f, myRaw: vec4f, myType: i32) -> vec4f {

    // ========================================================================
    // Evaluate all traits that might affect me
    // ========================================================================

    let movement: MovementResult = evaluateMovement(myPos, u_state, params.resolution, params.time);
    let spawning: SpawnResult = evaluateSpawning(myPos, u_state, params.resolution);
    let deposit_result: DepositResult = evaluateDeposit(myPos, u_state, params.resolution);
    let build: BuildResult = evaluateBuild(myPos, u_state, params.resolution);
    let demolish: DemolishResult = evaluateDemolish(myPos, u_state, params.resolution);
    let attack_result: AttackResult = evaluateAttack(myPos, u_state, params.resolution);
    let combat: CombatResult = evaluateCombat(myPos, params.time, u_state, params.resolution);
    let resourceMove: ResourceMoveResult = evaluateResourceMovement(myPos, params.time, u_state, params.resolution);

    // ========================================================================
    // Extract my role from each trait result
    // ========================================================================

    // --- UNIT MOVEMENT ---
    if (movement.happened) {
        if (distance(movement.fromPos, myPos) < 0.5) {
            return encodeEmpty();
        }
        if (distance(movement.toPos, myPos) < 0.5) {
            return transformArrival(movement.arrivingCell, myRaw, myPos, u_state, params.resolution);
        }
    }

    // --- RESOURCE MOVEMENT ---
    if (resourceMove.happened) {
        if (distance(resourceMove.fromPos, myPos) < 0.5) {
            return encodeEmpty();
        }
        if (distance(resourceMove.toPos, myPos) < 0.5) {
            let amount: f32 = getResourceAmount(resourceMove.movingCell);
            let phase: f32 = getResourcePhase(resourceMove.movingCell);
            return encodeResourceWithPhase(amount, phase);
        }
    }

    // --- FACTORY → MISSILE TRANSFORMATION ---
    if (isFactory(myType)) {
        let transformation: FactoryToMissileResult = checkFactoryToMissile(myPos, myRaw, u_state, params.resolution);
        if (transformation.shouldTransform) {
            return transformation.missileCell;
        }
    }

    // --- SPAWNING ---
    if (spawning.happened) {
        if (distance(spawning.spawnPos, myPos) < 0.5) {
            return spawning.spawnedCell;
        }
        if (isFactory(myType) && distance(getFactoryPos(myRaw), spawning.factoryCenter) < 0.5) {
            let costPerCell: f32 = SPAWN_COST / 9.0;
            var newResources: f32 = getFactoryResources(myRaw) - costPerCell;
            let deposits: i32 = countDeposits(myPos, getFactoryPos(myRaw), spawning.player, u_state, params.resolution);
            newResources += f32(deposits);
            return encodeFactory(max(0.0, newResources), getFactoryPos(myRaw), spawning.player);
        }
    }

    // --- DEPOSIT ---
    if (deposit_result.happened) {
        if (distance(deposit_result.unitPos, myPos) < 0.5) {
            var mem: MemoryState;
            mem.position = getUnitMemoryPos(myRaw);
            mem.freshness = getUnitMemoryFreshness(myRaw);
            mem.hasMemory = mem.freshness > 0.0;
            mem.homesickTimer = 0.0;
            mem.factoryChanged = false;
            mem.newFactoryPos = vec2f(-1.0);

            return encodeUnit(
                getPlayer(myType),
                false,
                0,
                getUnitSelected(myRaw),
                0.0,
                getUnitFactory(myRaw),
                mem
            );
        }
        if (distance(deposit_result.factoryPos, myPos) < 0.5) {
            let factoryPlayer: i32 = getPlayer(myType);
            let deposits: i32 = countDeposits(myPos, getFactoryPos(myRaw), factoryPlayer, u_state, params.resolution);
            var newResources: f32 = getFactoryResources(myRaw) + f32(deposits);
            if (spawning.happened && distance(spawning.spawnerPos, myPos) < 0.5) {
                newResources -= SPAWN_COST;
            }
            return encodeFactory(newResources, getFactoryPos(myRaw), factoryPlayer);
        }
    }

    // --- BUILD ---
    if (build.happened) {
        if (distance(build.unitPos, myPos) < 0.5) {
            var mem: MemoryState;
            mem.position = getUnitMemoryPos(myRaw);
            mem.freshness = getUnitMemoryFreshness(myRaw);
            mem.hasMemory = mem.freshness > 0.0;
            mem.homesickTimer = 0.0;
            mem.factoryChanged = false;
            mem.newFactoryPos = vec2f(-1.0);

            return encodeUnit(
                getPlayer(myType),
                false,
                0,
                getUnitSelected(myRaw),
                0.0,
                getUnitFactory(myRaw),
                mem
            );
        }
        if (distance(build.blueprintPos, myPos) < 0.5) {
            let builds: i32 = countBuilds(myPos, u_state, params.resolution);
            let newBuildProgress: f32 = min(getFactoryBuildProgress(myRaw) + f32(builds), MAX_BUILD_PER_CELL);
            let center: vec2f = getFactoryPos(myRaw);
            let factoryPlayer: i32 = getPlayer(myType);
            return encodeUnbuiltFactory(newBuildProgress, center, factoryPlayer);
        }
    }

    // --- DEMOLISH ---
    if (demolish.happened) {
        if (distance(demolish.unitPos, myPos) < 0.5) {
            var mem: MemoryState;
            mem.position = myPos;
            mem.freshness = 50.0;
            mem.hasMemory = true;
            mem.homesickTimer = 0.0;
            mem.factoryChanged = false;
            mem.newFactoryPos = vec2f(-1.0);

            return encodeUnit(
                getPlayer(myType),
                true,
                0,
                getUnitSelected(myRaw),
                0.0,
                getUnitFactory(myRaw),
                mem
            );
        }
        if (distance(demolish.demolishPos, myPos) < 0.5) {
            return encodeEmpty();
        }
    }

    // --- ATTACK ---
    if (attack_result.happened) {
        if (distance(attack_result.unitPos, myPos) < 0.5) {
            var mem: MemoryState;
            mem.position = vec2f(-1.0);
            mem.freshness = 0.0;
            mem.hasMemory = false;
            mem.homesickTimer = 0.0;
            mem.factoryChanged = false;
            mem.newFactoryPos = vec2f(-1.0);

            return encodeUnit(
                getPlayer(myType),
                true,
                0,
                getUnitSelected(myRaw),
                0.0,
                getUnitFactory(myRaw),
                mem
            );
        }
        if (distance(attack_result.factoryPos, myPos) < 0.5) {
            let attacks: i32 = countAttacks(myPos, attack_result.defenderPlayer, u_state, params.resolution);
            return encodeEmpty();
        }
    }

    // --- MISSILE EXPLOSION ---
    let explodingMissile: vec2f = findExplodingMissileAffecting(myPos, u_state, params.resolution);
    if (explodingMissile.x >= 0.0) {
        if (!isMissile(myType) || distance(getMissileCenter(myRaw), explodingMissile) > 0.5) {
            return encodeEmpty();
        }
    }

    // --- MISSILE ARRIVAL ---
    let missileArrival: MissileMovementResult = checkMissileArrival(myPos, params.time, u_state, params.resolution);
    if (missileArrival.happened) {
        return missileArrival.arrivingCell;
    }

    // --- MISSILE IN PATH ---
    if (!isMissile(myType) && isInMissilePath(myPos, params.time, u_state, params.resolution)) {
        return encodeEmpty();
    }

    // ========================================================================
    // No trait affected me - handle staying in place
    // ========================================================================

    // --- MISSILE UPDATE ---
    if (isMissile(myType)) {
        return updateMissileCell(myRaw, myPos, params.time, u_state, params.resolution);
    }

    // --- EXPLOSION PARTICLE UPDATE ---
    if (isExplosion(myType)) {
        let lifetime: i32 = getExplosionLifetime(myRaw);
        if (lifetime <= 0) {
            return encodeEmpty();
        }
        let rDir: i32 = 1 + i32(hash(myPos, params.time) * 8.0);
        let offset: vec2f = dirToOffset(rDir);
        let targetPos: vec2f = myPos + offset;
        let targetRaw: vec4f = textureLoad(u_state, vec2i(targetPos), 0);
        let targetType: i32 = getType(targetRaw);
        if (targetType != TYPE_EMPTY && !isExplosion(targetType)) {
            return encodeExplosion(lifetime - 1);
        }
        return encodeExplosion(lifetime - 1);
    }

    // --- EXPLOSION PARTICLE LOGIC ---
    if (myType == TYPE_EMPTY) {
        for (var d: i32 = 1; d <= 4; d++) {
            let checkPos: vec2f = myPos + dirToOffset(d);
            let checkRaw: vec4f = textureLoad(u_state, vec2i(checkPos), 0);
            let checkType: i32 = getType(checkRaw);

            if (isMissile(checkType) && getMissileState(checkRaw) == MISSILE_EXPLODING) {
                let spawnChance: f32 = hash(myPos, params.time);
                if (spawnChance < 0.15) {
                    return encodeExplosion(EXPLOSION_PARTICLE_LIFETIME);
                }
            }

            if (isExplosion(checkType)) {
                let lifetime: i32 = getExplosionLifetime(checkRaw);
                if (lifetime > 0) {
                    let particleDir: i32 = 1 + i32(hash(checkPos, params.time) * 4.0);
                    let particleTarget: vec2f = checkPos + dirToOffset(particleDir);
                    if (distance(particleTarget, myPos) < 0.5) {
                        return encodeExplosion(lifetime - 1);
                    }
                }
            }
        }
    } else if (!isExplosion(myType) && !isMissile(myType) && !isFactory(myType)) {
        for (var d: i32 = 1; d <= 4; d++) {
            let checkPos: vec2f = myPos + dirToOffset(d);
            let checkRaw: vec4f = textureLoad(u_state, vec2i(checkPos), 0);
            if (isExplosion(getType(checkRaw))) {
                return encodeEmpty();
            }
        }
    }

    if (isUnit(myType)) {
        let counter: i32 = getUnitCounter(myRaw);
        let walking: bool = f32(counter) >= STATIONARY_THRESHOLD;
        let holding: bool = getUnitHolding(myRaw);
        let age: f32 = getUnitAge(myRaw);
        let myPlayer: i32 = getPlayer(myType);

        var newCounter: i32;
        if (walking) {
            newCounter = counter;
        } else {
            newCounter = counter + 1;
            if (f32(newCounter) >= STATIONARY_THRESHOLD && f32(counter) < STATIONARY_THRESHOLD) {
                newCounter = 15;
            }
        }

        var factoryPos: vec2f = getUnitFactory(myRaw);

        var newAge: f32 = age;
        let nearFactory: bool = (factoryPos.x >= 0.0 && distance(myPos, factoryPos) <= FACTORY_SAFE_ZONE);
        let factoryIsBuiltVal: bool = nearFactory && isFactoryBuilt(factoryPos, u_state, params.resolution);

        if (combat.tookDamage) {
            newAge = age + combat.damageAmount;
            if (newAge >= MAX_AGE) {
                return encodeEmpty();
            }
        } else if (holding) {
            newAge = age;
        } else if (factoryIsBuiltVal) {
            newAge = max(0.0, age - 2.0);
        } else {
            newAge = age + 1.0;
            if (newAge >= MAX_AGE) {
                return encodeEmpty();
            }
        }

        var mem: MemoryState;

        if (factoryPos.x >= 0.0 && isNearFactoryLocation(myPos, factoryPos) && !factoryExistsAt(factoryPos, u_state, params.resolution)) {
            factoryPos = vec2f(-1.0);
        }

        let visibleFactory: vec2f = findVisibleFactory(myPos, myPlayer, u_state, params.resolution);
        if (visibleFactory.x >= 0.0 && distance(visibleFactory, factoryPos) > 0.5) {
            factoryPos = visibleFactory;
        }

        if (holding) {
            mem.position = getUnitMemoryPos(myRaw);
            mem.freshness = getUnitMemoryFreshness(myRaw);
            mem.hasMemory = mem.freshness > 0.0;
            mem.factoryChanged = false;
        } else {
            mem = evaluateMemory(myPos, myRaw, myPlayer, u_state, params.resolution);
            if (mem.factoryChanged) {
                factoryPos = mem.newFactoryPos;
            }
        }

        return encodeUnit(
            myPlayer,
            holding,
            newCounter,
            getUnitSelected(myRaw),
            newAge,
            factoryPos,
            mem
        );
    }

    if (isFactory(myType)) {
        let myPlayer: i32 = getPlayer(myType);
        let deposits: i32 = countDeposits(myPos, getFactoryPos(myRaw), myPlayer, u_state, params.resolution);
        let newResources: f32 = getFactoryResources(myRaw) + f32(deposits);
        return encodeFactory(newResources, getFactoryPos(myRaw), myPlayer);
    }

    return myRaw;
}

// ============================================================================
// Main - Compute shader entry point
// ============================================================================

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let pos: vec2i = vec2i(gid.xy);
    if (pos.x >= i32(params.resolution.x) || pos.y >= i32(params.resolution.y)) { return; }

    let myPos: vec2f = vec2f(f32(pos.x), f32(pos.y));
    let myRaw: vec4f = textureLoad(u_state, pos, 0);
    let myType: i32 = getType(myRaw);

    let result: vec4f = compute(myPos, myRaw, myType);
    textureStore(u_output, pos, result);
}
