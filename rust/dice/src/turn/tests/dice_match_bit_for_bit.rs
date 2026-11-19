//! `tests/dice-match-bit-for-bit.test.ts`: 2 tests (+1 for the SHA-256 below), 400 compat calls.
//!
//! Besides the compat fixture (each shape's turn PMF, bit for bit), every shape's SHA-256
//! fingerprint (`tests/fixtures/dice-match-shapes.ts`: both match descriptors' every value and the
//! turn's PMF bins, as exact bits) is compared to `tests/fixtures/dice-match-golden.json`, like the TS test.

use super::helpers::*;
use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::{Arg, RollBuilder};
use crate::common::DiceMatchInfo;
use crate::error::DiceError;
use crate::pmf::LabelMap;
use crate::turn::types::RiderOptions;
use crate::turn::{Turn, bounce, turn};
use serde_json::Value;

const FILE: &str = "tests/dice-match-bit-for-bit.test.ts";
const GOLDEN: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/dice-match-golden.json"
);

// ---- SHA-256 (the crate has no hash dependency) -------------------------------------------------

fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut message = data.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for block in message.chunks(64) {
        let mut w = [0u32; 64];
        for (i, word) in block.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let mut v = h;
        for i in 0..64 {
            let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
            let ch = (v[4] & v[5]) ^ (!v[4] & v[6]);
            let t1 = v[7]
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
            let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
            let t2 = s0.wrapping_add(maj);
            v = [
                t1.wrapping_add(t2),
                v[0],
                v[1],
                v[2],
                v[3].wrapping_add(t1),
                v[4],
                v[5],
                v[6],
            ];
        }
        for (word, add) in h.iter_mut().zip(v) {
            *word = word.wrapping_add(add);
        }
    }
    h.iter().map(|word| format!("{word:08x}")).collect()
}

// ---- tests/fixtures/dice-match-shapes.ts ---------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Crit {
    Auto,
    None,
    Explicit,
}

#[derive(Clone, Copy, PartialEq)]
enum Check {
    Ac,
    AlwaysHits,
    Advantage,
}

#[derive(Clone, Copy, PartialEq)]
enum Reader {
    Bounce,
    Rider,
    AttackRider,
    TwoAttacks,
}

struct Shape {
    count: f64,
    sides: u32,
    minimum: f64,
    reroll: f64,
    modifier: f64,
    crit: Crit,
    channel: bool,
    reroll_damage: f64,
    minimum_damage_die: f64,
    check: Check,
    bonus: f64,
    ac: f64,
    turn: Reader,
    bounce_max: f64,
}

/// `rng(seed)`: mulberry32, one `next()` per call (`Math.imul` and `>>> 0` are u32 wrapping).
fn rng(seed: u32) -> impl FnMut() -> f64 {
    let mut state = seed;
    move || {
        state = state.wrapping_add(0x6d2b79f5);
        let mut t = state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4294967296.0
    }
}

fn pick<X: Copy>(next: &mut impl FnMut() -> f64, items: &[X]) -> X {
    items[(next() * items.len() as f64).floor() as usize]
}

