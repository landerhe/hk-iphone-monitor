// Google Apps Script: project settings -> script properties:
// RELAY_SECRET: random 32+ character shared secret
// RECIPIENT: your fixed Gmail recipient (never read from incoming requests)
function doPost(e) {
  const reply = object => ContentService.createTextOutput(JSON.stringify(object)).setMimeType(ContentService.MimeType.JSON);
  const properties = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    const data = JSON.parse(e.postData.contents);
    const secret = properties.getProperty('RELAY_SECRET');
    const recipient = properties.getProperty('RECIPIENT');
    if (!secret || secret.length < 32 || data.secret !== secret || !recipient) return reply({ok: false});
    if (typeof data.id !== 'string' || !/^[a-zA-Z0-9-]{1,160}$/.test(data.id) || typeof data.subject !== 'string' || !data.subject.startsWith('[香港') || data.subject.length > 250 || typeof data.text !== 'string' || data.text.length > 5000) return reply({ok: false});
    locked = lock.tryLock(10000);
    if (!locked) return reply({ok: false});
    const key = 'sent_' + data.id;
    if (properties.getProperty(key)) return reply({ok: true, duplicate: true});
    // Keep deduplication records 48 hours, including across cold starts.
    const all = properties.getProperties(), now = Date.now();
    Object.keys(all).filter(k => k.startsWith('sent_') && now - Number(all[k]) > 48 * 3600000).forEach(k => properties.deleteProperty(k));
    if (MailApp.getRemainingDailyQuota() < 1) return reply({ok: false});
    MailApp.sendEmail({to: recipient, subject: data.subject, body: data.text, name: '香港 iPhone 到货监控'});
    properties.setProperty(key, String(now));
    return reply({ok: true});
  } catch (_) {return reply({ok: false});}
  finally {if (locked) lock.releaseLock();}
}
