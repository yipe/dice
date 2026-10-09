import { cases as alongside } from './alongside'
import { cases as cappedRiders } from './cappedRiders'
import { cases as conditions } from './conditions'
import { cases as gated } from './gated'
import { cases as grantFormat } from './grantFormat'
import { cases as optional } from './optional'
import { cases as random } from './random'
import type { OracleCase } from './types'
import { cases as vulnerability } from './vulnerability'

export type { OracleCase } from './types'

/** Every acceptance case by family; the family name is the expected-JSON file name. */
export const FAMILIES: Readonly<Record<string, readonly OracleCase[]>> = {
  alongside,
  cappedRiders,
  conditions,
  gated,
  grantFormat,
  optional,
  random,
  vulnerability
}