fn shape_at(index: u32) -> Shape {
    let mut next = rng(0x9e3779b9 ^ (index + 1).wrapping_mul(0x85ebca6b));
    // The object literal's fields are evaluated in order: sides and minimum are picked first.
    let sides = pick(&mut next, &[4, 6, 8, 8, 8, 10, 12]);
    let minimum = pick(&mut next, &[0.0, 0.0, 0.0, 2.0, 3.0]);
    let count = pick(&mut next, &[1.0, 2.0, 2.0, 3.0, 3.0, 3.0, 4.0, 5.0, 6.0]);
    let reroll = pick(&mut next, &[0.0, 0.0, 0.0, 1.0, 2.0]);
    let modifier = pick(&mut next, &[0.0, 0.0, 1.0, 3.0, 5.0]);
    let crit = pick(
        &mut next,
        &[
            Crit::Auto,
            Crit::Auto,
            Crit::Auto,
            Crit::Auto,
            Crit::None,
            Crit::Explicit,
        ],
    );
    let channel = next() < 0.25;
    let reroll_damage = pick(&mut next, &[0.0, 0.0, 0.0, 0.0, 1.0, 2.0]);
    let minimum_damage_die = pick(&mut next, &[0.0, 0.0, 0.0, 0.0, 2.0, 3.0]);
    let check = pick(
        &mut next,
        &[
            Check::Ac,
            Check::Ac,
            Check::Ac,
            Check::AlwaysHits,
            Check::Advantage,
        ],
    );
    let bonus = pick(&mut next, &[0.0, 3.0, 5.0, 7.0, 9.0]);
    let ac = pick(&mut next, &[8.0, 12.0, 15.0, 17.0, 20.0, 24.0]);
    let turn = pick(
        &mut next,
        &[
            Reader::Bounce,
            Reader::Bounce,
            Reader::Rider,
            Reader::AttackRider,
            Reader::TwoAttacks,
        ],
    );
    let bounce_max = pick(&mut next, &[1.0, 2.0, 3.0]);
    Shape {
        count,
        sides,
        minimum,
        reroll,
        modifier,
        crit,
        channel,
        reroll_damage,
        minimum_damage_die,
        check,
        bonus,
        ac,
        turn,
        bounce_max,
    }
}

/// `roll(count, die)`.
fn pool(count: f64, die: RollBuilder) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Die(die)), None)
}

fn attack_of(shape: &Shape) -> Result<AttackBuilder, DiceError> {
    let die = match shape.sides {
        4 => d4(),
        6 => d6(),
        8 => d8(),
        10 => d10(),
        _ => d12(),
    };
    let faces = die.reroll(shape.reroll)?.minimum(shape.minimum)?;
    let payload = pool(shape.count, faces.clone())?.plus(shape.modifier)?;
    let check = match shape.check {
        Check::AlwaysHits => d20().always_hits()?,
        Check::Advantage => d20().with_advantage()?.plus(shape.bonus)?.ac(shape.ac)?,
        Check::Ac => d20().plus(shape.bonus)?.ac(shape.ac)?,
    };
    let mut attack = check.on_hit(payload)?;
    if shape.crit == Crit::None {
        attack = attack.no_crit()?;
    }
    if shape.crit == Crit::Explicit {
        let crit = pool(2.0 * shape.count + 1.0, faces)?.plus(shape.modifier)?;
        attack = attack.on_crit(&[Arg::Roll(crit)])?;
    }
    if shape.channel {
        attack = attack.plus_separate_damage(pool(1.0, d6())?);
    }
    if shape.reroll_damage > 0.0 {
        attack = attack.reroll_damage(shape.reroll_damage)?;
    }
    if shape.minimum_damage_die > 0.0 {
        attack = attack.minimum_damage_die(shape.minimum_damage_die)?;
    }
    Ok(attack)
}

fn turn_of(shape: &Shape) -> Result<Turn, Box<dyn std::error::Error>> {
    let source = attack_of(shape)?;
    let attack_1 = ["attack 1"];
    Ok(match shape.turn {
        Reader::Bounce => bounce(source.into(), shape.bounce_max)?,
        Reader::Rider => turn(vec![atk(source)], 0.0)?.on_dice_match_with(
            &attack_1,
            pool(2.0, d6())?.plus(1.0)?,
            rid("on match"),
        )?,
        Reader::AttackRider => turn(vec![atk(source)], 0.0)?.on_dice_match_with(
            &attack_1,
            d20().plus(6.0)?.ac(14.0)?.on_hit(pool(2.0, d8())?)?,
            rid("follow"),
        )?,
        Reader::TwoAttacks => turn(
            vec![
                atk(source),
                atk(d20().plus(4.0)?.ac(15.0)?.on_hit(pool(1.0, d8())?)?),
            ],
            0.0,
        )?
        .on_dice_match_with(
            &attack_1,
            pool(1.0, d8())?,
            RiderOptions {
                id: Some("on match".into()),
                ..RiderOptions::default()
            },
        )?,
    })
}

