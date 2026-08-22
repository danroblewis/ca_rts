// Deposit Trait - THE canonical deposit evaluation
//
// Units holding resources can deposit at their factory OR build unbuilt factories.
// This is the SINGLE SOURCE OF TRUTH for deposits.
//
// Factory states:
// - Unbuilt: sum of G (build progress) across 3x3 < BUILD_THRESHOLD
// - Built: sum of G (build progress) across 3x3 >= BUILD_THRESHOLD, G now represents resources

#include "../core/types.wgsl"
#include "../core/traits.wgsl"

// ============================================================================
// Factory Built Status Helpers
// Note: sumFactoryBuildProgress and isFactoryBuilt are defined in types.wgsl
// ============================================================================

// Check if a specific factory cell is part of a built factory
fn isFactoryCellBuilt(factoryCell: vec4f, state: texture_2d<f32>, resolution: vec2f) -> bool {
    let center: vec2f = getFactoryPos(factoryCell);
    return isFactoryBuilt(center, state, resolution);
}

// ============================================================================
// Deposit Result
// ============================================================================

struct DepositResult {
    happened: bool,
    unitPos: vec2f,
    factoryPos: vec2f,
};

// ============================================================================
// Build Result (for blueprint construction)
// ============================================================================

struct BuildResult {
    happened: bool,
    unitPos: vec2f,
    blueprintPos: vec2f,
};

// ============================================================================
// THE CANONICAL DEPOSIT EVALUATION
//
// A holding unit adjacent to its BUILT factory will deposit.
// Only built factories can receive deposits.
// ============================================================================

