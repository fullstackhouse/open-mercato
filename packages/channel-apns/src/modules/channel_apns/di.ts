import { asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import {
  hasChannelAdapter,
  registerChannelAdapter,
} from '@open-mercato/core/modules/communication_channels/lib/adapter-registry-singleton'
import { getApnsChannelAdapter } from './lib/adapter'
import { channelApnsHealthCheck } from './lib/health'

export function register(container: AppContainer): void {
  if (!hasChannelAdapter('apns')) {
    registerChannelAdapter(getApnsChannelAdapter())
  }
  container.register({
    channelApnsAdapter: asValue(getApnsChannelAdapter()),
    // Registered under the exact service name declared in `integration.ts`
    // (`healthCheck.service`); without it the hub's resolve throws.
    channelApnsHealthCheck: asValue(channelApnsHealthCheck),
  })
}
