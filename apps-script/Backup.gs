/**
 * Recipe Chest - weekly backup to Google Drive.
 *
 * Lives in the same Apps Script project as Code.gs. Copy this file in next to it.
 * Code.gs is not touched by this file.
 *
 * ONE-TIME SETUP (the owner does this once, in the Apps Script editor):
 *   1. Project Settings > Script properties, add:
 *        BACKUP_API_URL     https://<your-app>/api/export
 *        BACKUP_SECRET      the same long random string as BACKUP_SECRET in the app
 *        BACKUP_FOLDER_NAME optional, default "Recipe Chest Backups"
 *        BACKUP_KEEP_WEEKS  optional, default 8
 *        BACKUP_NOTIFY_EMAIL optional, default the script owner's address
 *   2. Run installWeeklyBackupTrigger() once. Google will ask you to approve
 *      Drive and Mail access - that approval is what lets the backup write files
 *      and email you a summary, and it only has to happen once.
 *   3. Run weeklyBackup() once by hand to check the folder and files appear.
 *
 * The file names match what the app's Export button writes, so the app's
 * Restore button can read them straight from the folder: load the recipes file
 * first, then the photo files.
 */

var SLICE_LIMIT = 10;
var MAX_SLICES = 200; // safety cap: 2000 photos per run

function scriptProps_() {
  var props = PropertiesService.getScriptProperties();
  var url = (props.getProperty('BACKUP_API_URL') || '').trim();
  var secret = (props.getProperty('BACKUP_SECRET') || '').trim();
  if (!url) throw new Error('BACKUP_API_URL is not set in Script properties.');
  if (!secret) throw new Error('BACKUP_SECRET is not set in Script properties.');
  return {
    url: url,
    secret: secret,
    folderName: (props.getProperty('BACKUP_FOLDER_NAME') || 'Recipe Chest Backups').trim(),
    keepWeeks: Math.max(1, Number(props.getProperty('BACKUP_KEEP_WEEKS') || 8) || 8),
    notify: (props.getProperty('BACKUP_NOTIFY_EMAIL') || Session.getEffectiveUser().getEmail()).trim(),
  };
}

function todayStamp_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function fetchJson_(url, secret) {
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + secret },
    muteHttpExceptions: true,
    followRedirects: true,
  });
  var code = response.getResponseCode();
  if (code !== 200) {
    throw new Error('GET ' + url + ' failed with HTTP ' + code + ': ' + response.getContentText().slice(0, 300));
  }
  return response.getContentText();
}

function backupFolder_(config) {
  var roots = DriveApp.getFoldersByName(config.folderName);
  return roots.hasNext() ? roots.next() : DriveApp.createFolder(config.folderName);
}

function weeklyBackup() {
  var config = scriptProps_();
  var stamp = todayStamp_();
  var summary = { recipes: 0, photoFiles: 0, bytes: 0 };

  try {
    var root = backupFolder_(config);
    var dayFolder = root.createFolder(stamp);

    // 1. The recipes themselves.
    var recipesJson = fetchJson_(config.url, config.secret);
    var parsed = JSON.parse(recipesJson); // fail loudly on junk
    summary.recipes = Array.isArray(parsed.recipes) ? parsed.recipes.length : 0;
    summary.bytes += recipesJson.length;
    dayFolder.createFile('recipe-chest-backup-' + stamp + '.json', recipesJson, MimeType.PLAIN_TEXT);

    // 2. Photos, slice by slice, until the API says it is done.
    var offset = 0;
    var slices = 0;
    var done = false;
    while (!done && slices < MAX_SLICES) {
      var sliceUrl = config.url + '?photos=1&offset=' + offset + '&limit=' + SLICE_LIMIT;
      var sliceJson = fetchJson_(sliceUrl, config.secret);
      var slice = JSON.parse(sliceJson);
      summary.bytes += sliceJson.length;
      dayFolder.createFile('recipe-chest-photos-' + (slices + 1) + '.json', sliceJson, MimeType.PLAIN_TEXT);
      summary.photoFiles += 1;
      slices += 1;
      done = slice.done === true;
      if (!done) {
        if (slice.nextOffset === null || slice.nextOffset === undefined) break;
        offset = slice.nextOffset;
      }
    }
    if (!done && slices >= MAX_SLICES) {
      throw new Error('Stopped after ' + MAX_SLICES + ' photo slices; the backup may be incomplete.');
    }

    // 3. Keep the folder tidy.
    trashOldFolders_(root, config.keepWeeks);

    MailApp.sendEmail(
      config.notify,
      'Recipe Chest backup ' + stamp + ' succeeded',
      summary.recipes + ' recipes, ' + summary.photoFiles + ' photo files, ' +
        (summary.bytes / (1024 * 1024)).toFixed(2) + ' MB.'
    );
    return summary;
  } catch (error) {
    try {
      MailApp.sendEmail(
        config.notify,
        'Recipe Chest backup ' + stamp + ' FAILED',
        String(error && error.message ? error.message : error)
      );
    } catch (mailError) {
      // A failed notification must not hide the real failure.
      Logger.log('Could not send the failure email: ' + mailError);
    }
    throw error;
  }
}

function trashOldFolders_(root, keepWeeks) {
  var cutoff = new Date().getTime() - keepWeeks * 7 * 24 * 60 * 60 * 1000;
  var folders = root.getFolders();
  while (folders.hasNext()) {
    var folder = folders.next();
    var name = folder.getName();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue; // only our own date folders
    var parts = name.split('-');
    var when = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])).getTime();
    if (when < cutoff) folder.setTrashed(true);
  }
}

function installWeeklyBackupTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i += 1) {
    if (triggers[i].getHandlerFunction() === 'weeklyBackup') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('weeklyBackup')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(3)
    .inTimezone(Session.getScriptTimeZone())
    .create();
  Logger.log('weeklyBackup will run every Sunday at 03:00 ' + Session.getScriptTimeZone() + '.');
}
