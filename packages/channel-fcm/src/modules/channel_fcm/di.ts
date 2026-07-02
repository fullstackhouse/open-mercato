import { asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import {
  hasChannelAdapter,
  registerChannelAdapter,
} from '@open-mercato/core/modules/communication_channels/lib/adapter-registry-singleton'
import { getFcmChannelAdapter } from './lib/adapter'
import { channelFcmHealthCheck } from './lib/health'

export function register(container: AppContainer): void {
  if (!hasChannelAdapter('fcm')) {
    registerChannelAdapter(getFcmChannelAdapter())
  }
  container.register({
    channelFcmAdapter: asValue(getFcmChannelAdapter()),
    // Registered under the exact service name declared in `integration.ts`
    // (`healthCheck.service`); without it the hub's resolve throws and the
    // channel reports permanently 'unhealthy'.
    channelFcmHealthCheck: asValue(channelFcmHealthCheck),
  })
}
