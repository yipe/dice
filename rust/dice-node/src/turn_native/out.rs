//! Reader results as plain JS data (TS shapes from `src/turn/{turn,readers,trace}.ts`), built through
//! the raw layer so PMF handles can sit inside the objects.

use std::sync::Arc;

use yipe_dice::Pmf;
use yipe_dice::common::RollType;
use yipe_dice::turn::plan::EffectSource;
use yipe_dice::turn::readers::{EFFECT_NAMES, LandingPattern, RowLanding};
use yipe_dice::turn::trace::{DieBy, DieRole, OutcomeResult, Trace};
use yipe_dice::turn::{Marginal, StepStats};

use super::js::{Js, Val};
use crate::DiceError;
use crate::pmf::NativePmf;

type Res = Result<Val, DiceError>;

fn list<T>(js: &Js, items: &[T], each: impl Fn(&T) -> Res) -> Res {
    let array = js.array(items.len())?;
    for (i, item) in items.iter().enumerate() {
        js.set_index(array, i, each(item)?)?;
    }
    Ok(array)
}

fn num(js: &Js, o: Val, name: &str, x: f64) -> Result<(), DiceError> {
    js.set(o, name, js.double(x)?)
}

fn text(js: &Js, o: Val, name: &str, s: &str) -> Result<(), DiceError> {
    js.set(o, name, js.string(s)?)
}

fn row_landing(js: &Js, l: &RowLanding) -> Res {
    let o = js.object()?;
    num(js, o, "hit", l.hit)?;
    num(js, o, "crit", l.crit)?;
    let doubled = js.object()?;
    num(js, doubled, "hit", l.doubled.hit)?;
    num(js, doubled, "crit", l.doubled.crit)?;
    js.set(o, "doubled", doubled)?;
    Ok(o)
}

/// `AttackMarginal | RiderMarginal` with `kind` and PMFs as native handles.
pub fn marginal(js: &Js, m: &Marginal) -> Res {
    let o = js.object()?;
    match m {
        Marginal::Attack(a) => {
            text(js, o, "kind", "attack")?;
            js.set(o, "pmf", js.class(NativePmf::wrap_shared(a.pmf.clone()))?)?;
            js.set(
                o,
                "whenHappens",
                js.class(NativePmf::wrap_shared(a.when_happens.clone()))?,
            )?;
            num(js, o, "occurs", a.occurs)?;
            // `[flat, advantage, disadvantage, elven accuracy]`; the facade builds the keyed object.
            let types = [
                RollType::Flat,
                RollType::Advantage,
                RollType::Disadvantage,
                RollType::ElvenAccuracy,
            ];
            let roll_type = js.array(types.len())?;
            for (i, t) in types.into_iter().enumerate() {
                js.set_index(roll_type, i, js.double(a.roll_type(t))?)?;
            }
            js.set(o, "rollType", roll_type)?;
        }
        Marginal::Rider(r) => {
            text(js, o, "kind", "rider")?;
            js.set(o, "pmf", js.class(NativePmf::wrap(r.pmf.clone()))?)?;
            let entries: Vec<(&String, &RowLanding)> = r.landings.iter().collect();
            let pairs = list(js, &entries, |(key, landing)| {
                let pair = js.array(2)?;
                js.set_index(pair, 0, js.string(key)?)?;
                js.set_index(pair, 1, row_landing(js, landing)?)?;
                Ok(pair)
            })?;
            js.set(o, "landings", pairs)?;
            num(js, o, "anyLanding", r.any_landing)?;
        }
    }
    Ok(o)
}

/// The address of a shared PMF, as `NativePmf#sharedId` answers it (the facade's `sharedWrappers` key).
fn address(pmf: &Arc<Pmf>) -> f64 {
    Arc::as_ptr(pmf) as usize as f64
}

/// An attack's marginal packed as numbers, for a facade that already holds most of its PMFs:
/// `[occurs, rollTypeIdx, pmfAddr, whenAddr]`, or with `rollTypeIdx == -1` (the d20 odds are a mix)
/// `[occurs, -1, pmfAddr, whenAddr, flat, advantage, disadvantage, elven accuracy]`. A rider's
/// marginal is the object [`marginal`] builds.
///
/// An address stands for its PMF while any JS wrapper of it is alive (the wrapper holds the `Arc`, so
/// the allocation cannot be freed and reused by another PMF): the facade trusts an address only when
/// the wrapper it maps to is alive, as with `sharedId`. For a miss it asks `NativeTurn#marginalPmf`,
/// which answers the very `Arc` the turn memoizes, at this address.
pub fn marginal_packed(js: &Js, m: &Marginal) -> Res {
    let Marginal::Attack(a) = m else {
        return marginal(js, m);
    };
    let pure = a.roll_type.iter().position(|&x| x == 1.0).filter(|&at| {
        a.roll_type
            .iter()
            .enumerate()
            .all(|(i, &x)| i == at || (x == 0.0 && x.is_sign_positive()))
    });
    let packed = js.array(if pure.is_some() { 4 } else { 8 })?;
    js.set_index(packed, 0, js.double(a.occurs)?)?;
    js.set_index(packed, 1, js.double(pure.map_or(-1.0, |at| at as f64))?)?;
    js.set_index(packed, 2, js.double(address(&a.pmf))?)?;
    js.set_index(packed, 3, js.double(address(&a.when_happens))?)?;
    if pure.is_none() {
        for (i, x) in a.roll_type.iter().enumerate() {
            js.set_index(packed, 4 + i, js.double(*x)?)?;
        }
    }
    Ok(packed)
}

