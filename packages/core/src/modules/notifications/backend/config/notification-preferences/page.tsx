import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { NotificationPreferencesPageClient } from '../../../frontend/NotificationPreferencesPageClient'

export default async function NotificationPreferencesPage() {
  return (
    <Page>
      <PageBody>
        <NotificationPreferencesPageClient />
      </PageBody>
    </Page>
  )
}
