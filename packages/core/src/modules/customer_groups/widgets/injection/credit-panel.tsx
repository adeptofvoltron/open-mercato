"use client"

import * as React from 'react'
import { CreditCard, Pencil } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { updateCrud } from '@open-mercato/ui/backend/utils/crud'
import { createCrudFormError } from '@open-mercato/ui/backend/utils/serverErrors'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { StatusBadge, type StatusBadgeVariant, type StatusMap } from '@open-mercato/ui/primitives/status-badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@open-mercato/ui/primitives/dialog'
import { CrudForm, type CrudField } from '@open-mercato/ui/backend/CrudForm'
import { useBackendChrome } from '@open-mercato/ui/backend/BackendChromeProvider'
import { useDialogKeyHandler } from '@open-mercato/ui/hooks/useDialogKeyHandler'
import { hasFeature } from '@open-mercato/shared/security/features'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'

const CREDIT_PANEL_RESOURCE_KINDS = new Set(['customers.person', 'customers.company'])
const CREDIT_MANAGE_FEATURE = 'customer_groups.credit.manage'

type CreditPanelContext = {
  resourceKind: string
  resourceId: string
}

type CreditAccountRow = {
  id: string
  customerId: string
  currencyCode: string
  creditLimit: string
  isOnHold: boolean
  holdReason: string | null
  exposure: string | null
  available: string | null
  updatedAt: string | null
}

type CreditAccountFormValues = {
  creditLimit: number
  isOnHold: boolean
  holdReason: string
}

const HOLD_STATUS_BADGE_VARIANTS: StatusMap<'onHold' | 'active'> = {
  onHold: 'warning',
  active: 'success',
}

function isValidContext(ctx: unknown): ctx is CreditPanelContext {
  if (!ctx || typeof ctx !== 'object') return false
  const candidate = ctx as { resourceKind?: unknown; resourceId?: unknown }
  if (typeof candidate.resourceKind !== 'string' || !CREDIT_PANEL_RESOURCE_KINDS.has(candidate.resourceKind)) return false
  return typeof candidate.resourceId === 'string' && candidate.resourceId.trim().length > 0
}

// The list route returns the query-engine column projection (snake_case keys) plus the
// `exposure`/`available` fields merged in by `credit-accounts/crud.ts`'s `afterList` hook
// — mirrors `person-groups-tab.tsx#readStringField`'s defensive snake/camel acceptance.
function readStringField(record: Record<string, unknown>, camelKey: string, snakeKey: string): string {
  const camel = record[camelKey]
  if (typeof camel === 'string' && camel.length) return camel
  const snake = record[snakeKey]
  if (typeof snake === 'string' && snake.length) return snake
  return ''
}

function readNullableStringField(record: Record<string, unknown>, camelKey: string, snakeKey: string): string | null {
  const camel = record[camelKey]
  if (typeof camel === 'string' && camel.length) return camel
  const snake = record[snakeKey]
  if (typeof snake === 'string' && snake.length) return snake
  return null
}

function readBooleanField(record: Record<string, unknown>, camelKey: string, snakeKey: string): boolean {
  const camel = record[camelKey]
  if (typeof camel === 'boolean') return camel
  const snake = record[snakeKey]
  return typeof snake === 'boolean' ? snake : false
}

function mapCreditAccountItem(item: unknown): CreditAccountRow | null {
  if (!item || typeof item !== 'object') return null
  const record = item as Record<string, unknown>
  const id = readStringField(record, 'id', 'id')
  const customerId = readStringField(record, 'customerId', 'customer_id')
  const currencyCode = readStringField(record, 'currencyCode', 'currency_code')
  if (!id || !customerId || !currencyCode) return null
  return {
    id,
    customerId,
    currencyCode,
    creditLimit: readStringField(record, 'creditLimit', 'credit_limit') || '0.00',
    isOnHold: readBooleanField(record, 'isOnHold', 'is_on_hold'),
    holdReason: readNullableStringField(record, 'holdReason', 'hold_reason'),
    exposure: readNullableStringField(record, 'exposure', 'exposure'),
    available: readNullableStringField(record, 'available', 'available'),
    updatedAt: readNullableStringField(record, 'updatedAt', 'updated_at'),
  }
}