fn effect_source(js: &Js, s: &EffectSource) -> Res {
    let o = js.object()?;
    match s {
        EffectSource::Starting => text(js, o, "kind", "starting")?,
        EffectSource::Grant(id) => {
            text(js, o, "kind", "grant")?;
            text(js, o, "grant", id)?;
        }
    }
    Ok(o)
}

/// `StepStats`: `live` holds the odds of every effect and `sources` the part each source accounts for.
/// A stateless one (no effect odds, no sources, no conditions) crosses as `[rolled, hit, crit]`; the
/// facade rebuilds the shared-constant object (`stepStatsOf` in `ts/turn/batch.ts`).
pub fn step_stats(js: &Js, s: &StepStats) -> Res {
    let stateless = s.conditions.is_empty()
        && EFFECT_NAMES
            .iter()
            .all(|name| s.live.odds(*name).to_bits() == 0 && s.live.sources(*name).is_empty());
    if stateless {
        let a = js.array(3)?;
        for (i, x) in [s.rolled, s.hit, s.crit].into_iter().enumerate() {
            js.set_index(a, i, js.double(x)?)?;
        }
        return Ok(a);
    }
    let o = js.object()?;
    num(js, o, "rolled", s.rolled)?;
    num(js, o, "hit", s.hit)?;
    num(js, o, "crit", s.crit)?;
    let live = js.object()?;
    let sources = js.object()?;
    for name in EFFECT_NAMES {
        num(js, live, name.as_str(), s.live.odds(name))?;
        let each = list(js, s.live.sources(name), |entry| {
            let e = js.object()?;
            js.set(e, "source", effect_source(js, &entry.source)?)?;
            num(js, e, "odds", entry.odds)?;
            Ok(e)
        })?;
        js.set(sources, name.as_str(), each)?;
    }
    js.set(live, "sources", sources)?;
    js.set(o, "live", live)?;
    let conditions = list(js, &s.conditions, |c| {
        let e = js.object()?;
        text(js, e, "id", &c.id)?;
        num(js, e, "attempted", c.attempted)?;
        num(js, e, "taken", c.taken)?;
        Ok(e)
    })?;
    js.set(o, "conditions", conditions)?;
    Ok(o)
}

/// `LandingPattern[]`.
pub fn landings(js: &Js, patterns: &[LandingPattern]) -> Res {
    list(js, patterns, |p| {
        let o = js.object()?;
        text(js, o, "label", &p.label)?;
        js.set(o, "dealt", js.boolean(p.dealt)?)?;
        js.set(o, "riders", list(js, &p.riders, |r| js.string(r))?)?;
        num(js, o, "mass", p.mass)?;
        Ok(o)
    })
}

fn role(r: DieRole) -> &'static str {
    match r {
        DieRole::Attack => "attack",
        DieRole::Save => "save",
        DieRole::Damage => "damage",
        DieRole::Rider => "rider",
        DieRole::Reroll => "reroll",
    }
}

fn result(r: OutcomeResult) -> &'static str {
    match r {
        OutcomeResult::Hit => "hit",
        OutcomeResult::Crit => "crit",
        OutcomeResult::Miss => "miss",
        OutcomeResult::SaveFail => "save-fail",
        OutcomeResult::SavePass => "save-pass",
        OutcomeResult::Fired => "fired",
        OutcomeResult::Skipped => "skipped",
    }
}

/// A `Trace`.
pub fn trace(js: &Js, t: &Trace) -> Res {
    let o = js.object()?;
    num(js, o, "total", t.total)?;
    num(js, o, "samplerVersion", t.sampler_version)?;
    let waves = list(js, &t.waves, |w| {
        let wave = js.object()?;
        let dice = list(js, &w.dice, |d| {
            let die = js.object()?;
            num(js, die, "sides", d.sides)?;
            num(js, die, "face", d.face)?;
            text(js, die, "role", role(d.role))?;
            text(
                js,
                die,
                "by",
                if d.by == DieBy::You { "you" } else { "enemy" },
            )?;
            text(js, die, "source", &d.source)?;
            js.set(die, "kept", js.boolean(d.kept)?)?;
            Ok(die)
        })?;
        js.set(wave, "dice", dice)?;
        let outcomes = list(js, &w.outcomes, |x| {
            let out = js.object()?;
            text(js, out, "source", &x.source)?;
            text(js, out, "result", result(x.result))?;
            num(js, out, "damage", x.damage)?;
            Ok(out)
        })?;
        js.set(wave, "outcomes", outcomes)?;
        Ok(wave)
    })?;
    js.set(o, "waves", waves)?;
    Ok(o)
}

/// `{ groupCount, stateCounts }`.
pub fn inspection(js: &Js, group_count: usize, counts: &[usize]) -> Res {
    let o = js.object()?;
    num(js, o, "groupCount", group_count as f64)?;
    js.set(
        o,
        "stateCounts",
        list(js, counts, |n| js.double(*n as f64))?,
    )?;
    Ok(o)
}
