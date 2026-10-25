// Shared PDF-to-recipe logic: turns the text of one PDF into a parsed
// recipe via the AI model. Used by the email import and the PDF upload.
import { groqChat } from './groq.js';
import { tryParseJson } from './parse.js';

export const MAX_PDF_TEXT_CHARACTERS = 18000;

const PDF_PROMPT = `You are a recipe parser. The text below comes from a PDF, and may span multiple pages of the SAME recipe. Read all of it together and extract ONE recipe.

Return ONLY a json object with these keys:
{
  "title": "...",
  "description": "one short sentence",
  "prepTime": "...",
  "cookTime": "...",
  "servings": "...",
  "mealType": "breakfast | lunch | dinner | dessert | snack | drink",
  "tags": ["..."],
  "ingredients": ["..."],
  "instructions": ["..."],
  "notes": "..."
}

Rules:
- Treat all the text as parts of a single recipe. Do not create multiple recipes.
- If ingredients or steps span across pages, combine them in the correct order.
- Keep each ingredient and each instruction as its own string in the arrays.
- No commentary, no markdown, no explanation.`;

/**
 * Parses the extracted text of one PDF into a recipe object via the AI.
 * Returns {} when the model response could not be parsed; the caller is
 * expected to check recipe.error and missing fields.
 */
export async function recipeFromPdfText(pdfText) {
  const rawContent = await groqChat({
    messages: [{
      role: 'user',
      content: [{
        type: 'text',
        text: `${PDF_PROMPT}\n\nPDF TEXT:\n${String(pdfText).substring(0, MAX_PDF_TEXT_CHARACTERS)}`,
      }],
    }],
    temperature: 0.2,
    maxTokens: 3500,
    json: true,
    reasoningEffort: 'none',
  });
  // Tolerant parse so a stray code fence or thinking block cannot fail
  // the whole import (shared helper from lib/parse.js).
  return tryParseJson(rawContent) || {};
}