function mapCreditAccountItems(items: unknown): CreditAccountRow[] {
  if (!Array.isArray(items)) return []
  return items.reduce<CreditAccountRow[]>((acc, item) => {
    const row = mapCreditAccountItem(item)
    if (row) acc.push(row)
    return acc
  }, [])
}

function CreditAccountRowItem({
  row,
  canManage,
  onEdit,
}: {
  row: CreditAccountRow
  canManage: boolean
  onEdit: (row: CreditAccountRow) => void
}) {
  const t = useT()
  const holdStatus: 'onHold' | 'active' = row.isOnHold ? 'onHold' : 'active'
  const holdLabel = t(
    row.isOnHold ? 'customer_groups.groups.creditTab.status.onHold' : 'customer_groups.groups.creditTab.status.active',
    row.isOnHold ? 'On hold' : 'Active',
  )
  const statusVariant: StatusBadgeVariant = HOLD_STATUS_BADGE_VARIANTS[holdStatus]

  return (
    <li className="rounded-md border border-border bg-card px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{row.currencyCode}</span>
            <StatusBadge variant={statusVariant} dot>{holdLabel}</StatusBadge>
          </div>
          <dl className="grid grid-cols-3 gap-x-4 text-xs text-muted-foreground">
            <div>
              <dt>{t('customer_groups.groups.creditTab.field.limit', 'Limit')}</dt>
              <dd className="text-sm text-foreground">{row.creditLimit}</dd>
            </div>
            <div>
              <dt>{t('customer_groups.groups.creditTab.field.exposure', 'Exposure')}</dt>
              <dd className="text-sm text-foreground">{row.exposure ?? '—'}</dd>
            </div>
            <div>
              <dt>{t('customer_groups.groups.creditTab.field.available', 'Available')}</dt>
              <dd className="text-sm text-foreground">{row.available ?? '—'}</dd>
            </div>
          </dl>
          {row.isOnHold && row.holdReason ? (
            <div className="text-xs text-muted-foreground">
              {t('customer_groups.groups.creditTab.field.holdReason', 'Hold reason')}: {row.holdReason}
            </div>
          ) : null}
        </div>
        {canManage ? (
          <IconButton
            type="button"
            variant="ghost"
            size="xs"
            aria-label={t('customer_groups.groups.creditTab.edit', 'Edit credit account')}
            onClick={() => onEdit(row)}
          >
            <Pencil className="size-4" aria-hidden />
          </IconButton>
        ) : null}
      </div>
    </li>
  )
}

