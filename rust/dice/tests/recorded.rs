//! Replays fixtures/recorded.jsonl: real `PMF` calls captured while the TypeScript test suite ran
//! (fixtures/record-pmf.ts). `cargo test --test recorded -- --nocapture` prints a per-op table.
//! `FIXTURE_OP`=<op> runs one op; `FIXTURE_STRICT=1` also fails on ops not ported yet.
//! Encoding (see record-pmf.ts): {"$pmf"}, {"$num"}, {"$map"}, {"$undefined"}, out {"$error"}.
//! Floats match within 1e-9 (ADR-005); PMF results compare bins and `normalized`, not identifiers.

mod common;

use common::*;
use serde_json::{Value, json};
use yipe_dice::EPS;
use yipe_dice::pmf::Pmf;

/// One recorded call against the port. `None`: op (or this argument shape) not ported yet.
fn run(op: &str, a: Option<&Value>, args: &[Value]) -> Option<Value> {
    let a = a.and_then(decode_pmf);
    let a = a.as_ref();
    let a = || a.expect("instance op has a receiver");
    let num = |i: usize| args.get(i).and_then(decode_num);
    let opt_num = |i: usize| {
        if is_absent(args.get(i)) {
            Some(None)
        } else {
            num(i).map(Some)
        }
    };
    let pmf_arg = |i: usize| args.get(i).and_then(decode_pmf);
    let string = |i: usize| args.get(i).and_then(Value::as_str);
    Some(match op {
        "mass" => enc_num(a().mass()),
        "mean" => enc_num(a().mean()),
        "variance" => enc_num(a().variance()),
        "stdev" => enc_num(a().stdev()),
        "min" => enc_num(a().min()),
        "max" => enc_num(a().max()),
        "support" => json!(a().support()),
        "fingerprint" => json!(a().fingerprint()),
        "pAt" => enc_num(a().p_at(num(0)?)),
        "hitProbability" => enc_num(a().hit_probability()),
        "missProbability" => enc_num(a().miss_probability()),
        "cdfAt" => enc_num(a().cdf_at(num(0)?)),
        "tailProbGE" => enc_num(a().tail_prob_ge(num(0)?)),
        "quantile" => enc_num(a().quantile(num(0)?)),
        "outcomes" => json!(a().outcomes()),
        "outcomeProbability" => enc_num(a().outcome_probability(string(0)?)),
        "filterOutcome" => enc_pmf(a().filter_outcome(string(0)?)),
        "normalize" => enc_pmf(a().normalize()),
        "scaleMass" => enc_pmf(a().scale_mass(num(0)?)),
        "add" => enc_pmf(a().add(&pmf_arg(0)?)),
        "addScaled" => enc_pmf(a().add_scaled(&pmf_arg(0)?, num(1)?)),
        "maxOfTwo" => enc_pmf(a().max_of_two()),
        "convolve" => {
            let raw = if is_absent(args.get(2)) {
                false
            } else {
                args.get(2)?.as_bool()?
            };
            enc_pmf(a().convolve(&pmf_arg(0)?, opt_num(1)?, raw))
        }
        "power" => match a().power(num(0)?, opt_num(1)?) {
            Ok(p) => enc_pmf(p),
            Err(e) => json!({ "$error": e.to_string() }),
        },
        "empty" => enc_pmf(Pmf::empty(opt_num(0)?.unwrap_or(EPS))),
        "zero" => enc_pmf(Pmf::zero(opt_num(0)?.unwrap_or(EPS))),
        "missNone" => enc_pmf(Pmf::miss_none(opt_num(0)?.unwrap_or(EPS))),
        "delta" => enc_result(Pmf::delta(num(0)?, opt_num(1)?.unwrap_or(EPS))),
        "emptyMass" => enc_pmf(Pmf::empty_mass()),
        "hasAttribution" => json!(a().has_attribution()),
        "outcomeMass" => enc_num(a().outcome_mass(string(0)?)),
        "faceTotal" => enc_num(a().face_total()),
        "denseSupport" => Value::Array(a().dense_support().into_iter().map(enc_num).collect()),
        "outcomeAt" => enc_num(a().outcome_at(num(0)?, string(1)?)),
        "outcomeAttributionAt" => enc_num(a().outcome_attribution_at(num(0)?, string(1)?)),
        "binAt" => match a().bin_at(num(0)?) {
            None => Value::Null,
            Some(b) => json!({
                "p": enc_num(b.p),
                "count": labels(&b.count),
                "attr": b.attr.as_ref().map_or(json!({ "$undefined": true }), labels),
            }),
        },
        "hasOutcome" => json!(a().has_outcome(string(0)?)),
        "tailProbGT" => enc_num(a().tail_prob_gt(num(0)?)),
        "branch" => enc_pmf(Pmf::branch(&pmf_arg(0)?, &pmf_arg(1)?, num(2)?)),
        "withProbability" => enc_pmf(Pmf::with_probability(&pmf_arg(0)?, num(1)?)),
        "gate" => enc_pmf(a().gate(num(0)?, &pmf_arg(1)?)),
        "exclusive" => enc_result(Pmf::exclusive(
            &options(args.first()?)?,
            opt_num(1)?.unwrap_or(EPS),
        )),
        "mix" => enc_result(Pmf::mix(
            &options(args.first()?)?,
            opt_num(1)?.unwrap_or(EPS),
        )),
        "mixN" => {
            let weights = args
                .first()?
                .as_array()?
                .iter()
                .map(|w| Some((decode_num(w.get(0)?)?, decode_pmf(w.get(1)?)?)))
                .collect::<Option<Vec<_>>>()?;
            enc_result(Pmf::mix_n(&weights, opt_num(1)?.unwrap_or(EPS)))
        }
        "withAttribution" => enc_pmf(a().with_attribution()),
        "compact" => {
            let keep = if is_absent(args.get(1)) {
                false
            } else {
                args.get(1)?.as_bool()?
            };
            enc_pmf(a().compact(opt_num(0)?, keep))
        }
        "applyHitFrequency" => enc_pmf(a().apply_hit_frequency(num(0)?)),
        "splitByDealt" => {
            let (x, y) = a().split_by_dealt();
            json!([enc_pmf(x), enc_pmf(y)])
        }
        "scaleDamage" => {
            let rounding = if is_absent(args.get(1)) {
                "floor"
            } else {
                string(1)?
            };
            enc_result(a().scale_damage(num(0)?, rounding, opt_num(2)?.unwrap_or(1.0)))
        }
        "prune" => enc_pmf(a().prune(num(0)?, opt_num(1)?.unwrap_or(0.0))),
        "rebin" => enc_pmf(a().rebin(num(0)?)),
        "convolveRaw" => enc_pmf(a().convolve_raw(&pmf_arg(0)?, opt_num(1)?)),
        "combineRaw" => enc_pmf(a().combine_raw(&pmf_arg(0)?, opt_num(1)?)),
        "convolveMany" => {
            let list = args
                .first()?
                .as_array()?
                .iter()
                .map(decode_pmf)
                .collect::<Option<Vec<_>>>()?;
            enc_pmf(Pmf::convolve_many(&list, opt_num(1)?.unwrap_or(EPS)))
        }
        _ => return None,
    })
}

/// `mix`/`exclusive` options: `[pmf, weight]` pairs or `{pmf, weight}` objects.
fn options(v: &Value) -> Option<Vec<(Pmf, f64)>> {
    v.as_array()?
        .iter()
        .map(|o| match o {
            Value::Array(pair) => Some((decode_pmf(pair.first()?)?, decode_num(pair.get(1)?)?)),
            _ => Some((decode_pmf(o.get("pmf")?)?, decode_num(o.get("weight")?)?)),
        })
        .collect()
}

#[test]
fn recorded() {
    replay("recorded.jsonl", run);
}
