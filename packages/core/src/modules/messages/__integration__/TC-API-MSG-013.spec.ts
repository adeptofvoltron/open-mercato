import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api';
import { decodeJwtSubject, deleteMessageIfExists } from './helpers';

/**
 * TC-API-MSG-013: Send Draft via POST /api/messages/:id/send
 * Verifies: create draft, send it via POST /:id/send, verify it disappears from
 * the Drafts folder and appears in the Sent folder. Also verifies that sending
 * a non-draft returns 409.
 */
test.describe('TC-API-MSG-013: Send Draft Lifecycle', () => {
  test('should transition draft to sent and remove from drafts folder', async ({ request }) => {
    let draftId: string | null = null;
    let adminToken: string | null = null;

    try {
      adminToken = await getAuthToken(request, 'admin');
      const employeeToken = await getAuthToken(request, 'employee');
      const employeeUserId = decodeJwtSubject(employeeToken);

      const timestamp = Date.now();
      const subject = `QA TC-API-MSG-013 ${timestamp}`;

      // Create draft
      const createResponse = await apiRequest(request, 'POST', '/api/messages', {
        token: adminToken,
        data: {
          isDraft: true,
          recipients: [{ userId: employeeUserId, type: 'to' }],
          subject,
          body: 'Draft body for send test',
          sendViaEmail: false,
        },
      });
      expect(createResponse.status()).toBe(201);
      const createBody = (await createResponse.json()) as { id?: unknown };
      expect(typeof createBody.id).toBe('string');
      draftId = createBody.id as string;

      // Verify draft appears in drafts folder
      const draftsBeforeResponse = await apiRequest(
        request,
        'GET',
        `/api/messages?folder=drafts&search=${encodeURIComponent(subject)}&pageSize=20`,
        { token: adminToken },
      );
      expect(draftsBeforeResponse.ok()).toBeTruthy();
      const draftsBeforeBody = (await draftsBeforeResponse.json()) as {
        items?: Array<{ id?: unknown; status?: unknown }>;
      };
      const draftItem = draftsBeforeBody.items?.find((item) => item.id === draftId);
      expect(draftItem).toBeTruthy();
      expect(draftItem?.status).toBe('draft');

      // Send the draft via POST /:id/send
      const sendResponse = await apiRequest(request, 'POST', `/api/messages/${draftId}/send`, {
        token: adminToken,
        data: {},
      });
      expect(sendResponse.status()).toBe(200);
      const sendBody = (await sendResponse.json()) as { ok?: unknown; id?: unknown };
      expect(sendBody.ok).toBe(true);
      expect(sendBody.id).toBe(draftId);

      // Draft must NOT appear in drafts folder anymore
      const draftsAfterResponse = await apiRequest(
        request,
        'GET',
        `/api/messages?folder=drafts&search=${encodeURIComponent(subject)}&pageSize=20`,
        { token: adminToken },
      );
      expect(draftsAfterResponse.ok()).toBeTruthy();
      const draftsAfterBody = (await draftsAfterResponse.json()) as {
        items?: Array<{ id?: unknown }>;
      };
      const draftAfterSend = draftsAfterBody.items?.find((item) => item.id === draftId);
      expect(draftAfterSend).toBeFalsy();

      // Message must appear in sent folder
      const sentResponse = await apiRequest(
        request,
        'GET',
        `/api/messages?folder=sent&search=${encodeURIComponent(subject)}&pageSize=20`,
        { token: adminToken },
      );
      expect(sentResponse.ok()).toBeTruthy();
      const sentBody = (await sentResponse.json()) as {
        items?: Array<{ id?: unknown }>;
      };
      const sentItem = sentBody.items?.find((item) => item.id === draftId);
      expect(sentItem).toBeTruthy();

      // Message must appear in recipient inbox
      const inboxResponse = await apiRequest(
        request,
        'GET',
        `/api/messages?folder=inbox&search=${encodeURIComponent(subject)}&pageSize=20`,
        { token: employeeToken },
      );
      expect(inboxResponse.ok()).toBeTruthy();
      const inboxBody = (await inboxResponse.json()) as {
        items?: Array<{ id?: unknown }>;
      };
      const inboxItem = inboxBody.items?.find((item) => item.id === draftId);
      expect(inboxItem).toBeTruthy();

      // Sending a non-draft must return 409
      const sendAgainResponse = await apiRequest(request, 'POST', `/api/messages/${draftId}/send`, {
        token: adminToken,
        data: {},
      });
      expect(sendAgainResponse.status()).toBe(409);
    } finally {
      await deleteMessageIfExists(request, adminToken, draftId);
    }
  });

  test('should allow updating content while sending draft', async ({ request }) => {
    let draftId: string | null = null;
    let adminToken: string | null = null;

    try {
      adminToken = await getAuthToken(request, 'admin');
      const employeeToken = await getAuthToken(request, 'employee');
      const employeeUserId = decodeJwtSubject(employeeToken);

      const timestamp = Date.now();
      const originalSubject = `QA TC-API-MSG-013 draft ${timestamp}`;
      const finalSubject = `QA TC-API-MSG-013 sent ${timestamp}`;

      // Create draft with original content
      const createResponse = await apiRequest(request, 'POST', '/api/messages', {
        token: adminToken,
        data: {
          isDraft: true,
          recipients: [{ userId: employeeUserId, type: 'to' }],
          subject: originalSubject,
          body: 'Original draft body',
          sendViaEmail: false,
        },
      });
      expect(createResponse.status()).toBe(201);
      const createBody = (await createResponse.json()) as { id?: unknown };
      draftId = createBody.id as string;

      // Send with updated subject and body
      const sendResponse = await apiRequest(request, 'POST', `/api/messages/${draftId}/send`, {
        token: adminToken,
        data: {
          subject: finalSubject,
          body: 'Updated body on send',
        },
      });
      expect(sendResponse.status()).toBe(200);

      // Verify detail reflects the updated content
      const detailResponse = await apiRequest(request, 'GET', `/api/messages/${draftId}`, {
        token: adminToken,
      });
      expect(detailResponse.status()).toBe(200);
      const detailBody = (await detailResponse.json()) as {
        subject?: unknown;
        body?: unknown;
        isDraft?: unknown;
      };
      expect(detailBody.subject).toBe(finalSubject);
      expect(detailBody.body).toBe('Updated body on send');
      expect(detailBody.isDraft).toBe(false);
    } finally {
      await deleteMessageIfExists(request, adminToken, draftId);
    }
  });
});
