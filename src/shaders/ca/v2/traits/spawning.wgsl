// Spawning Trait - THE canonical spawning evaluation
//
// 3x3 Factory spawning:
// - Factories are 3x3 grids with empty center (8 outer cells)
// - The "top-middle" cell controls spawning (has left, right, corner factory neighbors)
// - Resources are summed across all 8 factory cells
// - When spawning, cost is subtracted equally from all 8 cells

#include "../core/types.wgsl"
#include "../core/traits.wgsl"

// ============================================================================
// Spawning Result
// ============================================================================

struct SpawnResult {
    happened: bool,
    spawnerPos: vec2f,      // Top-middle cell (spawn controller)
    spawnPos: vec2f,        // Where the unit appears
    spawnedCell: vec4f,
    factoryCenter: vec2f,   // Center of the 3x3 factory (for resource subtraction)
    player: i32,            // Player who owns the factory/unit
};

// ============================================================================
// Helper: Check if a cell is the "top-middle" of a 3x3 factory
// Top-middle has factory neighbors: LEFT, RIGHT, and corner factories below
// Note: Center of factory is empty, so we check diagonal corners instead
// ============================================================================

fn isTopMiddleFactory(pos: vec2f, state: texture_2d<f32>, resolution: vec2f) -> bool {
    let myRaw: vec4f = textureLoad(state, vec2i(pos), 0);
    let myType: i32 = getType(myRaw);
    if (!isFactory(myType)) { return false; }

    let myCenter: vec2f = getFactoryPos(myRaw);
    let myPlayer: i32 = getPlayer(myType);

    let leftRaw: vec4f = textureLoad(state, vec2i(pos + vec2f(-1.0, 0.0)), 0);
    let rightRaw: vec4f = textureLoad(state, vec2i(pos + vec2f(1.0, 0.0)), 0);
    let aboveRaw: vec4f = textureLoad(state, vec2i(pos + vec2f(0.0, 1.0)), 0);
    // Check bottom-left and bottom-right corners (center is empty now)
    let bottomLeftRaw: vec4f = textureLoad(state, vec2i(pos + vec2f(-1.0, -1.0)), 0);
    let bottomRightRaw: vec4f = textureLoad(state, vec2i(pos + vec2f(1.0, -1.0)), 0);

    // Top-middle has:
    // - Left and right are factories with same center and player
    // - Above is NOT factory (spawn location)
    // - Bottom-left and bottom-right are factories with same center and player
    let leftOK: bool = isFactory(getType(leftRaw)) && distance(getFactoryPos(leftRaw), myCenter) < 0.5 && getPlayer(getType(leftRaw)) == myPlayer;
    let rightOK: bool = isFactory(getType(rightRaw)) && distance(getFactoryPos(rightRaw), myCenter) < 0.5 && getPlayer(getType(rightRaw)) == myPlayer;
    let aboveOK: bool = !isFactory(getType(aboveRaw));
    let bottomLeftOK: bool = isFactory(getType(bottomLeftRaw)) && distance(getFactoryPos(bottomLeftRaw), myCenter) < 0.5 && getPlayer(getType(bottomLeftRaw)) == myPlayer;
    let bottomRightOK: bool = isFactory(getType(bottomRightRaw)) && distance(getFactoryPos(bottomRightRaw), myCenter) < 0.5 && getPlayer(getType(bottomRightRaw)) == myPlayer;

    return leftOK && rightOK && aboveOK && bottomLeftOK && bottomRightOK;
}

// ============================================================================
// Helper: Sum resources across 3x3 factory grid
// ============================================================================

fn sumFactoryResources(centerPos: vec2f, state: texture_2d<f32>, resolution: vec2f) -> f32 {
    var total: f32 = 0.0;
    for (var dy: i32 = -1; dy <= 1; dy++) {
        for (var dx: i32 = -1; dx <= 1; dx++) {
            let cellPos: vec2f = centerPos + vec2f(f32(dx), f32(dy));
            let cellRaw: vec4f = textureLoad(state, vec2i(cellPos), 0);
            if (isFactory(getType(cellRaw))) {
                total += getFactoryResources(cellRaw);
            }
        }
    }
    return total;
}

