import crypto from 'crypto';
import { Redis } from '@upstash/redis';
import { parsePdfText } from '../lib/pdf-text.js';
import { resizeImage } from '../lib/image-input.js';
import { groqChat, GROQ_MODEL, GROQ_VISION_MODEL } from '../lib/groq.js';
import { findDishImage } from '../lib/image.js';
import { getKv } from '../lib/redis.js';
import { bumpCounter } from '../lib/rate-limit.js';
import { normalizeMealType, cleanTags, findDuplicate, isUsableRecipe, normalizeIncomingRecipe } from '../lib/recipes.js';
import { tryParseJson } from '../lib/parse.js';
import { recipeFromPdfText } from '../lib/pdf-recipe.js';
import { listRecipeId } from '../lib/recipe-index.js';
import { saveRecipeRecord } from '../lib/save-recipe.js';
import { importRecipeFromUrl } from '../lib/url-recipe.js';
import { extractRecipeLinks, isMostlyLinks, bareOfProse } from '../lib/email-links.js';

// let, not const: tests swap in a fake store and a fake page fetcher instead of
// reaching Redis and the network.
let redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});
let linkDeps = {};

export function __setImportDepsForTests({ store, link } = {}) {
  if (store) redis = store;
  linkDeps = link || {};
}

export const config = { maxDuration: 60 };

const MAX_EMAIL_TEXT_CHARACTERS = 6000;
const MAX_IMAGES_PER_REQUEST = 3; // Groq's hard limit for the vision model
const MAX_PDFS_PER_REQUEST = 3; // Apps Script caps at 3, the API must not trust it

