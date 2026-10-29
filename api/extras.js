// One function, many endpoints.
//
// Vercel's Hobby plan allows 12 functions and /api already has 12, so new
// endpoints are added as actions here instead of as new files. vercel.json
// rewrites the public URL onto this dispatcher, e.g.
//   /api/undo-delete -> /api/extras?action=undo-delete
//
// The import() paths must stay literal so Vercel bundles each action.
export const config = { api: { bodyParser: { sizeLimit: '4mb' } }, maxDuration: 60 };

const ACTIONS = {
  'undo-delete': () => import('../lib/actions/undo-delete.js'),
  'health': () => import('../lib/actions/health.js'),
  'collections': () => import('../lib/actions/collections.js'),
  'cooked': () => import('../lib/actions/cooked.js'),
  'import-text': () => import('../lib/actions/import-text.js'),
  'share': () => import('../lib/actions/share.js'),
  'share-view': () => import('../lib/actions/share-view.js'),
  'share-photo': () => import('../lib/actions/share-photo.js'),
  'client-error': () => import('../lib/actions/client-error.js'),
  'ai-transform': () => import('../lib/actions/ai-transform.js'),
  'storage-stats': () => import('../lib/actions/storage-stats.js'),
  // Later tasks add entries here, always as literal import() paths.
};

export default async function handler(req, res) {
  const name = String(req.query.action || '');
  const load = Object.prototype.hasOwnProperty.call(ACTIONS, name) ? ACTIONS[name] : null;
  if (!load) return res.status(404).json({ error: 'Unknown action' });

  try {
    const mod = await load();
    return await mod.default(req, res);
  } catch (e) {
    // A broken action must not crash the function for every other action.
    console.error(`Action "${name}" failed:`, e);
    if (!res.headersSent) return res.status(500).json({ error: 'Something went wrong' });
  }
}
