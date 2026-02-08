/**
 * Audio Reduction Constants
 *
 * Shared constants for the audio reduction shader pipeline.
 */

// Cell type constants (must match main game)
const CELL_EMPTY: f32 = 0.0;
const CELL_RESOURCE: f32 = 1.0;
const CELL_MINING_UNIT: f32 = 2.0;
const CELL_MINING_FACTORY: f32 = 3.0;
const CELL_WALL: f32 = 4.0;
const CELL_MINING_UNIT_P2: f32 = 5.0;
const CELL_DEMOLISH: f32 = 6.0;
const CELL_MINING_FACTORY_P2: f32 = 7.0;

// Helper functions
fn isUnit(cellType: f32) -> bool {
    return cellType == CELL_MINING_UNIT || cellType == CELL_MINING_UNIT_P2;
}

fn isFactory(cellType: f32) -> bool {
    return cellType == CELL_MINING_FACTORY || cellType == CELL_MINING_FACTORY_P2;
}

fn isP1Unit(cellType: f32) -> bool {
    return cellType == CELL_MINING_UNIT;
}

fn isP2Unit(cellType: f32) -> bool {
    return cellType == CELL_MINING_UNIT_P2;
}

fn isP1Factory(cellType: f32) -> bool {
    return cellType == CELL_MINING_FACTORY;
}

fn isP2Factory(cellType: f32) -> bool {
    return cellType == CELL_MINING_FACTORY_P2;
}

fn getPlayer(cellType: f32) -> i32 {
    if (cellType == CELL_MINING_UNIT || cellType == CELL_MINING_FACTORY) { return 1; }
    if (cellType == CELL_MINING_UNIT_P2 || cellType == CELL_MINING_FACTORY_P2) { return 2; }
    return 0;
}

// Get unit holding state (bit 0 of G channel)
fn getUnitHolding(cell: vec4f) -> bool {
    return (floor(cell.g) % 2.0) > 0.5;
}

// Get factory resources
fn getFactoryResources(cell: vec4f) -> f32 {
    return cell.g;
}
