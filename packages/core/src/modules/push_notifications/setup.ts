import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['push_notifications.*'],
    admin: ['push_notifications.*'],
    // The delivery log is ops/admin observability; employees are not granted it by default.
  },
}

export default setup
