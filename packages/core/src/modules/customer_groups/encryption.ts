import type { ModuleEncryptionMap } from '@open-mercato/shared/modules/encryption'

// Release 5 Phase 3 (G22). `hold_reason` (CustomerCreditAccount) and `note`
// (CustomerCreditLedgerEntry) are free text that can carry personal data — the
// spec's own §16 encryption row only reasons about monetary columns, which this
// revises. Reads go through the query engine (`credit-accounts/crud.ts`'s
// `list.entityId`, which decrypts automatically) or `findWithDecryption` /
// `findOneWithDecryption` for any direct ORM read that surfaces these fields —
// see the module-level comment on `customerCreditService.ts` for why that
// service itself never needs either helper: it never reads `holdReason`/`note`
// back for business logic, only `isOnHold`/`creditLimit`/amounts.
export const defaultEncryptionMaps: ModuleEncryptionMap[] = [
  {
    entityId: 'customer_groups:customer_credit_account',
    fields: [{ field: 'hold_reason' }],
  },
  {
    entityId: 'customer_groups:customer_credit_ledger_entry',
    fields: [{ field: 'note' }],
  },
]

export default defaultEncryptionMaps
