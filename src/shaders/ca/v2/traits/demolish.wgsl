// Demolish Trait - THE canonical demolish evaluation
//
// Non-holding units adjacent to demolish-marked cells will destroy them
// and pick up a resource in the process.
// This is the SINGLE SOURCE OF TRUTH for demolition.

#include "../core/types.wgsl"
#include "../core/traits.wgsl"

// ============================================================================
// Demolish Result
// ============================================================================

struct DemolishResult {
    happened: bool,
    unitPos: vec2f,
    demolishPos: vec2f,
};

// ============================================================================
// THE CANONICAL DEMOLISH EVALUATION
//
// A non-holding unit adjacent to a demolish cell will destroy it and pick up a resource.
// ============================================================================

fn evaluateDemolish(myPos: vec2f, state: texture_2d<f32>, resolution: vec2f) -> DemolishResult {
    var result: DemolishResult;
    result.happened = false;
    result.unitPos = vec2f(-1.0);
    result.demolishPos = vec2f(-1.0);

    let myRaw: vec4f = textureLoad(state, vec2i(myPos), 0);
    let myType: i32 = getType(myRaw);

    // ========================================
    // CASE 1: I'm a non-holding unit - am I demolishing?
    // ========================================
    if (myType == TYPE_UNIT && !getUnitHolding(myRaw)) {
        // Check neighbors for demolish cells (all 8 directions)
        for (var d: i32 = 1; d <= 8; d++) {
            let neighborPos: vec2f = myPos + dirToOffset(d);
            let neighborRaw: vec4f = textureLoad(state, vec2i(neighborPos), 0);

            if (getType(neighborRaw) == TYPE_DEMOLISH) {
                result.happened = true;
                result.unitPos = myPos;
                result.demolishPos = neighborPos;
                return result;
            }
        }
    }

    // ========================================
    // CASE 2: I'm a demolish cell - is a unit demolishing me?
    // ========================================
    if (myType == TYPE_DEMOLISH) {
        // Check all 8 directions since units can move diagonally
        for (var d: i32 = 1; d <= 8; d++) {
            let neighborPos: vec2f = myPos + dirToOffset(d);
            let neighborRaw: vec4f = textureLoad(state, vec2i(neighborPos), 0);

            if (getType(neighborRaw) == TYPE_UNIT && !getUnitHolding(neighborRaw)) {
                result.happened = true;
                result.unitPos = neighborPos;
                result.demolishPos = myPos;
                return result;
            }
        }
    }

    return result;
}
