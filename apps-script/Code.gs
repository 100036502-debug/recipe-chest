const IMPORT_LABEL = 'recipe-import';
const MAX_PDFS_PER_MESSAGE = 3;
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

  const threads = GmailApp.search(`label:${IMPORT_LABEL} is:unread`, 0, 20);
  for (const thread of threads) {
    for (const message of thread.getMessages()) {
      if (!message.isUnread()) continue;
      try {
        importMessage(message, apiUrl, secret);
      } catch (error) {
        console.error(`Import failed for message ${message.getId()}: ${error.message}`);
      }
    }
  }
}

/**
 * Sends one email's contents to the Vercel API, including PDF attachments.
 */
function importMessage(message, apiUrl, secret) {
  const sender = message.getReplyTo() || message.getFrom();
  const recipientMatch = sender.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (!recipientMatch) {
    throw new Error('Could not find the original sender email address.');
  }

  const bodyText = message.getPlainBody() || '';

  // One shared size budget per email so the attachments in one message
  // can never exceed what the serverless function will accept.
  const budget = { used: 0, skipped: [] };
  const pdfs = extractPdfAttachments(message, budget);

  // Nothing to do if the email has neither body text nor PDFs
  if (!bodyText.trim() && pdfs.length === 0) {
    return;
  }

  const payload = {
    from: sender,
    text: bodyText,
    messageId: message.getId(),
  };
  if (pdfs.length > 0) {
    payload.attachments = pdfs;
  }

  const response = UrlFetchApp.fetch(apiUrl, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${secret}` },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  const responseText = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error(`Recipe API returned ${status}: ${responseText.substring(0, 300)}`);
  }

  const result = JSON.parse(responseText);
  if (!result.success || !result.recipe) {
    throw new Error('Recipe API response did not include a saved recipe.');
  }

  sendConfirmation(recipientMatch[0], result.recipe, budget.skipped);
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
 * Replies to the original sender with a short summary of what was saved.
 */
function sendConfirmation(email, recipe, skippedFiles) {
  const lines = [
    `Added to Recipe Chest: ${recipe.title}`,
    '',
    recipe.description || '',
    '',
    'Ingredients',
    ...(recipe.ingredients || []).map((item) => `- ${item}`),
    '',
    'Instructions',
    ...(recipe.instructions || []).map((step, index) => `${index + 1}. ${step}`),
  ];

  if (skippedFiles && skippedFiles.length > 0) {
    lines.push('');
    for (const name of skippedFiles) {
      lines.push(
        `Skipped ${name} (over ${MAX_ATTACHMENT_BYTES_TOTAL / 1024 / 1024} MB). ` +
        'Try a smaller file or paste the recipe text instead.'
      );
    }
  }

  GmailApp.sendEmail(
    email,
    `Added to Recipe Chest: ${recipe.title}`,
    lines.join('\n')
  );
}
