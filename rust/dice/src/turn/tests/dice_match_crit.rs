//! `tests/turn-dice-match-crit.test.ts`: 1 test, 73 compat calls.

use super::helpers::*;
use crate::builder::factory::*;
use crate::turn::turn;
use std::collections::{BTreeMap, BTreeSet};

const FILE: &str = "tests/turn-dice-match-crit.test.ts";

/// Every ordered roll of `count` d`faces`: total -> [P(total and a face repeats), P(total and all differ)].
fn totals_by_match(count: usize, faces: usize) -> BTreeMap<i64, [f64; 2]> {
    fn walk(
        values: &mut Vec<usize>,
        count: usize,
        faces: usize,
        p: f64,
        out: &mut BTreeMap<i64, [f64; 2]>,
    ) {
        if values.len() == count {
            let total: usize = values.iter().sum();
            let distinct = values.iter().collect::<BTreeSet<_>>().len();
            out.entry(total as i64).or_insert([0.0, 0.0])[usize::from(distinct >= count)] += p;
            return;
        }
        for face in 1..=faces {
            values.push(face);
            walk(values, count, faces, p, out);
            values.pop();
        }
    }
    let mut out = BTreeMap::new();
    walk(
        &mut Vec::new(),
        count,
        faces,
        1.0 / (faces as f64).powi(count as i32),
        &mut out,
    );
    out
}

/// P(total) of `count` d`faces`.
fn sum_of(count: usize, faces: usize) -> BTreeMap<i64, f64> {
    totals_by_match(count, faces)
        .into_iter()
        .map(|(total, [matched, distinct])| (total, matched + distinct))
        .collect()
}

#[test]
fn doubles_its_dice_when_the_matching_landing_was_a_crit() -> T {
    let mut want = expect(
        FILE,
        "a damage rider on a dice match > doubles its dice when the matching landing was a crit",
    );
    // Orb: d20+5 vs AC 17 - hit 8/20 (3d8), crit 1/20 (6d8), miss 11/20. Rider 2d6, 4d6 on a crit.
    let orb = d20()
        .plus(5.0)?
        .ac(17.0)?
        .on_hit(roll_dice(3.0, 8.0, None)?)?;
    let t = turn(vec![atk(orb)], 0.0)?.on_dice_match_with(
        &["attack 1"],
        roll_dice(2.0, 6.0, None)?,
        rid("dm"),
    )?;

    let mut expected: BTreeMap<i64, f64> = BTreeMap::from([(0, 11.0 / 20.0)]);
    let mut add = |value: i64, mass: f64| *expected.entry(value).or_insert(0.0) += mass;
    for (chance, dice, rider) in [(8.0 / 20.0, 3, sum_of(2, 6)), (1.0 / 20.0, 6, sum_of(4, 6))] {
        for (total, [matched, distinct]) in totals_by_match(dice, 8) {
            add(total, chance * distinct);
            for (extra, p) in &rider {
                add(total + extra, chance * matched * p);
            }
        }
    }

    let mut support: BTreeSet<i64> = want.pmf(&t).support().iter().map(|d| d.0 as i64).collect();
    support.extend(expected.keys().copied());
    for value in support {
        close(
            want.pmf(&t).p_at(value as f64),
            expected.get(&value).copied().unwrap_or(0.0),
            12,
        );
    }
    close(want.mean(&t), 342371.0 / 40960.0, 12);
    want.done();
    Ok(())
}
