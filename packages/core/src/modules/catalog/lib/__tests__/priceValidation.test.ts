import enDictionary from '../../i18n/en.json'
import deDictionary from '../../i18n/de.json'
import esDictionary from '../../i18n/es.json'
import koDictionary from '../../i18n/ko.json'
import plDictionary from '../../i18n/pl.json'
import {
  CATALOG_PRICE_AMOUNT_VALIDATION_MESSAGE_KEY,
  getCatalogPriceAmountValidationMessage,
  validateCatalogPriceAmountInput,
} from '../priceValidation'

describe('catalog price amount validation message', () => {
  it('returns an i18n key instead of hardcoded copy', () => {
    expect(getCatalogPriceAmountValidationMessage()).toBe('catalog.prices.validation.amountInvalid')
  })

  it.each([
    ['en', enDictionary],
    ['de', deDictionary],
    ['es', esDictionary],
    ['ko', koDictionary],
    ['pl', plDictionary],
  ])('has a %s translation for the message key', (_locale, dictionary) => {
    const messages = dictionary as Record<string, string>
    expect(messages[CATALOG_PRICE_AMOUNT_VALIDATION_MESSAGE_KEY]).toEqual(expect.any(String))
  })

  it('keeps validating amounts of any precision exactly', () => {
    expect(validateCatalogPriceAmountInput('12345678901234.123456789')).toEqual({
      ok: true,
      numeric: 12345678901234.123,
      exact: '12345678901234.123456789',
    })
    expect(validateCatalogPriceAmountInput('-1')).toEqual({ ok: false, reason: 'negative' })
  })
})