fn evaluateDeposit(myPos: vec2f, state: texture_2d<f32>, resolution: vec2f) -> DepositResult {
    var result: DepositResult;
    result.happened = false;
    result.unitPos = vec2f(-1.0);
    result.factoryPos = vec2f(-1.0);

    let myRaw: vec4f = textureLoad(state, vec2i(myPos), 0);
    let myType: i32 = getType(myRaw);

    // ========================================
    // CASE 1: I'm a holding unit - am I depositing?
    // ========================================
    if (isUnit(myType) && getUnitHolding(myRaw)) {
        let myFactory: vec2f = getUnitFactory(myRaw);
        let myPlayer: i32 = getPlayer(myType);

        // Check neighbors for my factory (must be BUILT and same player)
        // Check all 8 directions since units can move diagonally
        for (var d: i32 = 1; d <= 8; d++) {
            let neighborPos: vec2f = myPos + dirToOffset(d);
            let neighborRaw: vec4f = textureLoad(state, vec2i(neighborPos), 0);
            let neighborType: i32 = getType(neighborRaw);

            if (isFactory(neighborType) && getPlayer(neighborType) == myPlayer) {
                let fPos: vec2f = getFactoryPos(neighborRaw);
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
    // CASE 2: I'm a BUILT factory - is a unit of my player depositing to me?
    // ========================================
    if (isFactory(myType)) {
        let mySelfPos: vec2f = getFactoryPos(myRaw);
        let myPlayer: i32 = getPlayer(myType);

        // Only accept deposits if we're built
        if (!isFactoryBuilt(mySelfPos, state, resolution)) {
            return result;
        }

        // Check all 8 directions since units can move diagonally
        for (var d: i32 = 1; d <= 8; d++) {
            let neighborPos: vec2f = myPos + dirToOffset(d);
            let neighborRaw: vec4f = textureLoad(state, vec2i(neighborPos), 0);
            let neighborType: i32 = getType(neighborRaw);

            if (isUnit(neighborType) && getPlayer(neighborType) == myPlayer && getUnitHolding(neighborRaw)) {
                let theirFactory: vec2f = getUnitFactory(neighborRaw);
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

// Count all deposits happening to a factory (from units of the same player)
fn countDeposits(factoryPos: vec2f, factorySelfPos: vec2f, factoryPlayer: i32, state: texture_2d<f32>, resolution: vec2f) -> i32 {
    var count: i32 = 0;

    // Check all 8 directions since units can move diagonally
    for (var d: i32 = 1; d <= 8; d++) {
        let neighborPos: vec2f = factoryPos + dirToOffset(d);
        let neighborRaw: vec4f = textureLoad(state, vec2i(neighborPos), 0);
        let neighborType: i32 = getType(neighborRaw);

        if (isUnit(neighborType) && getPlayer(neighborType) == factoryPlayer && getUnitHolding(neighborRaw)) {
            let theirFactory: vec2f = getUnitFactory(neighborRaw);
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

fn evaluateBuild(myPos: vec2f, state: texture_2d<f32>, resolution: vec2f) -> BuildResult {
    var result: BuildResult;
    result.happened = false;
    result.unitPos = vec2f(-1.0);
    result.blueprintPos = vec2f(-1.0);  // Now represents unbuilt factory position

    let myRaw: vec4f = textureLoad(state, vec2i(myPos), 0);
    let myType: i32 = getType(myRaw);

    // ========================================
    // CASE 1: I'm a holding unit - am I building an unbuilt factory?
    // ========================================
    if (isUnit(myType) && getUnitHolding(myRaw)) {
        let myFactory: vec2f = getUnitFactory(myRaw);
        let myPlayer: i32 = getPlayer(myType);

        // First check if I would deposit to my own BUILT factory (that takes priority)
        // Check all 8 directions since units can move diagonally
        for (var d: i32 = 1; d <= 8; d++) {
            let neighborPos: vec2f = myPos + dirToOffset(d);
            let neighborRaw: vec4f = textureLoad(state, vec2i(neighborPos), 0);
            let neighborType: i32 = getType(neighborRaw);

            if (isFactory(neighborType) && getPlayer(neighborType) == myPlayer) {
                let fPos: vec2f = getFactoryPos(neighborRaw);
                // Only deposit takes priority if factory is BUILT
                if (distance(fPos, myFactory) < 0.5 && isFactoryBuilt(fPos, state, resolution)) {
                    // Would deposit to built factory, not build
                    return result;
                }
            }
        }

        // Check neighbors for ANY unbuilt factory cells that aren't at max build
        // Units can build ANY player's unbuilt factory
        // Check all 8 directions since units can move diagonally
        for (var d: i32 = 1; d <= 8; d++) {
            let neighborPos: vec2f = myPos + dirToOffset(d);
            let neighborRaw: vec4f = textureLoad(state, vec2i(neighborPos), 0);
            let neighborType: i32 = getType(neighborRaw);

            if (isFactory(neighborType)) {
                let fPos: vec2f = getFactoryPos(neighborRaw);
                // Only build if factory is NOT built yet
                if (!isFactoryBuilt(fPos, state, resolution)) {
                    let buildProgress: f32 = getFactoryBuildProgress(neighborRaw);
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
    if (isFactory(myType)) {
        let myCenter: vec2f = getFactoryPos(myRaw);

        // Only accept builds if we're NOT built yet
        if (isFactoryBuilt(myCenter, state, resolution)) {
            return result;
        }

        let myBuildProgress: f32 = getFactoryBuildProgress(myRaw);
        if (myBuildProgress >= MAX_BUILD_PER_CELL) {
            return result;  // This cell is already at max
        }

        // Check all 8 directions since units can move diagonally
        for (var d: i32 = 1; d <= 8; d++) {
            let neighborPos: vec2f = myPos + dirToOffset(d);
            let neighborRaw: vec4f = textureLoad(state, vec2i(neighborPos), 0);
            let neighborType: i32 = getType(neighborRaw);

            if (isUnit(neighborType) && getUnitHolding(neighborRaw)) {
                let theirFactory: vec2f = getUnitFactory(neighborRaw);
                let theirPlayer: i32 = getPlayer(neighborType);

                // Check if they would deposit to their BUILT factory instead
                var wouldDeposit: bool = false;
                for (var d2: i32 = 1; d2 <= 8; d2++) {
                    let checkPos: vec2f = neighborPos + dirToOffset(d2);
                    let checkRaw: vec4f = textureLoad(state, vec2i(checkPos), 0);
                    let checkType: i32 = getType(checkRaw);
                    if (isFactory(checkType) && getPlayer(checkType) == theirPlayer) {
                        let fPos: vec2f = getFactoryPos(checkRaw);
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
fn countBuilds(factoryCellPos: vec2f, state: texture_2d<f32>, resolution: vec2f) -> i32 {
    var count: i32 = 0;
    let cellRaw: vec4f = textureLoad(state, vec2i(factoryCellPos), 0);
    let cellType: i32 = getType(cellRaw);

    if (!isFactory(cellType)) {
        return 0;
    }

    let center: vec2f = getFactoryPos(cellRaw);

    // Don't count builds if factory is already built
    if (isFactoryBuilt(center, state, resolution)) {
        return 0;
    }

    let currentBuild: f32 = getFactoryBuildProgress(cellRaw);

    // Don't count builds if this cell is already at max
    if (currentBuild >= MAX_BUILD_PER_CELL) {
        return 0;
    }

    // Check all 8 directions since units can move diagonally
    for (var d: i32 = 1; d <= 8; d++) {
        let neighborPos: vec2f = factoryCellPos + dirToOffset(d);
        let neighborRaw: vec4f = textureLoad(state, vec2i(neighborPos), 0);
        let neighborType: i32 = getType(neighborRaw);

        if (isUnit(neighborType) && getUnitHolding(neighborRaw)) {
            let theirFactory: vec2f = getUnitFactory(neighborRaw);
            let theirPlayer: i32 = getPlayer(neighborType);

            // Check if they would deposit to their BUILT factory instead
            var wouldDeposit: bool = false;
            for (var d2: i32 = 1; d2 <= 8; d2++) {
                let checkPos: vec2f = neighborPos + dirToOffset(d2);
                let checkRaw: vec4f = textureLoad(state, vec2i(checkPos), 0);
                let checkType: i32 = getType(checkRaw);
                if (isFactory(checkType) && getPlayer(checkType) == theirPlayer) {
                    let fPos: vec2f = getFactoryPos(checkRaw);
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
