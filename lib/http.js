// Small helpers shared by the API routes.

// Logs the real error server-side and returns a generic message to the
// browser, so Redis or library internals never leak to the client.
export function sendServerError(res, err, publicMessage = 'Something went wrong') {
  console.error(err);
  return res.status(500).json({ error: publicMessage });
}
