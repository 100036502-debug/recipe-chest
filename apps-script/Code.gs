const IMPORT_LABEL = 'recipe-import';

function installRecipeImportTrigger() {
  const alreadyInstalled = ScriptApp.getProjectTriggers().some(
    (trigger) => trigger.getHandlerFunction() === 'pollRecipeImports'
  );
  if (!alreadyInstalled) {
    ScriptApp.newTrigger('pollRecipeImports').timeBased().everyMinutes(5).create();
  }
}

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
        const sender = message.getReplyTo() || message.getFrom();
        const recipientMatch = sender.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
        if (!recipientMatch) throw new Error('Could not find the original sender email address.');

        const response = UrlFetchApp.fetch(apiUrl, {
          method: 'post',
          contentType: 'application/json',
          headers: { Authorization: `Bearer ${secret}` },
          payload: JSON.stringify({
            from: sender,
            text: message.getPlainBody(),
            messageId: message.getId(),
          }),
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

        const recipe = result.recipe;
        const recipeText = [
          `Added to Recipe Chest: ${recipe.title}`,
          '',
          recipe.description || '',
          '',
          'Ingredients',
          ...(recipe.ingredients || []).map((item) => `- ${item}`),
          '',
          'Instructions',
          ...(recipe.instructions || []).map((step, index) => `${index + 1}. ${step}`),
        ].join('\n');

        GmailApp.sendEmail(
          recipientMatch[0],
          `Added to Recipe Chest: ${recipe.title}`,
          recipeText
        );
        message.markRead();
      } catch (error) {
        console.error(`Import failed for message ${message.getId()}: ${error.message}`);
      }
    }
  }
}