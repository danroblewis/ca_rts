// Intent encoding - shared between the prepass and the main simulation pass
//
// The prepass evaluates, ONCE per cell, the expensive per-cell decisions that
// the main pass would otherwise recompute for every neighbour that looks at
// the cell (e.g. a unit's movement direction, which scans an 11x11 window).
// The result is packed into a single u32 per cell:
//
//   bits  0-3  : direction (units: mobile direction, resources: move direction)
//   bit   4    : factory cell belongs to a BUILT factory
//   bit   5    : resource moves this tick (direction is valid and != DIR_NONE)
//   bits  8-11 : cell type (TYPE_*)
//   bit   12   : unit is holding a resource
//   bit   13   : cell is mobile
//
// The prepass also produces an "activity mask" per 8x8 block: a bitmask of the
// cell types present in the block. The main pass ORs the 3x3 blocks around a
// cell (covering at least +-8 cells, more than any trait's vision range) and
// skips whole trait evaluations when nothing relevant is nearby. This is a pure
// optimisation: every skipped evaluation would have returned "nothing happened".

const INTENT_DIR_MASK: u32 = 0xFu;
const INTENT_BUILT: u32 = 1u << 4u;
const INTENT_RES_MOVES: u32 = 1u << 5u;
const INTENT_TYPE_SHIFT: u32 = 8u;
const INTENT_TYPE_MASK: u32 = 0xFu << 8u;
const INTENT_HOLDING: u32 = 1u << 12u;
const INTENT_MOBILE: u32 = 1u << 13u;

fn intentDir(intent: u32) -> i32 { return i32(intent & INTENT_DIR_MASK); }
fn intentType(intent: u32) -> i32 { return i32((intent & INTENT_TYPE_MASK) >> INTENT_TYPE_SHIFT); }
fn intentIsMobile(intent: u32) -> bool { return (intent & INTENT_MOBILE) != 0u; }
fn intentIsHolding(intent: u32) -> bool { return (intent & INTENT_HOLDING) != 0u; }
fn intentIsBuilt(intent: u32) -> bool { return (intent & INTENT_BUILT) != 0u; }
fn intentResourceMoves(intent: u32) -> bool { return (intent & INTENT_RES_MOVES) != 0u; }

// Activity mask bits: bit N set <=> a cell of TYPE_N exists in the block.
const ACT_RESOURCE: u32 = 1u << 1u;
const ACT_UNITS: u32 = (1u << 2u) | (1u << 5u);
const ACT_FACTORIES: u32 = (1u << 3u) | (1u << 7u);
const ACT_DEMOLISH: u32 = 1u << 6u;
const ACT_MISSILES: u32 = (1u << 8u) | (1u << 9u);
const ACT_EXPLOSION: u32 = 1u << 10u;

const BLOCK_SIZE: i32 = 8;
