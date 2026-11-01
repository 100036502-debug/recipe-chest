const IMPORT_LABEL = 'recipe-import';
const FAILED_LABEL = 'recipe-import-failed';

/**
 * Sender allowlist, REQUIRED. Set the Script Property ALLOWED_SENDERS to a
 * comma-separated list of exact addresses. An empty list refuses everything:
 * the From header can be spoofed, so the label alone cannot be the gate, and an
 * open importer both spends the AI budget and replies to whoever wrote in.
 */
function allowedSender(address) {
  const raw = PropertiesService.getScriptProperties().getProperty('ALLOWED_SENDERS');
  if (!raw) {
    console.error('ALLOWED_SENDERS is not set: refusing every import until it is configured.');
    return false;
  }
  const wanted = String(raw)
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (!wanted.length) return false;
  return wanted.indexOf(String(address || '').trim().toLowerCase()) !== -1;
}

// Replies go to the envelope From only. Reply-To is set by the sender's own
// mail client, so trusting it lets a stranger pick who receives our mail.
function fromAddress(message) {
  const from = String(message.getFrom() || '');
  const match = from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : '';
}
const MAX_IMPORT_ATTEMPTS = 3;
const MAX_PDFS_PER_MESSAGE = 3;
const MAX_IMAGES_PER_MESSAGE = 3; // matches the vision model's limit in api/import-email.js
// Raw bytes, before base64 encoding (which adds ~33%). Vercel rejects
// request bodies over about 4.5 MB, so keep the total well under that.
const MAX_ATTACHMENT_BYTES_TOTAL = 3 * 1024 * 1024;

/**
 * Run this once from the Apps Script editor to install a trigger
 * that checks for new recipe-import emails every 5 minutes.
 */
function installRecipeImportTrigger() {
  const alreadyInstalled = ScriptApp.getProjectTriggers().some(
    (trigger) => trigger.getHandlerFunction() === 'pollRecipeImports'
  );
  if (!alreadyInstalled) {
    ScriptApp.newTrigger('pollRecipeImports').timeBased().everyMinutes(5).create();
  }
}

/**
 * Main polling function. Runs on the trigger above.
 */
function pollRecipeImports() {
  const properties = PropertiesService.getScriptProperties();
  const apiUrl = properties.getProperty('RECIPE_IMPORT_API_URL');
  const secret = properties.getProperty('RECIPE_IMPORT_SECRET');
  if (!apiUrl || !secret) {
    throw new Error('Set RECIPE_IMPORT_API_URL and RECIPE_IMPORT_SECRET in Script Properties.');
  }
  if (!/^https:\/\//i.test(String(apiUrl))) {
    throw new Error('RECIPE_IMPORT_API_URL must start with https:// before a bearer secret is sent to it.');
  }

  // 50 threads per poll so a burst of imports cannot be blocked by
  // a queue of unread messages.
  const threads = GmailApp.search(`label:${IMPORT_LABEL} is:unread`, 0, 50);
  for (const thread of threads) {
    for (const message of thread.getMessages()) {
      if (!message.isUnread()) continue;
      if (!allowedSender(fromAddress(message))) {
        // Never send the contents anywhere: mark it read and park it, with no
        // reply to an address the sender controls.
        const failedLabel = GmailApp.getUserLabelByName(FAILED_LABEL) || GmailApp.createLabel(FAILED_LABEL);
        failedLabel.addToThread(thread);
        const importLabel = GmailApp.getUserLabelByName(IMPORT_LABEL);
        if (importLabel) importLabel.removeFromThread(thread);
        message.markRead();
        continue;
      }
      try {
        importMessage(message, apiUrl, secret);
      } catch (error) {
        handleImportError(thread, message, error);
      }
    }
  }
}

/**
 * Called when importMessage throws. Transient failures (HTTP 429 / 5xx)
 * stay unread so the next poll retries them, but at most
 * MAX_IMPORT_ATTEMPTS times. Everything else is marked failed once and
 * never processed again.
 */
function handleImportError(thread, message, error) {
  const msg = String(error && error.message || error || '');
  console.error(`Import failed for message ${message.getId()}: ${msg}`);

  if (isTransientFailure(msg)) {
    const properties = PropertiesService.getScriptProperties();
    const key = `import_attempts:${message.getId()}`;
    const attempts = Number(properties.getProperty(key) || 0) + 1;
    if (attempts <= MAX_IMPORT_ATTEMPTS) {
      properties.setProperty(key, String(attempts));
      console.warn(`Transient failure (${msg}); attempt ${attempts} of ${MAX_IMPORT_ATTEMPTS}, will retry`);
      return;
    }
    properties.deleteProperty(key);
    markFailed(thread, message, `repeated server errors (${msg})`);
    return;
  }

  markFailed(thread, message, msg);
}