export function CreditPanelWidget({ context }: InjectionWidgetComponentProps<unknown, unknown>) {
  const t = useT()
  const { payload: backendChromePayload, isReady: backendChromeReady } = useBackendChrome()
  const canManage = backendChromeReady && hasFeature(backendChromePayload?.grantedFeatures, CREDIT_MANAGE_FEATURE)
  const editDialogContentRef = React.useRef<HTMLDivElement | null>(null)
  const [accounts, setAccounts] = React.useState<CreditAccountRow[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [editingAccount, setEditingAccount] = React.useState<CreditAccountRow | null>(null)
  const [formInstanceKey, setFormInstanceKey] = React.useState(0)

  const customerId = isValidContext(context) ? context.resourceId : null

  const load = React.useCallback(async () => {
    if (!customerId) return
    setLoading(true)
    setError(null)
    try {
      const res = await apiCall<{ items?: unknown[] }>(
        `/api/customer_groups/customer-groups/credit-accounts?customerId=${encodeURIComponent(customerId)}&pageSize=20`,
      )
      if (res.ok && res.result) {
        setAccounts(mapCreditAccountItems(res.result.items))
      } else if (res.status === 403) {
        setAccounts([])
      } else {
        throw new Error('[internal] credit accounts')
      }
    } catch {
      setError(t('customer_groups.groups.creditTab.errors.load', 'Failed to load the credit account.'))
    } finally {
      setLoading(false)
    }
  }, [customerId, t])

  React.useEffect(() => {
    load()
  }, [load])

  React.useEffect(() => {
    if (editingAccount) setFormInstanceKey((current) => current + 1)
  }, [editingAccount])

  const editFields = React.useMemo<CrudField[]>(
    () => [
      {
        id: 'creditLimit',
        label: t('customer_groups.groups.creditTab.field.limit', 'Limit'),
        type: 'number',
      },
      {
        id: 'isOnHold',
        label: t('customer_groups.groups.creditTab.field.onHold', 'On hold'),
        type: 'checkbox',
      },
      {
        id: 'holdReason',
        label: t('customer_groups.groups.creditTab.field.holdReason', 'Hold reason'),
        type: 'textarea',
        rows: 2,
        maxLength: 2000,
        visibleWhen: { field: 'isOnHold', equals: true },
        description: t(
          'customer_groups.groups.creditTab.field.holdReasonHelp',
          'Required while this account is on hold.',
        ),
      },
    ],
    [t],
  )

  const editInitialValues = React.useMemo<Partial<CreditAccountFormValues>>(
    () => ({
      creditLimit: editingAccount ? Number(editingAccount.creditLimit) : 0,
      isOnHold: editingAccount?.isOnHold ?? false,
      holdReason: editingAccount?.holdReason ?? '',
    }),
    [editingAccount],
  )

  const closeEditDialog = React.useCallback(() => setEditingAccount(null), [])

  const handleEditSubmit = React.useCallback(
    async (values: CreditAccountFormValues) => {
      if (!editingAccount) return
      const holdReason = typeof values.holdReason === 'string' && values.holdReason.trim().length
        ? values.holdReason.trim()
        : null
      if (values.isOnHold && !holdReason) {
        const message = t(
          'customer_groups.groups.creditTab.errors.holdReasonRequired',
          'A hold reason is required when placing an account on hold.',
        )
        throw createCrudFormError(message, { holdReason: message })
      }
      await updateCrud(
        'customer_groups/customer-groups/credit-accounts',
        {
          id: editingAccount.id,
          creditLimit: values.creditLimit,
          isOnHold: values.isOnHold,
          holdReason,
        },
        {
          errorMessage: t('customer_groups.groups.creditTab.errors.saveFailed', 'Failed to update the credit account.'),
        },
      )
      setEditingAccount(null)
      flash(t('customer_groups.groups.creditTab.saved', 'Credit account updated.'), 'success')
      await load()
    },
    [editingAccount, load, t],
  )

  const submitEditForm = React.useCallback(
    () => editDialogContentRef.current?.querySelector('form')?.requestSubmit(),
    [],
  )
  const handleEditDialogKeyDown = useDialogKeyHandler({
    onConfirm: submitEditForm,
    onCancel: closeEditDialog,
  })

  if (!customerId) return null

  return (
    <div className="space-y-3">
      {loading ? (
        <LoadingMessage label={t('customer_groups.groups.creditTab.loading', 'Loading credit account…')} />
      ) : error ? (
        <ErrorMessage label={error} />
      ) : accounts.length === 0 ? (
        <EmptyState
          size="sm"
          variant="subtle"
          icon={<CreditCard className="h-5 w-5" aria-hidden />}
          title={t('customer_groups.groups.creditTab.empty.title', 'No credit account')}
          description={t(
            'customer_groups.groups.creditTab.empty.description',
            'This customer has no credit account yet. Credit accounts are created by an operator.',
          )}
          className="border border-dashed border-border"
        />
      ) : (
        <ul className="space-y-2" aria-label={t('customer_groups.groups.creditTab.listLabel', 'Credit accounts')}>
          {accounts.map((row) => (
            <CreditAccountRowItem key={row.id} row={row} canManage={canManage} onEdit={setEditingAccount} />
          ))}
        </ul>
      )}

      <Dialog
        open={editingAccount != null}
        onOpenChange={(next) => {
          if (!next) setEditingAccount(null)
        }}
      >
        <DialogContent ref={editDialogContentRef} onKeyDown={handleEditDialogKeyDown}>
          <DialogHeader>
            <DialogTitle>{t('customer_groups.groups.creditTab.editDialog.title', 'Edit credit account')}</DialogTitle>
          </DialogHeader>
          <CrudForm<CreditAccountFormValues>
            key={formInstanceKey}
            embedded
            fields={editFields}
            initialValues={editInitialValues}
            optimisticLockUpdatedAt={editingAccount?.updatedAt ?? null}
            submitLabel={t('customer_groups.groups.creditTab.editDialog.submit', 'Save')}
            onSubmit={handleEditSubmit}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default CreditPanelWidget
