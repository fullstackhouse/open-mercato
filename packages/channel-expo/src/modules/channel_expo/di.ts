import { asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import {
  hasChannelAdapter,
  registerChannelAdapter,
} from '@open-mercato/core/modules/communication_channels/lib/adapter-registry-singleton'
import { getExpoChannelAdapter } from './lib/adapter'
import { channelExpoHealthCheck } from './lib/health'

export function register(container: AppContainer): void {
  if (!hasChannelAdapter('expo')) {
    registerChannelAdapter(getExpoChannelAdapter())
  }
  container.register({
    channelExpoAdapter: asValue(getExpoChannelAdapter()),
    // Registered under the exact service name declared in `integration.ts`
    // (`healthCheck.service`); without it the hub's resolve throws.
    channelExpoHealthCheck: asValue(channelExpoHealthCheck),
  })
}