// True for failures that are worth retrying: rate limits and server errors.
function isTransientFailure(message) {
  // Only the status in the first line counts. The message can quote up to
  // 300 characters of the response body, and a 400 whose body happens to
  // contain e.g. "503" must NOT be treated as a transient server error.
  return /^Recipe API returned (429|5\d\d):/.test(message);
}

/**
 * Flags a thread as failed, stops further processing (marks read,
 * moves it off the import label) and tells the sender why, once.
 */
function markFailed(thread, message, reason) {
  const failedLabel = GmailApp.getUserLabelByName(FAILED_LABEL) || GmailApp.createLabel(FAILED_LABEL);
  failedLabel.addToThread(thread);
  const importLabel = GmailApp.getUserLabelByName(IMPORT_LABEL);
  if (importLabel) importLabel.removeFromThread(thread);
  message.markRead();

  const sender = fromAddress(message);
  if (sender && canReplyToday()) {
    // Never the server's own words: the reason quotes up to 300 characters of
    // the API response, and this mail goes to whoever the From header named.
    console.error('Import failure reason (not sent to the sender):', reason);
    GmailApp.sendEmail(
      sender,
      'Recipe Chest: could not import this email',
      'Could not import this email. Check that it contains a recipe ' +
      '(as text, a PDF or a photo) and try sending it again.'
    );
  }
}

/**
 * (c) Replies are capped per day, so a mail loop cannot turn the script into a
 * sender of unlimited mail. The counter lives in Script Properties because that
 * is the only store available to a trigger.
 */
const MAX_REPLIES_PER_DAY = 20;

function canReplyToday() {
  try {
    const properties = PropertiesService.getScriptProperties();
    const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const key = `replies_on:${today}`;
    const used = Number(properties.getProperty(key) || 0);
    if (used >= MAX_REPLIES_PER_DAY) {
      console.warn(`Reply cap reached (${used}); not sending another today.`);
      return false;
    }
    properties.setProperty(key, String(used + 1));
    return true;
  } catch (e) {
    console.error('Reply counter unavailable:', e && e.message);
    return false; // no counter, no mail
  }
}

/**
 * Sends one email's contents to the Vercel API, including PDF attachments.
 */
