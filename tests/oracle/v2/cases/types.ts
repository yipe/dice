import type { TurnSpec } from '../../../../src/turn/types'
import type { SyntheticTurn } from '../../bruteForce'
import { oracleEngineOnly, oracleTurnGaps, oracleTurnToSpec } from '../toSpec'

/** One acceptance case: the oracle's turn and the `TurnSpec` v2 the port must evaluate to the oracle's numbers. */
export interface OracleCase {
  name: string
  synthetic: SyntheticTurn
  spec: TurnSpec
  /** What the contract cannot say exactly (see `oracleTurnGaps`); a case with gaps is a todo. */
  gaps: string[]
  /** Set when the turn uses an engine feature the library will not take (see `oracleEngineOnly`): not compared, not covered. */
  engineOnly?: string
}

export const ENGINE_ONLY_REASON = 'not part of the library vocabulary'

export function oracleCase(name: string, synthetic: SyntheticTurn): OracleCase {
  const features = oracleEngineOnly(synthetic)
  return {
    name,
    synthetic,
    spec: oracleTurnToSpec(synthetic),
    gaps: oracleTurnGaps(synthetic),
    ...(features.length > 0 ? { engineOnly: `${ENGINE_ONLY_REASON} (${features.join(', ')})` } : {})
  }
}
