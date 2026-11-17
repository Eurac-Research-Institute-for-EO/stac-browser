/**
* Authentication credential scoping tests.
*
* Verifies that credentials established for one catalog are not sent to a
* catalog that is selected later, and that static request headers are ignored
* in catalog-selection mode.
*/
import { test, expect } from './fixtures.js';
import { HOME_PATH, configureBrowser, mockStacResource } from './helpers.js';
import { http, HttpResponse } from 'msw';
import StaticCatalog from '../fixtures/instances/static.js';

const catalogAUrl = 'https://a.example/stac/catalog.json';
const catalogBUrl = 'https://b.example/stac/catalog.json';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Accept-Language, X-Api-Key, X-Static-Token'
};

function createCatalog(url, title) {
  const catalog = new StaticCatalog({ url });
  catalog.setMetadata({
    title,
    description: `Mock catalog for ${title}.`
  });
  return catalog.root.build();
}

test.describe('Authentication credential scoping', () => {
  test('does not send credentials of a previous catalog to a newly selected catalog', async ({ page, worker }) => {
    const catalogA = createCatalog(catalogAUrl, 'Credential Test Catalog A');
    const catalogB = createCatalog(catalogBUrl, 'Credential Test Catalog B');
    const requests = { a: [], b: [] };

    await mockStacResource(worker, 'https://stacindex.org/api/catalogs', []);
    await worker.use(
      http.options(/https:\/\/(a|b)\.example\/.*/, () => new HttpResponse(null, { status: 204, headers: corsHeaders })),
      http.get(catalogAUrl, ({ request }) => {
        const headers = {
          apiKey: request.headers.get('x-api-key'),
          staticToken: request.headers.get('x-static-token')
        };
        requests.a.push(headers);
        if (headers.apiKey !== 'secret-a') {
          return HttpResponse.json({ code: 401, description: 'Unauthorized' }, { status: 401, headers: corsHeaders });
        }
        return HttpResponse.json(catalogA, { headers: corsHeaders });
      }),
      http.get(catalogBUrl, ({ request }) => {
        requests.b.push({
          apiKey: request.headers.get('x-api-key'),
          staticToken: request.headers.get('x-static-token')
        });
        return HttpResponse.json(catalogB, { headers: corsHeaders });
      })
    );

    await configureBrowser(page, {
      authConfig: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
      requestHeaders: { 'X-Static-Token': 'static-secret' }
    });

    await page.goto(HOME_PATH);
    const urlInput = page.getByRole('textbox', { name: /please specify a stac catalog or api/i });
    const loadButton = page.getByRole('button', { name: /^load$/i });

    // Load catalog A and log in when it asks for credentials
    await urlInput.fill(catalogAUrl);
    await loadButton.click();

    const authInput = page.locator('#stac-browser-auth-modal input[type="password"]');
    await expect(authInput).toBeVisible({ timeout: 10000 });
    await authInput.fill('secret-a');
    await page.locator('#stac-browser-auth-modal').getByRole('button', { name: /submit/i }).click();

    await expect(page.getByRole('heading', { name: /credential test catalog a/i })).toBeVisible({ timeout: 10000 });
    expect(requests.a.some(r => r.apiKey === 'secret-a')).toBe(true);

    // Static request headers are ignored in catalog-selection mode
    expect(requests.a.every(r => r.staticToken === null)).toBe(true);

    // Switch to catalog B
    await page.getByRole('button', { name: /browse/i }).click();
    await page.getByRole('link', { name: /switch catalog/i }).click();
    await expect(urlInput).toBeVisible({ timeout: 10000 });

    await urlInput.fill(catalogBUrl);
    await loadButton.click();

    await expect(page.getByRole('heading', { name: /credential test catalog b/i })).toBeVisible({ timeout: 10000 });
    expect(requests.b.length).toBeGreaterThan(0);
    expect(requests.b.every(r => r.apiKey === null)).toBe(true);
    expect(requests.b.every(r => r.staticToken === null)).toBe(true);
  });
});
