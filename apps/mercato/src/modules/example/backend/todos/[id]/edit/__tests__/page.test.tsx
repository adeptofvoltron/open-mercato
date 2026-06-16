/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom'
import * as React from 'react'
import { render, waitFor } from '@testing-library/react'

type CapturedProps = { initialValues?: { updatedAt?: string | null } | null } | null
const crudFormPropsCapture: { current: CapturedProps } = { current: null }

const fetchCrudListMock = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}))

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (_key: string, fallback?: string) => fallback ?? _key,
}))

jest.mock('@open-mercato/ui/backend/Page', () => ({
  Page: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PageBody: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@open-mercato/ui/backend/detail', () => ({
  ErrorMessage: ({ label }: { label?: string }) => <div>{label}</div>,
  RecordNotFoundState: () => <div data-testid="not-found" />,
}))

jest.mock('@open-mercato/ui/backend/messages', () => ({
  SendObjectMessageDialog: () => <div data-testid="send-message" />,
}))

jest.mock('@open-mercato/ui/backend/utils/flash', () => ({
  pushWithFlash: jest.fn(),
}))

jest.mock('@open-mercato/ui/backend/utils/crud', () => ({
  fetchCrudList: (...args: unknown[]) => fetchCrudListMock(...args),
  updateCrud: jest.fn(),
  deleteCrud: jest.fn(),
}))

jest.mock('@open-mercato/ui/backend/CrudForm', () => ({
  CrudForm: (props: CapturedProps) => {
    crudFormPropsCapture.current = props
    return <div data-testid="crud-form" />
  },
}))

import EditTodoPage from '../page'

describe('EditTodoPage optimistic locking (issue #3118)', () => {
  beforeEach(() => {
    crudFormPropsCapture.current = null
    fetchCrudListMock.mockReset()
  })

  it('passes the loaded updatedAt into CrudForm initialValues so the optimistic-lock header is sent', async () => {
    fetchCrudListMock.mockResolvedValue({
      items: [
        {
          id: 'todo-123',
          title: 'Version A',
          is_done: false,
          updatedAt: '2026-06-16T10:00:00.000Z',
        },
      ],
    })

    render(<EditTodoPage params={{ id: 'todo-123' }} />)

    await waitFor(() => {
      expect(crudFormPropsCapture.current?.initialValues?.updatedAt).toBe(
        '2026-06-16T10:00:00.000Z',
      )
    })
  })

  it('falls back to null when the loaded record has no updatedAt', async () => {
    fetchCrudListMock.mockResolvedValue({
      items: [
        {
          id: 'todo-456',
          title: 'No timestamp',
          is_done: true,
        },
      ],
    })

    render(<EditTodoPage params={{ id: 'todo-456' }} />)

    await waitFor(() => {
      expect(crudFormPropsCapture.current?.initialValues).not.toBeNull()
    })
    expect(crudFormPropsCapture.current?.initialValues?.updatedAt).toBeNull()
  })
})
