/** @jest-environment jsdom */
jest.setTimeout(15000)

const fetchCustomFieldFormStructureMock = jest.fn(async () => ({ definitions: [], metadata: {} }))

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))
jest.mock('remark-gfm', () => ({ __esModule: true, default: {} }))
jest.mock('../confirm-dialog', () => ({
  useConfirmDialog: () => ({ confirm: jest.fn().mockResolvedValue(true), ConfirmDialogElement: null }),
}))
jest.mock('../injection/InjectionSpot', () => ({
  __esModule: true,
  InjectionSpot: () => null,
  useInjectionWidgets: () => ({ widgets: [], loading: false, error: null }),
  useInjectionSpotEvents: () => ({ triggerEvent: jest.fn(async () => ({ ok: true })) }),
}))
jest.mock('../injection/useInjectionDataWidgets', () => ({
  __esModule: true,
  useInjectionDataWidgets: () => ({ widgets: [], isLoading: false, error: null }),
}))
jest.mock('../utils/customFieldForms', () => ({
  __esModule: true,
  buildFormFieldFromCustomFieldDef: jest.fn(),
  buildFormFieldsFromCustomFields: jest.fn(() => []),
  fetchCustomFieldFormStructure: (...args: unknown[]) => fetchCustomFieldFormStructureMock(...args),
}))

import * as React from 'react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'
import { CrudForm, type CrudField } from '../CrudForm'
import { UiReadOnlyPolicyProvider } from '../ui-read-only/context'

const ENTITY = 'customers:customer_entity'
const fields: CrudField[] = [
  { id: 'first_name', label: 'First name', type: 'text' },
  { id: 'last_name', label: 'Last name', type: 'text' },
]

function renderForm(map: Record<string, string[]>) {
  return renderWithProviders(
    <UiReadOnlyPolicyProvider map={map}>
      <CrudForm
        title="Customer"
        entityId={ENTITY}
        fields={fields}
        initialValues={{ first_name: 'Ada', last_name: 'Lovelace' }}
        onSubmit={() => {}}
        onDelete={() => {}}
      />
    </UiReadOnlyPolicyProvider>,
    { dict: { 'ui.forms.actions.save': 'Save', 'ui.forms.actions.delete': 'Delete' } },
  )
}

describe('CrudForm declarative UI read-only', () => {
  it('renders a read-only field display-only without mounting the input', () => {
    const { container } = renderForm({ [ENTITY]: ['first_name'] })

    const firstName = container.querySelector('[data-crud-field-id="first_name"]') as HTMLElement
    const lastName = container.querySelector('[data-crud-field-id="last_name"]') as HTMLElement

    // Read-only field: display-only marker, value shown, NO input mounted.
    expect(firstName.getAttribute('data-crud-readonly-field')).toBe('true')
    expect(firstName.querySelector('input, textarea, select')).toBeNull()
    expect(firstName.textContent).toContain('Ada')

    // Editable field: input is mounted as usual.
    expect(lastName.getAttribute('data-crud-readonly-field')).toBeNull()
    expect(lastName.querySelector('input')).not.toBeNull()
  })

  it('hides Save and Delete for a whole-entity read-only form', () => {
    const { queryAllByText, container } = renderForm({ [ENTITY]: ['*'] })

    // Every field is display-only; no inputs anywhere.
    expect(container.querySelector('input, textarea, select')).toBeNull()
    expect(queryAllByText('Save')).toHaveLength(0)
    expect(queryAllByText('Delete')).toHaveLength(0)
  })

  it('leaves the form fully editable when no policy applies', () => {
    const { container, queryAllByText } = renderForm({ 'sales:sales_order': ['*'] })

    expect(container.querySelector('[data-crud-field-id="first_name"] input')).not.toBeNull()
    expect(container.querySelector('[data-crud-field-id="last_name"] input')).not.toBeNull()
    expect(queryAllByText('Save').length).toBeGreaterThan(0)
  })
})
