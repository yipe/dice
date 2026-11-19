//! `tests/attribution-conservation.test.ts`: 13 tests, 2 compat calls. Uses the real
//! `Pmf::damage_attribution_chart_model` (the copies in `builder/tests/t_row_facts.rs` predate it and stay).

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::Arg;
use crate::error::DiceError;
use crate::parser::parse_with;
use crate::pmf::{ChartModelOptions, DamageAttributionChartModel};
use crate::turn::turn;
use crate::{DiceQuery, EPS, Pmf};

const FILE: &str = "tests/attribution-conservation.test.ts";

/// d20+8 vs AC 16, 1d6+5 — the attack the review measured the bug with.
fn sword() -> Result<AttackBuilder, DiceError> {
    d20()
        .plus(8.0)?
        .ac(16.0)?
        .on_hit(roll_dice(1.0, 6.0, None)?.plus(5.0)?)
}

fn model(pmf: &Pmf) -> Result<DamageAttributionChartModel, DiceError> {
    pmf.damage_attribution_chart_model(&ChartModelOptions::default())
}

/// Sum of a chart model's bucket totals, which must equal the PMF's mass.
fn chart_mass(pmf: &Pmf) -> Result<f64, DiceError> {
    Ok(model(pmf)?.totals.iter().fold(0.0, |a, b| a + b))
}

fn series<'a>(m: &'a DamageAttributionChartModel, label: &str) -> Result<&'a Vec<f64>, DiceError> {
    m.series
        .get(label)
        .ok_or_else(|| DiceError::error(format!("no series {label}")))
}

fn shares<'a>(m: &'a DamageAttributionChartModel, label: &str) -> Result<&'a Vec<f64>, DiceError> {
    m.shares
        .get(label)
        .ok_or_else(|| DiceError::error(format!("no shares {label}")))
}

fn bin_of(m: &DamageAttributionChartModel, label: f64) -> Result<usize, DiceError> {
    m.labels
        .iter()
        .position(|l| *l == label)
        .ok_or_else(|| DiceError::error(format!("no bucket {label}")))
}

#[test]
fn convolve_many_sum_bucket_totals_equals_mass() -> T {
    let conv = Pmf::convolve_many(&[sword()?.pmf()?, sword()?.pmf()?], EPS);
    close(conv.mass(), 1.0, 12);
    close(chart_mass(&conv)?, 1.0, 12);
    Ok(())
}

#[test]
fn turn_pmf_sum_bucket_totals_equals_mass() -> T {
    let mut want = expect(
        FILE,
        "attribution chart conserves mass for convolved PMFs > Turn.pmf: Σ bucket totals = mass",
    );
    let t = turn(vec![atk(sword()?), atk(sword()?)], 0.0)?;
    close(want.pmf(&t).mass(), 1.0, 12);
    close(chart_mass(&want.pmf(&t))?, 1.0, 12);
    want.done();
    Ok(())
}

#[test]
fn provided_combined_sum_bucket_totals_equals_mass() -> T {
    let singles = vec![sword()?.pmf()?, sword()?.pmf()?];
    let q = DiceQuery::new(
        singles.clone(),
        Some(Pmf::convolve_many(&singles, EPS)),
        EPS,
    );
    close(chart_mass(&q.combined_with_attribution())?, 1.0, 12);
    Ok(())
}

#[test]
fn frequency_gated_row_sum_bucket_totals_equals_mass() -> T {
    let gated = sword()?.pmf()?.apply_hit_frequency(0.5);
    let singles = vec![gated, sword()?.pmf()?];
    let q = DiceQuery::new(
        singles.clone(),
        Some(Pmf::convolve_many(&singles, EPS)),
        EPS,
    );
    close(chart_mass(&q.combined_with_attribution())?, 1.0, 12);
    Ok(())
}

#[test]
fn a_guaranteed_miss_convolved_with_an_always_10_hit_attributes_the_bin_entirely_to_hit() -> T {
    // The miss deals 0, so the 10-damage bin is 100% hit and 0% missNone, not the 50/50 count split.
    let always10 = d20().always_hits()?.on_hit(flat(10.0)?)?.no_crit()?;
    let m = DiceQuery::of(vec![Pmf::miss_none(EPS), always10.pmf()?])
        .damage_attribution_chart_model(&ChartModelOptions::default())?;
    let bin = bin_of(&m, 10.0)?;
    close(shares(&m, "hit")?[bin], 1.0, 12);
    assert_eq!(shares(&m, "missNone")?[bin], 0.0);
    Ok(())
}