const IMAGE_PROMPT = `You are a recipe parser. The image(s) below show a recipe (or parts of one recipe). Read everything together and extract ONE recipe.

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
- Treat all provided images as parts of the same recipe. Do not create multiple recipes.
- Keep each ingredient and each instruction as its own string in the arrays.
- If the image contains no recipe, return {"error": "no recipe found"}.
- No commentary, no markdown, no explanation.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const importSecret = process.env.EMAIL_IMPORT_SECRET;
  if (!importSecret) {
    return res.status(500).json({ error: 'Email import is not configured' });
  }
  const authHeader = String(req.headers.authorization || '');
  const presented = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(importSecret);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: 'Groq API is not configured' });
  }

  // A daily ceiling for the whole importer, counted per AI call rather than per
  // request: one mail with three PDFs costs three calls, and the old counter let
  // it look like one. The bearer secret is good enough to read mail, so a leaked
  // secret should not be able to spend more than a day's budget either way.
  const dailyLimit = Number(process.env.EMAIL_IMPORT_DAILY_LIMIT) || 50;
  const day = new Date().toISOString().slice(0, 10);
  const spendOneCall = async (calls) => {
    try {
      for (let i = 0; i < calls; i += 1) {
        const used = await bumpCounter(getKv(), `email_import_daily:${day}`, 2 * 24 * 60 * 60);
        if (used > dailyLimit) return false;
      }
      return true;
    } catch (e) {
      // A counter we cannot read must not stop the owner's mail from importing.
      console.error('Email import daily counter unavailable:', e.message);
      return true;
    }
  };

  // Refuse before spending anything when today is already spent.
  try {
    const already = Number(await getKv().get(`email_import_daily:${day}`)) || 0;
    if (already >= dailyLimit) {
      return res.status(429).json({ error: 'Daily email import limit reached. Try again tomorrow.' });
    }
  } catch {
    // unknown: the per-call check below still applies
  }

  try {
    const payload = req.body || {};
    const sender = String(payload.from || payload.From || 'Email Import').slice(0, 300);
    const senderName =
      (sender.match(/^\s*"?([^"<]+)"?\s*</)?.[1] || sender).trim().slice(0, 40) || 'Email Contributor';
    const bodyText = String(payload.text || payload['body-plain'] || payload.html || '');
    const messageId = String(payload.messageId || '');

    // Idempotency: skip if we already handled this exact message
    if (messageId) {
      const previousImport = await redis.get(`email_import:${messageId}`);
      if (previousImport) {
        return res.status(200).json({ success: true, ...previousImport });
      }
    }

    const allAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    // The payload is JSON from outside, so a field can be any type. A number
    // where a string belongs used to throw here, which answered 500, and the
    // mail script retries a 500 as transient.
    const text = (v) => (typeof v === 'string' ? v : '');
    const mimeOf = (a) => text(a && (a.type || a.contentType)).toLowerCase();
    const nameOf = (a) => text(a && (a.filename || a.name)).toLowerCase();
    const usable = allAttachments.filter((a) => a && typeof a === 'object');
    const imageAttachments = usable.filter((a) => mimeOf(a).startsWith('image/'));
    const pdfAttachments = usable.filter((a) => mimeOf(a) === 'application/pdf' || nameOf(a).endsWith('.pdf'));

    console.log(
      `Received: bodyText=${bodyText.length} chars, ` +
      `${imageAttachments.length} image(s), ${pdfAttachments.length} PDF(s)`
    );

    // Each attachment is an AI call, so the server sets its own ceiling instead
    // of trusting the sender's script to have capped them.
    if (pdfAttachments.length > MAX_PDFS_PER_REQUEST) {
      return res.status(400).json({
        error: `At most ${MAX_PDFS_PER_REQUEST} PDFs per email.`,
        received: pdfAttachments.length,
      });
    }
    if (imageAttachments.length > MAX_IMAGES_PER_REQUEST) {
      return res.status(400).json({
        error: `At most ${MAX_IMAGES_PER_REQUEST} images per email.`,
        received: imageAttachments.length,
      });
    }

    const savedRecipes = [];

    // -----------------------------------------------------------------
    // 1. Process each PDF as its own recipe (all pages together)
    // -----------------------------------------------------------------
    const budgetExhausted = [];
    for (const pdf of pdfAttachments) {
      if (!(await spendOneCall(1))) {
        budgetExhausted.push('PDF skipped: daily limit reached');
        break;
      }
      const filename = text(pdf.filename || pdf.name) || 'attachment.pdf';
      const base64 = text(pdf.content || pdf.data);
      if (!base64) {
        console.warn(`PDF ${filename} has no content; skipping`);
        continue;
      }

      try {
        const buffer = Buffer.from(base64, 'base64');
        const text = await parsePdfText(buffer);

        console.log(`PDF ${filename}: ${text.length} chars of text`);

        if (text.length < 50) {
          console.warn(`PDF ${filename} has almost no text (${text.length} chars); skipping`);
          continue;
        }

        const recipe = normalizeIncomingRecipe(await recipeFromPdfText(text));

        if (!isUsableRecipe(recipe)) {
          console.warn(`PDF ${filename}: no usable recipe in the model output`, recipe.error || '');
          continue;
        }

        const saved = await persistRecipe(recipe, senderName);
        savedRecipes.push(saved);
        console.log(`${saved.duplicate ? 'Already had' : 'Saved'} recipe from PDF ${filename}: ${saved.recipe.title}`);
      } catch (err) {
        console.error(`Failed to process PDF ${filename}:`, err.message);
      }
    }

    // -----------------------------------------------------------------
    // 2. Process images as one recipe (up to Groq's 3-image limit)
    // -----------------------------------------------------------------
    if (imageAttachments.length > 0) {
      const images = [];
      for (const att of imageAttachments) {
        const base64Data = text(att.content || att.data);
        if (!base64Data) continue;
        try {
          const resized = await resizeImage(Buffer.from(base64Data, 'base64'), { width: 1024, height: 1024, quality: 80 });

          // Groq expects a data URL: data:image/jpeg;base64,...
          images.push(`data:image/jpeg;base64,${resized.toString('base64')}`);
        } catch (err) {
          console.warn('Image resize failed:', err.message);
        }
      }

      if (images.length > 0 && (await spendOneCall(1))) {
        try {
          const contentPayload = [
            { type: 'text', text: IMAGE_PROMPT },
            ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ];

          const recipe = normalizeIncomingRecipe(await callGroq(contentPayload, { vision: true }));

          if (!isUsableRecipe(recipe)) {
            console.warn('Image recipe: no usable recipe in the model output', recipe.error || '');
          } else {
            const saved = await persistRecipe(recipe, senderName);
            savedRecipes.push(saved);
            console.log(`${saved.duplicate ? 'Already had' : 'Saved'} recipe from ${images.length} image(s): ${saved.recipe.title}`);
          }
        } catch (err) {
          console.error(`Failed to process images:`, err.message);
        }
      }
    }

    // -----------------------------------------------------------------
    // 3. Links in the mail: follow each one and import the page it points to.
    //    Attachments win when there are any; a link is for the mail that is
    //    just "check this out" with an address in it.
    // -----------------------------------------------------------------
    const linkFailures = [];
    const linksFound = savedRecipes.length === 0 ? extractRecipeLinks(bodyText) : [];
    for (const url of linksFound) {
      const result = await importRecipeFromUrl({
        ...linkDeps,
        kv: redis,
        url,
        addedBy: senderName,
        // Only a page that needs the model spends the day's budget; a page with
        // structured data is free, so a mail of recipe links is not throttled.
        beforeAi: () => spendOneCall(1),
      });
      if (result.ok) {
        savedRecipes.push({ id: result.recipe.id, recipe: result.recipe, sourceUrl: url });
        console.log(`Saved recipe from link ${new URL(url).hostname}: ${result.recipe.title}`);
      } else if (result.status === 409 && result.duplicate) {
        savedRecipes.push({ id: result.duplicate.id, recipe: result.duplicate, duplicate: true, sourceUrl: url });
        console.log(`Already had recipe from link ${new URL(url).hostname}: ${result.duplicate.title}`);
      } else {
        // Not a recipe, unreachable, or over budget. Remember which, so the
        // sender is told about the link rather than sent a silent nothing.
        linkFailures.push({ url, status: result.status, error: result.error });
        console.warn(`Link not imported (${result.status}) ${new URL(url).hostname}: ${result.error}`);
        if (result.status === 429) break; // the day is spent: stop following links
      }
    }

    // -----------------------------------------------------------------
    // 4. If nothing else worked but there's body text, fall back to that.
    //    A mail that is only a link has no recipe text for a model to read, and
    //    asking one anyway would invent a recipe from "Check this out!".
    // -----------------------------------------------------------------
    //
    // "Mostly links" is a guess from length, so it is only trusted when there is
    // nothing else to go on. A short written recipe that happens to carry a link
    // still gets read as text if that link turned out not to be a recipe page.
    const textIsJustLinks = linksFound.length > 0 && isMostlyLinks(bodyText) && bareOfProse(bodyText);
    if (savedRecipes.length === 0 && bodyText.trim().length > 0 && !textIsJustLinks) {
      const withinBudget = await spendOneCall(1);
      if (!withinBudget) budgetExhausted.push('Email text skipped: daily limit reached');
      try {
        if (!withinBudget) throw new Error('daily limit reached');
        const recipe = await callGroq([
          {
            type: 'text',
            text:
              `Extract recipe details from this email message. Return ONLY a json object:\n\n` +
              `${bodyText.substring(0, MAX_EMAIL_TEXT_CHARACTERS)}`,
          },
        ]);

        if (isUsableRecipe(recipe)) {
          const saved = await persistRecipe(normalizeIncomingRecipe(recipe), senderName);
          savedRecipes.push(saved);
          console.log(`${saved.duplicate ? 'Already had' : 'Saved'} recipe from email body: ${saved.recipe.title}`);
        }
      } catch (err) {
        console.error('Failed to process email body text:', err.message);
      }
    }

    if (savedRecipes.length === 0) {
      // 422, not 500: this email simply has no recipe in it. Code.gs treats
      // 5xx as transient and would retry (3 extra AI calls) before telling
      // the sender; a 422 fails fast and cleanly.
      return res.status(422).json({
        error: 'No recipes could be extracted from this email',
        // What happened to each link, so the reply can say "that page had no
        // recipe" instead of a bare failure. Statuses and our own short
        // messages only; nothing from the remote page is echoed back.
        ...(linkFailures.length ? { links: linkFailures.map((f) => ({ url: f.url, status: f.status, error: f.error })) } : {}),
        ...(budgetExhausted.length ? { budgetExhausted } : {}),
      });
    }

    const first = savedRecipes[0];
    const result = {
      id: first.id,
      recipe: first.recipe,
      recipes: savedRecipes,
      count: savedRecipes.length,
    };

    if (messageId) {
      await redis.set(`email_import:${messageId}`, result, { ex: 60 * 60 * 24 * 30 });
    }

    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('Failed to import email recipe:', error);
    return res.status(500).json({ error: 'Failed to import recipe' });
  }
}

/**
 * Send content parts to Groq and parse the JSON recipe response.
 */
async function callGroq(contentPayload, { vision = false } = {}) {
  const rawContent = await (linkDeps.chat || groqChat)({
    messages: [{ role: 'user', content: contentPayload }],
    temperature: 0.2,
    maxTokens: 3500,
    json: true,
    model: vision ? GROQ_VISION_MODEL : GROQ_MODEL,
    reasoningEffort: 'none',
  });
  // Tolerant parse so a stray code fence or thinking block cannot
  // fail the whole import (shared helper from lib/parse.js).
  return tryParseJson(rawContent) || {};
}

/**
 * Normalize, give an id, and store a recipe in Redis.
 * If a recipe with the same title already exists, the existing one is returned instead.
 */
async function persistRecipe(parsedRecipe, senderName) {
  // isUsableRecipe guards every call site, so a real title is guaranteed here.
  const title = String(parsedRecipe.title || '').trim().slice(0, 200);

  // Duplicate check and photo lookup run at the same time to keep imports fast
  const [dup, image] = await Promise.all([
    findDuplicate(redis, { title }),
    findDishImage(title, { kv: getKv() }),
  ]);

  if (dup) {
    return { id: dup.id, recipe: dup, duplicate: true };
  }

  const toStrings = (v, max) =>
    Array.isArray(v) ? v.slice(0, max).map(String).map((s) => s.trim()).filter(Boolean) : [];

  const recipeId = `r_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const recipe = {
    id: recipeId,
    title,
    description: String(parsedRecipe.description || '').slice(0, 500),
    prepTime: String(parsedRecipe.prepTime || '').slice(0, 40),
    cookTime: String(parsedRecipe.cookTime || '').slice(0, 40),
    servings: String(parsedRecipe.servings || '').slice(0, 40),
    mealType: normalizeMealType(parsedRecipe.mealType),
    tags: cleanTags(parsedRecipe.tags, 10),
    ingredients: toStrings(parsedRecipe.ingredients, 60),
    instructions: toStrings(parsedRecipe.instructions, 60),
    notes: String(parsedRecipe.notes || '').slice(0, 1000),
    ...(image ? { image } : {}),
    user: senderName,
    addedBy: senderName,
    createdAt: Date.now(),
  };

  // The shared writer, like every other import: it caps lengths and strips
  // markup. The text here comes from a model reading a stranger's email, so it
  // is the last place that should reach Redis unsanitised.
  const saved = await saveRecipeRecord(redis, recipe);
  await listRecipeId(redis, recipeId);

  return { id: recipeId, recipe: saved };
}