// ---- the fingerprint: JSON.stringify of { hit, crit, pmf } --------------------------------------

fn bits(x: f64) -> String {
    format!("\"{:016x}\"", x.to_bits())
}

/// A JS number as `JSON.stringify` writes it (every damage here is a small integer).
fn js_number(x: f64) -> String {
    if x == 0.0 {
        "0".to_string()
    } else if x.fract() == 0.0 {
        format!("{}", x as i64)
    } else {
        format!("{x}")
    }
}

fn map_bits(info: Option<&DiceMatchInfo>) -> String {
    let Some(info) = info else {
        return "null".to_string();
    };
    let mut rows: Vec<(f64, f64)> = info
        .match_probability_by_damage
        .iter()
        .map(|(d, p)| (d.0, *p))
        .collect();
    rows.sort_by(|a, b| a.0.total_cmp(&b.0));
    let rows: Vec<String> = rows
        .iter()
        .map(|(d, p)| format!("[{},{}]", js_number(*d), bits(*p)))
        .collect();
    format!("[{}]", rows.join(","))
}

fn label_bits(map: Option<&LabelMap>) -> String {
    let Some(map) = map else {
        return "null".to_string();
    };
    let mut rows: Vec<(&String, f64)> = map.iter().map(|(k, v)| (k, *v)).collect();
    rows.sort_by(|a, b| a.0.cmp(b.0));
    let rows: Vec<String> = rows
        .iter()
        .map(|(label, v)| format!("[{},{}]", Value::String((*label).clone()), bits(*v)))
        .collect();
    format!("[{}]", rows.join(","))
}

fn pmf_bits(pmf: &Pmf) -> String {
    let rows: Vec<String> = pmf
        .support()
        .into_iter()
        .filter_map(|d| pmf.map.get(&d).map(|bin| (d, bin)))
        .map(|(d, bin)| {
            format!(
                "[{},{},{},{}]",
                js_number(d.0),
                bits(bin.p),
                label_bits(Some(&bin.count)),
                label_bits(bin.attr.as_ref())
            )
        })
        .collect();
    format!("[{}]", rows.join(","))
}

fn golden() -> Result<Vec<(u32, String)>, Box<dyn std::error::Error>> {
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(GOLDEN)?)?;
    let object = raw.as_object().ok_or("the golden file is not an object")?;
    let mut entries: Vec<(u32, String)> = Vec::new();
    for (index, digest) in object {
        entries.push((
            index.parse()?,
            digest
                .as_str()
                .ok_or("a digest is not a string")?
                .to_string(),
        ));
    }
    // JS orders integer keys ascending.
    entries.sort();
    Ok(entries)
}

#[test]
fn pins_400_shapes() -> T {
    assert_eq!(golden()?.len(), 400);
    Ok(())
}

#[test]
fn moves_none_of_them() -> T {
    let mut want = expect(
        FILE,
        "dice-match descriptors and the turns that read them are bit for bit what 0.15.0 computed > moves none of them",
    );
    let mut moved: Vec<u32> = Vec::new();
    for (index, digest) in golden()? {
        let shape = shape_at(index);
        let source = attack_of(&shape)?;
        let (hit, crit) = source.dice_match_info(0.0)?;
        let pmf = want.pmf(&turn_of(&shape)?);
        let signature = format!(
            "{{\"hit\":{},\"crit\":{},\"pmf\":{}}}",
            map_bits(hit.as_ref()),
            map_bits(crit.as_ref()),
            pmf_bits(&pmf)
        );
        if sha256_hex(signature.as_bytes()) != digest {
            moved.push(index);
        }
    }
    assert_eq!(moved, Vec::<u32>::new());
    want.done();
    Ok(())
}

#[test]
fn sha256_matches_the_known_vectors() {
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}