#[test]
fn a_crit_11_and_a_hit_6_that_share_a_17_damage_bin_split_11_17_and_6_17() -> T {
    // Damage share, not outcome-count share: the crit dealt 11 of the 17 total, the hit 6.
    let crit11 = d20().always_hits()?.always_crits()?.on_hit(flat(11.0)?)?;
    let hit6 = d20().always_hits()?.on_hit(flat(6.0)?)?.no_crit()?;
    let m = DiceQuery::of(vec![crit11.pmf()?, hit6.pmf()?])
        .damage_attribution_chart_model(&ChartModelOptions::default())?;
    let bin = bin_of(&m, 17.0)?;
    close(shares(&m, "crit")?[bin], 11.0 / 17.0, 12);
    close(shares(&m, "hit")?[bin], 6.0 / 17.0, 12);
    Ok(())
}

#[test]
fn single_builder_pmf_keeps_its_per_value_hit_crit_miss_none_splits() -> T {
    let m = model(&sword()?.pmf()?)?;
    assert_eq!(m.outcomes, vec!["missNone", "hit", "crit"]);
    // Miss at 0 is the full miss mass.
    close(series(&m, "missNone")?[0], 0.35, 12);
    // At 6, only a plain hit lands (0.1), so the whole bin is hit.
    close(series(&m, "hit")?[6], 0.1, 12);
    // At 7, a hit (0.1) and the start of the crit range coexist; a single source splits by damage share,
    // which equals its count weights, so hit keeps its full 0.1.
    close(series(&m, "hit")?[7], 0.1, 12);
    close(series(&m, "crit")?[7], 0.0013888888888888885, 12);
    close(m.totals[7], 0.1 + 0.0013888888888888885, 12);
    Ok(())
}

#[test]
fn single_parsed_pmf_keeps_its_per_value_splits() -> T {
    let m = model(&parse_with("d20+8 AC 16 * (1d6+5)", 0.0)?)?;
    close(series(&m, "hit")?[6], 0.1, 12);
    close(series(&m, "missNone")?[0], 0.35, 12);
    Ok(())
}

#[test]
fn dice_query_singles_path_keeps_its_per_value_splits() -> T {
    let m = DiceQuery::of(vec![sword()?.pmf()?])
        .damage_attribution_chart_model(&ChartModelOptions::default())?;
    close(series(&m, "hit")?[6], 0.1, 12);
    close(series(&m, "missNone")?[0], 0.35, 12);
    Ok(())
}

fn zero_hit() -> Result<AttackBuilder, DiceError> {
    d20().plus(5.0)?.ac(15.0)?.on_hit(flat(0.0)?)
}

#[test]
fn a_zero_damage_hit_conserves_mass_and_credits_hit_and_crit_at_0() -> T {
    let pmf = zero_hit()?.pmf()?;
    let m = model(&pmf)?;
    // d20+5 vs AC 15: 0.45 miss / 0.5 hit / 0.05 crit, all landing at 0.
    close(chart_mass(&pmf)?, 1.0, 12);
    close(series(&m, "missNone")?[0], 0.45, 12);
    close(series(&m, "hit")?[0], 0.5, 12);
    close(series(&m, "crit")?[0], 0.05, 12);
    Ok(())
}

#[test]
fn a_zero_damage_source_convolved_with_a_normal_attack_conserves_mass() -> T {
    let conv = Pmf::convolve_many(&[zero_hit()?.pmf()?, sword()?.pmf()?], EPS);
    close(conv.mass(), 1.0, 12);
    close(chart_mass(&conv)?, 1.0, 12);
    Ok(())
}

#[test]
fn a_normal_attacks_0_bin_is_still_100_percent_miss_none() -> T {
    let m = model(&sword()?.pmf()?)?;
    close(shares(&m, "missNone")?[0], 1.0, 12);
    assert_eq!(series(&m, "hit")?[0], 0.0);
    assert_eq!(series(&m, "crit")?[0], 0.0);
    Ok(())
}

#[test]
fn a_negative_damage_hit_convolved_with_a_positive_save_falls_back_to_count() -> T {
    // A hit that always deals -1 convolved with a save that always deals 3 lands at damage 2 with
    // attr { hit: -1, saveFail: 3 }; the split falls back to count, so each label keeps half.
    let neg_hit = d20().always_hits()?.on_hit(flat(-1.0)?)?.no_crit()?;
    let pos_save = flat(10.0)?
        .dc(12.0)?
        .on_save_failure_args(&[Arg::Roll(flat(3.0)?)])?;
    let pmf = DiceQuery::of(vec![neg_hit.pmf()?, pos_save.pmf()?]).combined_with_attribution();
    close(chart_mass(&pmf)?, 1.0, 12);
    let m = model(&pmf)?;
    let bin = bin_of(&m, 2.0)?;
    assert_eq!(bin, 0);
    close(series(&m, "hit")?[bin], 0.5, 12);
    close(series(&m, "saveFail")?[bin], 0.5, 12);
    Ok(())
}
