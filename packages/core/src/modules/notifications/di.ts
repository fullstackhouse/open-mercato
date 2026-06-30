import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { asFunction } from 'awilix'
import { createNotificationService } from './lib/notificationService'
import { createNotificationPreferenceService } from './lib/notificationPreferenceService'

export function register(container: AppContainer): void {
  container.register({
    notificationService: asFunction(({ em, eventBus, commandBus }) =>
      createNotificationService({ em, eventBus, commandBus })
    ).scoped(),
    notificationPreferenceService: asFunction(({ em }) =>
      createNotificationPreferenceService({ em })
    ).scoped(),
  })
}
