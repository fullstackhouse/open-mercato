/**
 * @jest-environment jsdom
 */

import * as React from 'react'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'
import {
  DetailReadOnlyContext,
  InlineTextEditor,
  InlineMultilineEditor,
  InlineSelectEditor,
} from '../InlineEditors'

describe('inline detail editors — declarative UI read-only', () => {
  it('renders an edit trigger by default (editable)', () => {
    const { container } = renderWithProviders(
      <InlineTextEditor label="Name" value="Ada" emptyLabel="—" onSave={jest.fn()} />,
      { dict: {} },
    )
    expect(container.querySelector('button')).not.toBeNull()
    expect(screen.getByText('Ada')).toBeInTheDocument()
  })

  it('hides the edit trigger and shows the value display-only when readOnly', () => {
    const onSave = jest.fn()
    const { container } = renderWithProviders(
      <InlineTextEditor label="Name" value="Ada" emptyLabel="—" onSave={onSave} readOnly activateOnClick />,
      { dict: {} },
    )
    // No pencil trigger, value still shown.
    expect(container.querySelector('button')).toBeNull()
    expect(screen.getByText('Ada')).toBeInTheDocument()
    // Clicking the value does not open an editor (no input mounted).
    fireEvent.click(screen.getByText('Ada'))
    expect(container.querySelector('input')).toBeNull()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('honors a read-only DetailReadOnlyContext for every inline editor', () => {
    const { container } = renderWithProviders(
      <DetailReadOnlyContext.Provider value={true}>
        <InlineTextEditor label="Name" value="Ada" emptyLabel="—" onSave={jest.fn()} />
        <InlineMultilineEditor label="Notes" value="hello" emptyLabel="—" onSave={jest.fn()} />
        <InlineSelectEditor
          label="Status"
          value="active"
          emptyLabel="—"
          options={[{ value: 'active', label: 'Active' }]}
          onSave={jest.fn()}
        />
      </DetailReadOnlyContext.Provider>,
      { dict: {} },
    )
    // No edit triggers anywhere under the read-only context.
    expect(container.querySelectorAll('button').length).toBe(0)
  })

  it('keeps editors interactive when the context is not read-only', () => {
    const { container } = renderWithProviders(
      <DetailReadOnlyContext.Provider value={false}>
        <InlineSelectEditor
          label="Status"
          value="active"
          emptyLabel="—"
          options={[{ value: 'active', label: 'Active' }]}
          onSave={jest.fn()}
        />
      </DetailReadOnlyContext.Provider>,
      { dict: {} },
    )
    expect(container.querySelector('button')).not.toBeNull()
  })
})
