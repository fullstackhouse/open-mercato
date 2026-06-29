import type { NotificationTypeDefinition } from '@open-mercato/shared/modules/notifications/types'
import {
  getNotificationType,
  getNotificationTypes,
  registerNotificationTypes,
  syncNotificationTypes,
} from '../notification-type-registry'

jest.mock('@open-mercato/shared/lib/commands/flush', () => ({
  withAtomicFlush: jest.fn(async (_em: unknown, phases: Array<() => unknown>) => {
    for (const phase of phases) await phase()
  }),
}))

function def(type: string, extra: Partial<NotificationTypeDefinition> = {}): NotificationTypeDefinition {
  return {
    type,
    module: 'test',
    titleKey: `${type}.title`,
    icon: 'bell',
    severity: 'info',
    actions: [],
    ...extra,
  }
}

describe('notification-type-registry', () => {
  beforeEach(() => {
    registerNotificationTypes([], { replace: true })
  })

  it('registers and looks up types by id', () => {
    registerNotificationTypes([def('a.one'), def('a.two')])
    expect(getNotificationTypes().map((t) => t.type).sort()).toEqual(['a.one', 'a.two'])
    expect(getNotificationType('a.one')?.titleKey).toBe('a.one.title')
    expect(getNotificationType('missing')).toBeUndefined()
  })

  it('replace clears prior entries', () => {
    registerNotificationTypes([def('a.one')])
    registerNotificationTypes([def('b.one')], { replace: true })
    expect(getNotificationTypes().map((t) => t.type)).toEqual(['b.one'])
  })

  it('re-registering the same id overwrites in place', () => {
    registerNotificationTypes([def('a.one', { labelKey: 'first' })])
    registerNotificationTypes([def('a.one', { labelKey: 'second' })])
    expect(getNotificationTypes()).toHaveLength(1)
    expect(getNotificationType('a.one')?.labelKey).toBe('second')
  })
})

describe('syncNotificationTypes', () => {
  beforeEach(() => {
    registerNotificationTypes([], { replace: true })
  })

  it('mirrors category/silent/nonOptOut onto a newly created row', async () => {
    registerNotificationTypes([
      def('a.secure', { category: 'security', silent: true, nonOptOut: true }),
    ])
    const created: Array<Record<string, unknown>> = []
    const em = {
      find: jest.fn(async () => [] as unknown[]),
      create: jest.fn((_entity: unknown, data: Record<string, unknown>) => {
        created.push(data)
        return data
      }),
      persist: jest.fn(),
    }
    const result = await syncNotificationTypes(em as never, { force: true })
    expect(result.created).toBe(1)
    expect(created[0]).toMatchObject({
      id: 'a.secure',
      category: 'security',
      silent: true,
      nonOptOut: true,
    })
  })

  it('does not mirror a hiddenFromSettings type to the catalogue', async () => {
    registerNotificationTypes([def('admin.custom_message', { hiddenFromSettings: true, nonOptOut: true })])
    const em = {
      find: jest.fn(async () => [] as unknown[]),
      create: jest.fn(),
      persist: jest.fn(),
      remove: jest.fn(),
    }
    const result = await syncNotificationTypes(em as never, { force: true })
    expect(em.create).not.toHaveBeenCalled()
    expect(result.created).toBe(0)
  })

  it('drops a stale catalogue row when a type is flipped to hiddenFromSettings', async () => {
    registerNotificationTypes([def('admin.custom_message', { hiddenFromSettings: true })])
    const row = { id: 'admin.custom_message' }
    const em = {
      find: jest.fn(async () => [row]),
      create: jest.fn(),
      persist: jest.fn(),
      remove: jest.fn(),
    }
    const result = await syncNotificationTypes(em as never, { force: true })
    expect(em.remove).toHaveBeenCalledWith(row)
    expect(result.updated).toBe(1)
  })

  it('updates an existing row when category/silent drift', async () => {
    registerNotificationTypes([
      def('a.secure', { category: 'security', silent: true }),
    ])
    const row = {
      id: 'a.secure',
      labelKey: 'a.secure.title',
      descriptionKey: null as string | null,
      category: null as string | null,
      silent: false,
      nonOptOut: false,
    }
    const em = {
      find: jest.fn(async () => [row]),
      create: jest.fn(),
      persist: jest.fn(),
    }
    const result = await syncNotificationTypes(em as never, { force: true })
    expect(result.updated).toBe(1)
    expect(em.create).not.toHaveBeenCalled()
    expect(row.category).toBe('security')
    expect(row.silent).toBe(true)
  })
})
