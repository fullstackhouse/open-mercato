import type { NotificationTypeDefinition } from '@open-mercato/shared/modules/notifications/types'
import {
  getNotificationType,
  getNotificationTypes,
  registerNotificationTypes,
} from '../notification-type-registry'

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
