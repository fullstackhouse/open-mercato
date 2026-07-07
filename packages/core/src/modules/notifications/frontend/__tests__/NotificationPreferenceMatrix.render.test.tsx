/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  NotificationPreferenceMatrix,
  PREFERENCE_CHANNELS,
  preferenceKey,
  type NotificationTypeItem,
} from '../NotificationPreferenceMatrix'

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (_key: string, fallback?: string) => fallback ?? _key,
}))

const types: NotificationTypeItem[] = [
  { id: 'a.one', labelKey: 'a.one.title' },
  { id: 'security.alert', labelKey: 'security.alert.title', nonOptOut: true },
]

function renderMatrix(onToggle = jest.fn()) {
  render(
    <NotificationPreferenceMatrix
      types={types}
      prefs={{}}
      onToggle={onToggle}
    />,
  )
  return { onToggle, switches: screen.getAllByRole('switch') }
}

describe('NotificationPreferenceMatrix (render)', () => {
  it('renders one switch per type x channel cell', () => {
    const { switches } = renderMatrix()
    expect(switches).toHaveLength(types.length * PREFERENCE_CHANNELS.length)
  })

  it('locks nonOptOut cells ON and disabled, and ignores toggle attempts', () => {
    const { onToggle, switches } = renderMatrix()
    // The last PREFERENCE_CHANNELS.length switches belong to the nonOptOut (security.alert) row.
    const lockedSwitches = switches.slice(-PREFERENCE_CHANNELS.length)
    for (const node of lockedSwitches) {
      expect(node).toBeDisabled()
      expect(node).toHaveAttribute('aria-checked', 'true')
      fireEvent.click(node)
    }
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('keeps opt-in cells toggleable', () => {
    const onToggle = jest.fn()
    const { switches } = renderMatrix(onToggle)
    const firstOptInSwitch = switches[0]
    expect(firstOptInSwitch).not.toBeDisabled()
    fireEvent.click(firstOptInSwitch)
    expect(onToggle).toHaveBeenCalledWith('a.one', PREFERENCE_CHANNELS[0].key, false)
  })

  it('respects stored opt-in preference values for non-locked cells', () => {
    const onToggle = jest.fn()
    render(
      <NotificationPreferenceMatrix
        types={types}
        prefs={{ [preferenceKey('a.one', PREFERENCE_CHANNELS[0].key)]: false }}
        onToggle={onToggle}
      />,
    )
    const first = screen.getAllByRole('switch')[0]
    expect(first).toHaveAttribute('aria-checked', 'false')
  })
})