// ============================================================================
// Helper: Check if I'm part of a spawning 3x3 factory
// Returns the top-middle position if spawning, otherwise (-1, -1)
// ============================================================================

fn getSpawningTopMiddle(myPos: vec2f, state: texture_2d<f32>, resolution: vec2f) -> vec2f {
    // Simpler approach: if I'm a factory, get my center from selfPos,
    // then the top-middle is center + (0, 1)
    let myRaw: vec4f = textureLoad(state, vec2i(myPos), 0);
    if (!isFactory(getType(myRaw))) { return vec2f(-1.0); }

    let center: vec2f = getFactoryPos(myRaw);
    let topMiddle: vec2f = center + vec2f(0.0, 1.0);

    // Check if top-middle can spawn (must be same type of factory)
    let topMiddleRaw: vec4f = textureLoad(state, vec2i(topMiddle), 0);
    if (!isFactory(getType(topMiddleRaw))) { return vec2f(-1.0); }

    // Check if space above top-middle is empty
    let spawnPos: vec2f = topMiddle + vec2f(0.0, 1.0);
    let spawnRaw: vec4f = textureLoad(state, vec2i(spawnPos), 0);
    if (getType(spawnRaw) != TYPE_EMPTY) { return vec2f(-1.0); }

    // Check total resources
    let totalResources: f32 = sumFactoryResources(center, state, resolution);
    if (totalResources >= SPAWN_COST) {
        return topMiddle;
    }

    return vec2f(-1.0);
}

// ============================================================================
// THE CANONICAL SPAWNING EVALUATION
//
// 3x3 Factory spawns above its top-middle cell.
// Every pixel calls this to check if spawning affects them.
// ============================================================================

fn evaluateSpawning(myPos: vec2f, state: texture_2d<f32>, resolution: vec2f) -> SpawnResult {
    var result: SpawnResult;
    result.happened = false;
    result.spawnerPos = vec2f(-1.0);
    result.spawnPos = vec2f(-1.0);
    result.spawnedCell = vec4f(0.0);
    result.factoryCenter = vec2f(-1.0);
    result.player = 0;

    let myRaw: vec4f = textureLoad(state, vec2i(myPos), 0);
    let myType: i32 = getType(myRaw);

    // ========================================
    // CASE 1: I'm empty - is a factory below me spawning?
    // ========================================
    if (myType == TYPE_EMPTY) {
        let belowPos: vec2f = myPos + vec2f(0.0, -1.0);
        let belowRaw: vec4f = textureLoad(state, vec2i(belowPos), 0);
        let belowType: i32 = getType(belowRaw);

        if (isFactory(belowType)) {
            // Check if the factory below is the top-middle of a 3x3 factory
            if (isTopMiddleFactory(belowPos, state, resolution)) {
                let center: vec2f = getFactoryPos(belowRaw);
                let totalResources: f32 = sumFactoryResources(center, state, resolution);

                if (totalResources >= SPAWN_COST) {
                    let player: i32 = getPlayer(belowType);
                    result.happened = true;
                    result.spawnerPos = belowPos;
                    result.spawnPos = myPos;
                    // Spawn unit with newborn age (negative) for glow effect
                    result.spawnedCell = encodeNewbornUnit(player, center);
                    result.factoryCenter = center;
                    result.player = player;
                    return result;
                }
            }
        }
    }

    // ========================================
    // CASE 2: I'm a factory - is my factory spawning?
    // ========================================
    if (isFactory(myType)) {
        let topMiddle: vec2f = getSpawningTopMiddle(myPos, state, resolution);
        if (topMiddle.x >= 0.0) {
            let center: vec2f = getFactoryPos(myRaw);
            let spawnPos: vec2f = topMiddle + vec2f(0.0, 1.0);
            let player: i32 = getPlayer(myType);

            result.happened = true;
            result.spawnerPos = topMiddle;
            result.spawnPos = spawnPos;
            // Spawn unit with newborn age (negative) for glow effect
            result.spawnedCell = encodeNewbornUnit(player, center);
            result.factoryCenter = center;
            result.player = player;
            return result;
        }
    }

    return result;
}
