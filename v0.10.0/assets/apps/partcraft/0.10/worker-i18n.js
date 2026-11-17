/* SPDX-License-Identifier: Apache-2.0 */
/**
 * worker-i18n.js — language files in PartCraft's workers (0.4). A worker has no page, so i18n.js cannot read the #cc-lang tag
 * there and t() would print bare keys. Each worker imports this module (brep-worker.js, compute-worker.js); the page sends
 * its catalog as the op i18nInit right after the worker starts (exact-client.js, compute-worker.js: pageCatalog()).
 */
import { addOps } from './worker-ops.js';
import { init } from './i18n.js';

addOps({
  i18nInit({ locale, chain, strings }) {
    if (strings && typeof strings === 'object') init({ locale: typeof locale === 'string' ? locale : 'en', chain: Array.isArray(chain) ? chain : null, strings });
    return true;
  },
});
