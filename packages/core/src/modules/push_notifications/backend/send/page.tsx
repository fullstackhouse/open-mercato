"use client"
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { CrudForm, type CrudField, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'

type FormValues = {
  userId: string
  title: string
  body: string
}

const DELIVERIES_HREF = '/backend/push_notifications'

export default function PushCustomSendPage() {
  const router = useRouter()
  const t = useT()

  const fields = React.useMemo<CrudField[]>(() => [
    { id: 'userId', label: t('push_notifications.send.userId'), type: 'text', required: true, description: t('push_notifications.send.userIdHint') },
    { id: 'title', label: t('push_notifications.send.title'), type: 'text', required: true },
    { id: 'body', label: t('push_notifications.send.body'), type: 'textarea' },
  ], [t])

  const groups = React.useMemo<CrudFormGroup[]>(() => ([
    { id: 'message', title: t('push_notifications.send.message'), column: 1, fields: ['userId', 'title', 'body'] },
  ]), [t])

  return (
    <Page>
      <PageBody>
        <CrudForm<FormValues>
          title={t('push_notifications.send.pageTitle')}
          backHref={DELIVERIES_HREF}
          cancelHref={DELIVERIES_HREF}
          fields={fields}
          groups={groups}
          initialValues={{ userId: '', title: '', body: '' }}
          submitLabel={t('push_notifications.send.submit')}
          onSubmit={async (values) => {
            const body = values.body.trim()
            await apiCallOrThrow('/api/push_notifications/custom-send', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                recipientUserId: values.userId.trim(),
                title: values.title.trim(),
                body: body.length > 0 ? body : undefined,
              }),
            })
            flash(t('push_notifications.send.success'), 'success')
            router.push(DELIVERIES_HREF)
          }}
        />
      </PageBody>
    </Page>
  )
}
