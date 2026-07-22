import {
  hasAllFeatures,
  hasAllFeaturesExcluding,
  hasFeature,
  hasFeatureExcluding,
} from '../features'

describe('security/features pure matchers', () => {
  it('hasFeature honors wildcard grants', () => {
    expect(hasFeature(['sales.*'], 'sales.documents.view')).toBe(true)
    expect(hasFeature(['*'], 'sales.documents.view')).toBe(true)
    expect(hasFeature(['catalog.*'], 'sales.documents.view')).toBe(false)
  })

  describe('hasFeatureExcluding', () => {
    it('denies a required feature present in the exclusion list despite wildcard grants', () => {
      expect(hasFeatureExcluding(['sales.*'], 'sales.documents.number.edit', ['sales.documents.number.edit'])).toBe(false)
      expect(hasFeatureExcluding(['*'], 'sales.documents.number.edit', ['sales.documents.number.edit'])).toBe(false)
    })

    it('behaves like hasFeature when the exclusion list is empty or absent', () => {
      expect(hasFeatureExcluding(['sales.*'], 'sales.documents.number.edit', [])).toBe(true)
      expect(hasFeatureExcluding(['sales.*'], 'sales.documents.number.edit', undefined)).toBe(true)
      expect(hasFeatureExcluding(undefined, 'sales.documents.view', undefined)).toBe(false)
    })
  })

  describe('hasAllFeaturesExcluding', () => {
    it('denies when any required feature is excluded', () => {
      expect(hasAllFeaturesExcluding(['sales.*'], ['sales.documents.view', 'sales.documents.number.edit'], ['sales.documents.number.edit'])).toBe(false)
    })

    it('matches hasAllFeatures when nothing is excluded', () => {
      const granted = ['sales.*']
      const required = ['sales.documents.view']
      expect(hasAllFeaturesExcluding(granted, required, [])).toBe(hasAllFeatures(granted, required))
      expect(hasAllFeaturesExcluding(granted, [], ['sales.documents.view'])).toBe(true)
    })
  })
})
