/** @jest-environment jsdom */
import * as React from 'react'
import { render, fireEvent, screen } from '@testing-library/react'
import { I18nProvider } from '@open-mercato/shared/lib/i18n/context'
import { RowActions, RowActionsReadOnlyContext, type RowActionItem } from '../RowActions'

const items: RowActionItem[] = [
  { id: 'view', label: 'View', href: '/x' },
  { id: 'edit', label: 'Edit', href: '/x/edit', mutates: true },
  { id: 'delete', label: 'Delete', destructive: true, onSelect: () => {} },
]

function renderRowActions(readOnly: boolean) {
  return render(
    <I18nProvider locale="en" dict={{}}>
      <RowActionsReadOnlyContext.Provider value={readOnly}>
        <RowActions items={items} />
      </RowActionsReadOnlyContext.Provider>
    </I18nProvider>,
  )
}

describe('RowActions under a read-only context', () => {
  it('hides mutating (edit) and destructive (delete) items, keeps view', () => {
    renderRowActions(true)
    fireEvent.click(screen.getByRole('button', { name: /open actions/i }))
    expect(screen.getByText('View')).toBeTruthy()
    expect(screen.queryByText('Edit')).toBeNull()
    expect(screen.queryByText('Delete')).toBeNull()
  })

  it('shows every action when not read-only', () => {
    renderRowActions(false)
    fireEvent.click(screen.getByRole('button', { name: /open actions/i }))
    expect(screen.getByText('View')).toBeTruthy()
    expect(screen.getByText('Edit')).toBeTruthy()
    expect(screen.getByText('Delete')).toBeTruthy()
  })

  it('renders nothing when every action is suppressed', () => {
    const { container } = render(
      <I18nProvider locale="en" dict={{}}>
        <RowActionsReadOnlyContext.Provider value={true}>
          <RowActions items={[{ id: 'edit', label: 'Edit', mutates: true, onSelect: () => {} }]} />
        </RowActionsReadOnlyContext.Provider>
      </I18nProvider>,
    )
    expect(container.querySelector('button')).toBeNull()
  })
})