function importMessage(message, apiUrl, secret) {
  const sender = fromAddress(message);
  if (!sender) {
    throw new Error('Could not find the original sender email address.');
  }

  const bodyText = message.getPlainBody() || '';

  // One shared size budget per email so the attachments in one message
  // can never exceed what the serverless function will accept.
  const budget = { used: 0, skipped: [] };
  const pdfs = extractPdfAttachments(message, budget);
  const images = extractImageAttachments(message, budget);

  // Nothing to do if the email has neither body text nor attachments:
  // flag it as failed so it is not retried every 5 minutes forever.
  if (!bodyText.trim() && pdfs.length === 0 && images.length === 0) {
    markFailed(message.getThread(), message, 'no recipe text or attachments found');
    return;
  }

  const payload = {
    from: sender,
    text: bodyText,
    messageId: message.getId(),
  };
  if (pdfs.length > 0 || images.length > 0) {
    payload.attachments = [...pdfs, ...images];
  }

  const response = UrlFetchApp.fetch(apiUrl, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${secret}` },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    // A redirect would carry the bearer secret to wherever it points.
    followRedirects: false,
  });

  const status = response.getResponseCode();
  const responseText = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error(`Recipe API returned ${status}: ${responseText.substring(0, 300)}`);
  }

  const result = JSON.parse(responseText);
  const saved = (result.recipes && result.recipes.length)
    ? result.recipes
    : (result.recipe ? [result.recipe] : []);
  if (!result.success || saved.length === 0) {
    throw new Error('Recipe API response did not include any saved recipes.');
  }

  // A confirmation that cannot be sent (mail quota, a bad address) must not
  // turn a successful import into a failed one.
  try {
    if (sender && canReplyToday()) sendConfirmation(sender, saved, budget.skipped);
  } catch (e) {
    console.error('Confirmation could not be sent:', e && e.message);
  }
  message.markRead();
}

/**
 * Walks the message's attachments and returns up to MAX_PDFS_PER_MESSAGE
 * PDFs as { filename, type, content } objects, where `content` is base64.
 *
 * Field names match what the Vercel API already reads:
 *   - attachment.type    (MIME type)
 *   - attachment.content (base64 string)
 */
function extractPdfAttachments(message, budget) {
  const attachments = message.getAttachments() || [];
  const pdfs = [];
  if (!budget) budget = { used: 0, skipped: [] };

  for (const att of attachments) {
    if (pdfs.length >= MAX_PDFS_PER_MESSAGE) break;

    const name = att.getName() || '';
    const contentType = att.getContentType() || '';

    // Accept both the proper MIME and files just named .pdf,
    // because some senders mark them as application/octet-stream.
    const isPdf = contentType === 'application/pdf' ||
                  name.toLowerCase().endsWith('.pdf');
    if (!isPdf) continue;

    try {
      const bytes = att.getBytes();

      // Count against the shared per-message budget so the JSON body
      // (base64) stays under the serverless function's request cap.
      if (budget.used + bytes.length > MAX_ATTACHMENT_BYTES_TOTAL) {
        const label = name || 'a PDF';
        budget.skipped.push(label);
        console.warn(`Skipping PDF ${name}: would exceed the ${MAX_ATTACHMENT_BYTES_TOTAL / 1024 / 1024} MB attachment budget`);
        continue;
      }
      budget.used += bytes.length;

      pdfs.push({
        filename: name,
        type: 'application/pdf',
        content: Utilities.base64Encode(bytes),
      });
    } catch (err) {
      console.warn(`Could not read attachment ${name}: ${err.message}`);
    }
  }

  return pdfs;
}

/**
 * Walks the message's attachments and returns up to MAX_IMAGES_PER_MESSAGE
 * photos (jpeg, png, webp) as { filename, type, content } with base64
 * content, counted against the same per-message byte budget as the PDFs.
 * The API resizes them before sending them to the vision model.
 */
function extractImageAttachments(message, budget) {
  const attachments = message.getAttachments() || [];
  const images = [];
  if (!budget) budget = { used: 0, skipped: [] };

  const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

  for (const att of attachments) {
    if (images.length >= MAX_IMAGES_PER_MESSAGE) break;

    const name = att.getName() || '';
    const contentType = (att.getContentType() || '').toLowerCase();
    const ext = (name.toLowerCase().split('.').pop() || '').trim();

    const isImage =
      (contentType.startsWith('image/jpeg') ||
       contentType.startsWith('image/png') ||
       contentType.startsWith('image/webp')) ||
      IMAGE_EXTENSIONS.includes(ext);
    if (!isImage) continue;

    try {
      const bytes = att.getBytes();
      if (budget.used + bytes.length > MAX_ATTACHMENT_BYTES_TOTAL) {
        budget.skipped.push(name || 'an image');
        console.warn(`Skipping image ${name}: would exceed the ${MAX_ATTACHMENT_BYTES_TOTAL / 1024 / 1024} MB attachment budget`);
        continue;
      }
      budget.used += bytes.length;

      images.push({
        filename: name,
        type: contentType || 'image/jpeg',
        content: Utilities.base64Encode(bytes),
      });
    } catch (err) {
      console.warn(`Could not read attachment ${name}: ${err.message}`);
    }
  }

  return images;
}

/**
 * Replies to the original sender with one summary covering every recipe
 * in the import: newly added ones get the full listing, duplicates just
 * a one-line note. Skipped oversized attachments are mentioned at the end.
 */
function sendConfirmation(email, recipes, skippedFiles) {
  const entries = Array.isArray(recipes) ? recipes : [recipes];

  const lines = [];
  entries.forEach((entry, index) => {
    const recipe = entry.recipe || entry;
    if (index > 0) lines.push('', '----------', '');

    if (entry.duplicate) {
      lines.push(`Already in your Recipe Chest: ${recipe.title}`);
      return;
    }

    lines.push(`Added to Recipe Chest: ${recipe.title}`);
    if (recipe.description) lines.push('', recipe.description);
    if (recipe.ingredients && recipe.ingredients.length) {
      lines.push('', 'Ingredients');
      for (const item of recipe.ingredients) lines.push(`- ${item}`);
    }
    if (recipe.instructions && recipe.instructions.length) {
      lines.push('', 'Instructions');
      recipe.instructions.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
    }
  });

  if (skippedFiles && skippedFiles.length > 0) {
    lines.push('');
    for (const name of skippedFiles) {
      lines.push(
        `Skipped ${name} (over ${MAX_ATTACHMENT_BYTES_TOTAL / 1024 / 1024} MB). ` +
        'Try a smaller file or paste the recipe text instead.'
      );
    }
  }

  const subject = entries.length === 1
    ? (entries[0].duplicate
        ? `Already in your Recipe Chest: ${(entries[0].recipe || entries[0]).title}`
        : `Added to Recipe Chest: ${(entries[0].recipe || entries[0]).title}`)
    : `Recipe Chest: ${entries.length} recipes from your email`;

  GmailApp.sendEmail(email, subject, lines.join('\n'));
}
