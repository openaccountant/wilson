import { createServer, type Server } from 'http';
import { createLinkToken, createUpdateLinkToken, exchangePublicToken, getItemInfo, getItemInstitutionId, hasLocalPlaidCreds } from './client.js';
import { openBrowser } from '../utils/browser.js';
import { savePlaidItem, getPlaidItems } from './store.js';
import type { PlaidItem } from './store.js';

const PORT = 53781;

/**
 * HTML page that embeds Plaid Link for in-browser bank connection.
 */
function buildLinkPage(linkToken: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Open Accountant — Connect Bank</title>
  <meta charset="utf-8" />
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; margin: 0; background: #f8f9fa;
    }
    .container { text-align: center; max-width: 400px; padding: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #6b7280; margin-bottom: 1.5rem; }
    #status { margin-top: 1rem; font-weight: 500; }
    .success { color: #059669; }
    .error { color: #dc2626; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Open Accountant — Connect Bank</h1>
    <p>Plaid Link will open automatically...</p>
    <div id="status"></div>
  </div>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <script>
    const handler = Plaid.create({
      token: '${linkToken}',
      onSuccess: async (publicToken, metadata) => {
        document.getElementById('status').textContent = 'Connecting...';
        try {
          const res = await fetch('/callback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ public_token: publicToken, metadata }),
          });
          const data = await res.json();
          document.getElementById('status').className = 'success';
          document.getElementById('status').textContent =
            'Connected! You can close this window and return to Open Accountant.';
        } catch (err) {
          document.getElementById('status').className = 'error';
          document.getElementById('status').textContent = 'Error: ' + err.message;
        }
      },
      onExit: (err) => {
        if (err) {
          document.getElementById('status').className = 'error';
          document.getElementById('status').textContent = 'Link exited: ' + (err.display_message || err.error_message || 'cancelled');
        } else {
          document.getElementById('status').textContent = 'Cancelled. You can close this window.';
        }
      },
    });
    handler.open();
  </script>
</body>
</html>`;
}


/**
 * Start a local HTTP server to handle Plaid Link flow.
 * Opens browser, receives public token callback, exchanges for access token,
 * stores credentials, then auto-shuts down.
 *
 * @param useProxy - If true, use the OA API proxy instead of local Plaid creds
 * @returns The linked PlaidItem on success, or null if cancelled/failed
 */
export async function startPlaidLinkServer(useProxy = false): Promise<PlaidItem | null> {
  const linkToken = await createLinkToken(true, useProxy);

  return new Promise<PlaidItem | null>((resolve) => {
    let server: Server;
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        server.close();
        resolve(null);
      }
    };

    // Auto-shutdown after 5 minutes
    const timeout = setTimeout(cleanup, 5 * 60 * 1000);

    server = createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(buildLinkPage(linkToken));
        return;
      }

      if (req.method === 'POST' && req.url === '/callback') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const { public_token } = JSON.parse(body);
            const { accessToken, itemId } = await exchangePublicToken(public_token, useProxy);
            const info = await getItemInfo(accessToken, useProxy);

            // Duplicate Item detection: check if institution is already linked
            const existingItems = getPlaidItems();
            const duplicate = existingItems.find(
              (existing) => existing.institutionName.toLowerCase() === info.institutionName.toLowerCase()
                && existing.itemId !== itemId
            );

            const item: PlaidItem = {
              itemId,
              accessToken,
              institutionName: info.institutionName,
              accounts: info.accounts,
              cursor: duplicate?.cursor ?? null, // preserve cursor if replacing a duplicate
              linkedAt: new Date().toISOString(),
            };

            savePlaidItem(item);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              institution: info.institutionName,
              duplicate: duplicate ? duplicate.institutionName : undefined,
            }));

            clearTimeout(timeout);
            resolved = true;
            server.close();
            resolve(item);
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.listen(PORT, () => {
      openBrowser(`http://localhost:${PORT}`);
    });

    server.on('error', () => {
      cleanup();
    });
  });
}

/**
 * Start Plaid Link in update mode for re-authentication.
 * Used when a Plaid Item's credentials become stale (ITEM_LOGIN_REQUIRED).
 *
 * @param item - The PlaidItem that needs re-authentication
 * @param useProxy - If true, use the OA API proxy
 * @returns true if re-auth succeeded, false if cancelled/failed
 */
export async function startPlaidLinkUpdateServer(
  item: PlaidItem,
  useProxy = false,
): Promise<boolean> {
  const linkToken = await createUpdateLinkToken(item.accessToken, useProxy);

  return new Promise<boolean>((resolve) => {
    let server: Server;
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        server.close();
        resolve(false);
      }
    };

    const timeout = setTimeout(cleanup, 5 * 60 * 1000);

    server = createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(buildLinkPage(linkToken));
        return;
      }

      if (req.method === 'POST' && req.url === '/callback') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            // In update mode, onSuccess fires but no new public_token exchange is needed.
            // The existing access_token remains valid after re-auth.
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, institution: item.institutionName }));

            clearTimeout(timeout);
            resolved = true;
            server.close();
            resolve(true);
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.listen(PORT, () => {
      openBrowser(`http://localhost:${PORT}`);
    });

    server.on('error', () => {
      cleanup();
    });
  });
}
