// The seeded sweeps of yipe/dpr conditionsVsOracle / conditionsGrantFormatVsOracle / conditionsVulnerabilityVsOracle, at
// seeds 0..199 of each generator (dpr runs them from 1000 / 7000 / 9000; the generators are the shared `conditionsRandom.ts`).
import { randomCurseTurn, randomFormatTurn, randomTurn } from '../../conditionsRandom'
import { oracleCase, type OracleCase } from './types'

export const SEEDS = 200

export const cases: OracleCase[] = [
  ...Array.from({ length: SEEDS }, (_, seed) => oracleCase(`randomTurn seed ${seed}`, randomTurn(seed))),
  ...Array.from({ length: SEEDS }, (_, seed) => oracleCase(`randomFormatTurn seed ${seed}`, randomFormatTurn(seed))),
  ...Array.from({ length: SEEDS }, (_, seed) => oracleCase(`randomCurseTurn seed ${seed}`, randomCurseTurn(seed)))
]
