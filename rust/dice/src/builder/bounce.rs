//! `src/common/bounce.ts` is ported once, in [`crate::common::bounce`]; re-exported here for the
//! builder.

pub use crate::common::bounce::{
    MAX_DICE_FACES, dice_sum_distribution, face_weights, joint_sum_and_match, too_big,
};
