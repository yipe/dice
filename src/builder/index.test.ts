import { describe, expect, it } from 'vitest'
import { d4, d6, roll } from './index'
import { RollBuilder } from './roll'

describe('Builder/index.ts - Roll Factory', () => {
  describe('roll factory function', () => {
    it('should create RollBuilder with count only', () => {
      const builder = roll(3)
      expect(builder).toBeInstanceOf(RollBuilder)
      expect(builder.toExpression()).toBe('0') // RollBuilder(3) creates empty builder, count is not used
    })

    it('should create RollBuilder with count and sides', () => {
      const builder = roll(2, 6)
      expect(builder).toBeInstanceOf(RollBuilder)
      expect(builder.toExpression()).toBe('2d6')
    })

    it('should create RollBuilder with count, sides, and modifier', () => {
      const builder = roll(3, 8, 4)
      expect(builder).toBeInstanceOf(RollBuilder)
      expect(builder.toExpression()).toBe('3d8 + 4')
    })

    it('should handle zero count', () => {
      const builder = roll(0)
      expect(builder).toBeInstanceOf(RollBuilder)
      expect(builder.toExpression()).toBe('0')
    })

    it('should handle zero sides (should not add dice)', () => {
      const builder = roll(2, 0)
      expect(builder).toBeInstanceOf(RollBuilder)
      expect(builder.toExpression()).toBe('0') // No dice added, so empty builder
    })

    it('should handle negative sides (should not add dice)', () => {
      const builder = roll(3, -1)
      expect(builder).toBeInstanceOf(RollBuilder)
      expect(builder.toExpression()).toBe('0') // No dice added, so empty builder
    })

    it('should handle zero modifier', () => {
      const builder = roll(2, 6, 0)
      expect(builder).toBeInstanceOf(RollBuilder)
      expect(builder.toExpression()).toBe('2d6')
    })

    it('should handle negative modifier', () => {
      const builder = roll(4, 6, -2)
      expect(builder).toBeInstanceOf(RollBuilder)
      expect(builder.toExpression()).toBe('4d6 - 2')
    })

    it('should handle undefined sides parameter', () => {
      const builder = roll(2, undefined)
      expect(builder).toBeInstanceOf(RollBuilder)
      expect(builder.toExpression()).toBe('0') // No dice added, so empty builder
    })

    it('should handle undefined modifier parameter', () => {
      const builder = roll(3, 8, undefined)
      expect(builder).toBeInstanceOf(RollBuilder)
      expect(builder.toExpression()).toBe('3d8')
    })

    it('should handle all undefined parameters except count', () => {
      const builder = roll(5, undefined, undefined)
      expect(builder).toBeInstanceOf(RollBuilder)
      expect(builder.toExpression()).toBe('0') // No dice added, so empty builder
    })
  })

  describe('roll(count, die: RollBuilder, modifier?)', () => {
    it('should handle a complex RollBuilder, applying count to all parts', () => {
      const complexDie = d6.plus(d4) // 1d6 + 1d4
      const builder = roll(2, complexDie) // should be 2d6 + 2d4
      expect(builder.toExpression()).toBe('2d6 + 2d4')
      const pmf = builder.toPMF()
      expect(pmf.min()).toBe(4) // 2*1 + 2*1
      expect(pmf.max()).toBe(20) // 2*6 + 2*4
      expect(pmf.mean()).toBeCloseTo(12) // 2*3.5 + 2*2.5
    })

    it('should scale modifiers on all parts of a complex roll', () => {
      const complexDie = roll.d(8).plus(2).add(roll.d(6).plus(1)) // 1d8+2 + 1d6+1
      const builder = roll(3, complexDie) // should be 3d8+6 + 3d6+3 = 3d8+3d6+9
      expect(builder.toExpression()).toBe('3d8 + 3d6 + 9')
      const pmf = builder.toPMF()
      expect(pmf.min()).toBe(15) // 3*1 + 3*1 + 9
      expect(pmf.max()).toBe(51) // 3*8 + 3*6 + 9
      expect(pmf.mean()).toBeCloseTo(33) // 3*4.5 + 3*3.5 + 9
    })

    it('should handle an empty RollBuilder, ignoring count and applying modifier', () => {
      const emptyBuilder = new RollBuilder(0)
      const builder = roll(2, emptyBuilder, 5)
      expect(builder.toExpression()).toBe('5')
      const pmf = builder.toPMF()
      expect(pmf.min()).toBe(5)
      expect(pmf.max()).toBe(5)
    })

    it('should handle a RollBuilder with only a modifier', () => {
      const flatFive = roll.flat(5)
      const builder = roll(3, flatFive, 2)
      expect(builder.toExpression()).toBe('17') // 3 * 5 + 2
      const pmf = builder.toPMF()
      expect(pmf.min()).toBe(17)
      expect(pmf.max()).toBe(17)
    })

    it('should correctly apply modifier to the whole new roll', () => {
      const complexDie = d6.plus(d4) // 1d6 + 1d4
      const builder = roll(2, complexDie, 5) // should be 2d6 + 2d4 + 5
      expect(builder.toExpression()).toBe('2d6 + 2d4 + 5')
      const pmf = builder.toPMF()
      expect(pmf.min()).toBe(9)
      expect(pmf.max()).toBe(25)
      expect(pmf.mean()).toBeCloseTo(17)
    })
  })

  describe('roll factory methods', () => {
    describe('roll.d() method', () => {
      it('should create single die with specified sides', () => {
        const builder = roll.d(6)
        expect(builder).toBeInstanceOf(RollBuilder)
        expect(builder.toExpression()).toBe('1d6')
      })

      it('should handle different die types', () => {
        expect(roll.d(4).toExpression()).toBe('1d4')
        expect(roll.d(8).toExpression()).toBe('1d8')
        expect(roll.d(10).toExpression()).toBe('1d10')
        expect(roll.d(12).toExpression()).toBe('1d12')
        expect(roll.d(20).toExpression()).toBe('d20') // d20 is formatted without count
        expect(roll.d(100).toExpression()).toBe('1d100') // d100 is formatted with count
      })

      it('should handle zero and negative sides', () => {
        expect(roll.d(0).toExpression()).toBe('0')
        expect(roll.d(-1).toExpression()).toBe('0')
      })
    })

    describe('roll.d4() method', () => {
      it('should create single d4', () => {
        const builder = roll.d4()
        expect(builder).toBeInstanceOf(RollBuilder)
        expect(builder.toExpression()).toBe('1d4')
      })
    })

    describe('roll.d6() method', () => {
      it('should create single d6', () => {
        const builder = roll.d6()
        expect(builder).toBeInstanceOf(RollBuilder)
        expect(builder.toExpression()).toBe('1d6')
      })
    })

    describe('roll.d8() method', () => {
      it('should create single d8', () => {
        const builder = roll.d8()
        expect(builder).toBeInstanceOf(RollBuilder)
        expect(builder.toExpression()).toBe('1d8')
      })
    })

    describe('roll.d10() method', () => {
      it('should create single d10', () => {
        const builder = roll.d10()
        expect(builder).toBeInstanceOf(RollBuilder)
        expect(builder.toExpression()).toBe('1d10')
      })
    })

    describe('roll.d12() method', () => {
      it('should create single d12', () => {
        const builder = roll.d12()
        expect(builder).toBeInstanceOf(RollBuilder)
        expect(builder.toExpression()).toBe('1d12')
      })
    })

    describe('roll.d20() method', () => {
      it('should create single d20', () => {
        const builder = roll.d20()
        expect(builder).toBeInstanceOf(RollBuilder)
        expect(builder.toExpression()).toBe('d20') // d20 is formatted without count
      })
    })

    describe('roll.d100() method', () => {
      it('should create single d100', () => {
        const builder = roll.d100()
        expect(builder).toBeInstanceOf(RollBuilder)
        expect(builder.toExpression()).toBe('1d100') // d100 is formatted with count
      })
    })

    describe('roll.flat() method', () => {
      it('should create flat amount with positive number', () => {
        const builder = roll.flat(5)
        expect(builder).toBeInstanceOf(RollBuilder)
        expect(builder.toExpression()).toBe('5')
      })

      it('should create flat amount with zero', () => {
        const builder = roll.flat(0)
        expect(builder).toBeInstanceOf(RollBuilder)
        expect(builder.toExpression()).toBe('0')
      })

      it('should create flat amount with negative number', () => {
        const builder = roll.flat(-3)
        expect(builder).toBeInstanceOf(RollBuilder)
        expect(builder.toExpression()).toBe('-3')
      })

      it('should handle decimal numbers', () => {
        const builder = roll.flat(2.5)
        expect(builder).toBeInstanceOf(RollBuilder)
        expect(builder.toExpression()).toBe('2.5')
      })
    })
  })

  describe('roll factory type safety', () => {
    it('should have correct RollFactory type', () => {
      // Test that the factory has all expected methods
      expect(typeof roll).toBe('function')
      expect(typeof roll.d).toBe('function')
      expect(typeof roll.d4).toBe('function')
      expect(typeof roll.d6).toBe('function')
      expect(typeof roll.d8).toBe('function')
      expect(typeof roll.d10).toBe('function')
      expect(typeof roll.d12).toBe('function')
      expect(typeof roll.d20).toBe('function')
      expect(typeof roll.d100).toBe('function')
      expect(typeof roll.flat).toBe('function')
    })

    it('should return RollBuilder instances from all methods', () => {
      const builders = [roll(2, 6, 3), roll.d(8), roll.d4(), roll.d6(), roll.d8(), roll.d10(), roll.d12(), roll.d20(), roll.d100(), roll.flat(7)]

      builders.forEach((builder) => {
        expect(builder).toBeInstanceOf(RollBuilder)
      })
    })
  })

  describe('roll factory edge cases', () => {
    it('should handle very large numbers', () => {
      const builder = roll(1000, 6, 500)
      expect(builder).toBeInstanceOf(RollBuilder)
      expect(builder.toExpression()).toBe('1000d6 + 500')
    })

    it('should handle very small numbers', () => {
      const builder = roll(1, 1, 1)
      expect(builder).toBeInstanceOf(RollBuilder)
      expect(builder.toExpression()).toBe('1d1 + 1')
    })

    it('should handle floating point numbers', () => {
      const builder = roll(2.5, 6, 1.5)
      expect(builder).toBeInstanceOf(RollBuilder)
      expect(builder.toExpression()).toBe('2.5d6 + 1.5')
    })

    it('should handle negative count', () => {
      const builder = roll(-2, 6, 3)
      expect(builder).toBeInstanceOf(RollBuilder)
      expect(builder.toExpression()).toBe('-2d6 + 3')
    })

    it('should handle negative modifier with zero sides', () => {
      const builder = roll(3, 0, -5)
      expect(builder).toBeInstanceOf(RollBuilder)
      expect(builder.toExpression()).toBe('-5') // No dice added, only modifier
    })
  })

  describe('roll factory chaining', () => {
    it('should allow chaining with other RollBuilder methods', () => {
      const builder = roll(2, 6).plus(3).withAdvantage()
      expect(builder).toBeInstanceOf(RollBuilder)
      expect(builder.toExpression()).toBe('d6 > d6 + 3') // Only one die is used in advantage
    })

    it('should allow chaining flat amounts with other methods', () => {
      const builder = roll.flat(10).plus(5).withDisadvantage()
      expect(builder).toBeInstanceOf(RollBuilder)
      expect(builder.toExpression()).toBe('15') // Flat amounts don't chain with advantage/disadvantage
    })

    it('should allow chaining single dice with other methods', () => {
      const builder = roll.d20().plus(4).withAdvantage()
      expect(builder).toBeInstanceOf(RollBuilder)
      expect(builder.toExpression()).toBe('d20 > d20 + 4')
    })
  })

  describe('roll factory mathematical correctness', () => {
    it('should produce correct PMF for basic dice', () => {
      const builder = roll(2, 6)
      const pmf = builder.toPMF()

      expect(pmf).toBeDefined()
      expect(pmf.min()).toBe(2)
      expect(pmf.max()).toBe(12)
      expect(pmf.mean()).toBeCloseTo(7, 5) // Allow for floating point precision
    })

    it('should produce correct PMF for dice with modifier', () => {
      const builder = roll(3, 6, 4)
      const pmf = builder.toPMF()

      expect(pmf).toBeDefined()
      expect(pmf.min()).toBe(7) // 3 + 4
      expect(pmf.max()).toBe(22) // 18 + 4
      expect(pmf.mean()).toBeCloseTo(14.5, 12) // allow EPS tolerance
    })

    it('should produce correct PMF for flat amounts', () => {
      const builder = roll.flat(15)
      const pmf = builder.toPMF()

      expect(pmf).toBeDefined()
      expect(pmf.min()).toBe(15)
      expect(pmf.max()).toBe(15)
      expect(pmf.mean()).toBe(15)
    })

    it('should produce correct PMF for single dice', () => {
      const builder = roll.d20()
      const pmf = builder.toPMF()

      expect(pmf).toBeDefined()
      expect(pmf.min()).toBe(1)
      expect(pmf.max()).toBe(20)
      expect(pmf.mean()).toBe(10.5)
    })
  })
})
