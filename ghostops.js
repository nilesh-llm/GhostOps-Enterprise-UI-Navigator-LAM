require('./config');

const fs = require('fs');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { resolveChromeExecutable, resolveTargetHtml } = require('./config');

puppeteer.use(StealthPlugin());

function broadcastEvent(broadcast, type, data) {
  try {
    if (typeof broadcast !== 'function') return;
    broadcast(type, data);
  } catch {
    // ignore broadcast errors
  }
}

function createLogger(broadcast) {
  const log = (...args) => {
    console.log(...args);
    const message = args
      .map((arg) => (typeof arg === 'string' ? arg.replace(/\x1b\[[0-9;]*m/g, '') : String(arg)))
      .join(' ');
    broadcastEvent(broadcast, 'log', message);
  };

  const logError = (...args) => {
    console.error(...args);
    const message = args
      .map((arg) => (typeof arg === 'string' ? arg.replace(/\x1b\[[0-9;]*m/g, '') : String(arg)))
      .join(' ');
    broadcastEvent(broadcast, 'log', message);
  };

  return { log, logError };
}

function normalizeGeminiDecision(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return parsed;
  }

  const normalized = { ...parsed };

  if (typeof normalized.action === 'string') {
    normalized.action = normalized.action.trim().toLowerCase();
  }

  if (typeof normalized.id === 'string') {
    const trimmedId = normalized.id.trim();
    if (/^\d+$/.test(trimmedId)) {
      normalized.id = Number.parseInt(trimmedId, 10);
    }
  }

  if (typeof normalized.text === 'string') {
    normalized.text = normalized.text.trim();
  }

  if (typeof normalized.extractedData === 'string') {
    normalized.extractedData = normalized.extractedData.trim();
  }

  return normalized;
}

async function getGeminiAction(model, goal, inlineImage, emitLog, promptOverride, attempt = 1, maxAttempts = 3) {
  const basePrompt = promptOverride || (
    `Your goal is: "${goal}". Look at the screenshot. ` +
    'If your goal is complete and you see a SUCCESS message on the screen containing a Ticket Number, you MUST return {"action": "done", "extractedData": "Ticket #XXXX"}. ' +
    'If not, return the next "click" or "type" action with the correct "id". ' +
    'For "type", also include the required "text". ' +
    'CRITICAL: The "id" you return MUST be the exact INTEGER NUMBER printed inside the yellow bounding box overlay. Do NOT return HTML ids, strings, or names. Only return the integer. ' +
    'Return STRICTLY a JSON object with this structure: {"action":"click"|"type"|"done","id":number,"text":string,"extractedData":string}. No markdown. ' +
    'CRITICAL: Under NO CIRCUMSTANCES should you output any conversational text, explanations, or reasoning. Return ONLY the raw JSON object starting with { and ending with }.'
  );

  const retrySuffix =
    attempt > 1
      ? ' Your previous response was not valid JSON or did not match the required structure. This time, return ONLY the JSON object, with no explanations.'
      : '';

  const prompt = basePrompt + retrySuffix;

  emitLog(
    '\x1b[35m%s\x1b[0m',
    `🧠 Calling Gemini for next action (attempt ${attempt}/${maxAttempts})...`
  );

  const result = await model.generateContent([prompt, inlineImage]);
  let rawText = result.response.text();

  emitLog('\x1b[35m%s\x1b[0m', `📦 Raw Gemini response: ${rawText}`);

  try {
    rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON object found in Gemini's response.");
    }

    const cleanJson = jsonMatch[0];
    const parsed = JSON.parse(cleanJson);
    return normalizeGeminiDecision(parsed);
  } catch (err) {
    emitLog(
      '\x1b[31m%s\x1b[0m',
      `❌ Failed to parse Gemini JSON on attempt ${attempt}:`,
      err.message
    );
    if (attempt < maxAttempts) {
      return getGeminiAction(model, goal, inlineImage, emitLog, promptOverride, attempt + 1, maxAttempts);
    }
    throw new Error('Gemini failed to return valid JSON after multiple attempts.');
  }
}

async function createGeminiModel(log) {
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GOOGLE_API_KEY or GEMINI_API_KEY in environment variables.');
  }

  log('\x1b[35m%s\x1b[0m', '🔑 Initializing Gemini client (gemini-2.5-flash)...');
  const genAI = new GoogleGenerativeAI(apiKey);
  return genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
}

async function uploadAuditTrail(page, goal, achieved, broadcast, logError) {
  try {
    const bucketName = process.env.GCS_BUCKET_NAME;
    const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!bucketName || !credentialsPath || !fs.existsSync(credentialsPath)) {
      broadcastEvent(
        broadcast,
        'log',
        '☁️ Skipping audit upload because GCS bucket or credentials are not configured.'
      );
      return;
    }

    const storage = new Storage({ keyFilename: credentialsPath });

    const timestamp = Date.now();
    const auditScreenshotPath = path.resolve(process.cwd(), 'audit-final.png');
    const timestampedScreenshotName = `audit-${timestamp}.png`;
    const latestScreenshotName = 'latest/audit-final.png';
    const timestampedSummaryName = `summary-${timestamp}.json`;
    const latestSummaryName = 'latest/summary.json';
    const auditSummary = {
      goal,
      status: achieved ? 'SUCCESS' : 'INCOMPLETE',
      timestamp: new Date().toISOString(),
      bucket: bucketName,
      screenshotObjects: [timestampedScreenshotName, latestScreenshotName],
      summaryObjects: [timestampedSummaryName, latestSummaryName],
    };

    await page.evaluate(() => {
      Array.from(document.querySelectorAll('.ghostops-tag')).forEach((el) => el.remove());
    });

    await page.screenshot({
      path: auditScreenshotPath,
      type: 'png',
    });

    if (!fs.existsSync(auditScreenshotPath)) {
      console.error('Local screenshot not found');
      throw new Error('Local screenshot not found');
    }

    console.log('☁️ Attempting upload to bucket:', process.env.GCS_BUCKET_NAME);
    const bucket = storage.bucket(bucketName);
    await bucket.upload(auditScreenshotPath, {
      destination: timestampedScreenshotName,
    });
    await bucket.upload(auditScreenshotPath, {
      destination: latestScreenshotName,
    });

    const auditSummaryJson = JSON.stringify(auditSummary, null, 2);
    await bucket.file(timestampedSummaryName).save(
      auditSummaryJson,
      { contentType: 'application/json' }
    );
    await bucket.file(latestSummaryName).save(
      JSON.stringify(auditSummary, null, 2),
      { contentType: 'application/json' }
    );

    const successMessage =
      `☁️ Audit uploaded to gs://${bucketName}/${timestampedScreenshotName}, ` +
      `gs://${bucketName}/${timestampedSummaryName}, and latest aliases.`;
    console.log(successMessage);
    broadcastEvent(broadcast, 'log', successMessage);
  } catch (error) {
    console.error('❌ GCS UPLOAD FAILED:', error.message, error);
    logError(
      '\x1b[31m%s\x1b[0m',
      '☁️ Failed to save Enterprise Audit Trail to Google Cloud Storage:',
      error.message
    );
  }
}

function appendCompletedAudit(personName, extractedData) {
  if (!personName || !extractedData) return;

  const completedAuditPath = path.resolve(process.cwd(), 'completed_audit.csv');
  if (!fs.existsSync(completedAuditPath)) {
    fs.appendFileSync(completedAuditPath, 'name,ticket_number\n');
  }
  fs.appendFileSync(completedAuditPath, `"${personName}","${extractedData}"\n`);
}

function normalizeStatusForUi(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'awaiting customer') return 'Pending Customer';
  if (normalized === 'resolved') return 'Resolved';
  if (normalized === 'investigating') return 'Investigating';
  if (normalized === 'pending customer') return 'Pending Customer';
  if (normalized === 'waiting on engineering') return 'Waiting on Engineering';
  return status;
}

async function processBatchTicket(page, person, broadcast) {
  const { log, logError } = createLogger(broadcast);
  const desiredStatus = normalizeStatusForUi(person.status);

  log('\x1b[36m%s\x1b[0m', `🛠️ Deterministic update started for ${person.name}`);

  const prepResult = await page.evaluate(({ name }) => {
    const successAlert = document.getElementById('success-alert');
    if (successAlert) {
      successAlert.textContent = '';
      successAlert.classList.add('hidden');
    }

    const modal = document.getElementById('edit-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }

    const dropdownMenu = document.getElementById('status-dropdown-menu');
    if (dropdownMenu) {
      dropdownMenu.classList.add('hidden');
    }

    const saveConfirmation = document.getElementById('save-confirmation');
    if (saveConfirmation) {
      saveConfirmation.classList.add('opacity-0');
    }

    const searchInput = document.getElementById('global-search');
    if (searchInput) {
      searchInput.value = name;
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const row = Array.from(document.querySelectorAll('tbody tr')).find((candidate) => {
      const owner = (candidate.getAttribute('data-owner') || '').trim().toLowerCase();
      return owner === name.trim().toLowerCase();
    });

    if (!row) {
      return { found: false };
    }

    row.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const editButton = row.querySelector('.edit-ticket-button');
    if (!editButton) {
      return { found: true, editable: false };
    }

    editButton.click();
    return {
      found: true,
      editable: true,
      ticket: row.getAttribute('data-ticket') || '',
      currentStatus: row.getAttribute('data-status') || '',
    };
  }, { name: person.name });

  if (!prepResult.found) {
    throw new Error(`Could not find ticket row for ${person.name}.`);
  }
  if (!prepResult.editable) {
    throw new Error(`Could not open edit button for ${person.name}.`);
  }

  await page.waitForFunction(() => {
    const modal = document.getElementById('edit-modal');
    return modal && modal.classList.contains('flex') && !modal.classList.contains('hidden');
  }, { timeout: 3000 });

  const saveResult = await page.evaluate(({ name, status, remark }) => {
    const modal = document.getElementById('edit-modal');
    if (!modal) {
      return { ok: false, reason: 'Modal not found.' };
    }

    const modalLabel = (document.getElementById('modal-ticket-label')?.textContent || '').toLowerCase();
    if (!modalLabel.includes(name.toLowerCase())) {
      return { ok: false, reason: `Modal opened for wrong ticket: ${modalLabel}` };
    }

    const statusOption = Array.from(document.querySelectorAll('.status-option-button')).find(
      (button) => (button.getAttribute('data-status') || '').trim() === status
    );
    if (!statusOption) {
      return { ok: false, reason: `Status option "${status}" not found.` };
    }

    const dropdownButton = document.getElementById('status-dropdown-button');
    const remarks = document.getElementById('remarks');
    const saveButton = document.getElementById('save-ticket-button');

    if (!dropdownButton || !remarks || !saveButton) {
      return { ok: false, reason: 'Modal controls missing.' };
    }

    dropdownButton.click();
    statusOption.click();
    remarks.focus();
    remarks.value = remark;
    remarks.dispatchEvent(new Event('input', { bubbles: true }));
    saveButton.click();

    const row = Array.from(document.querySelectorAll('tbody tr')).find((candidate) => {
      const owner = (candidate.getAttribute('data-owner') || '').trim().toLowerCase();
      return owner === name.trim().toLowerCase();
    });

    if (!row) {
      return { ok: false, reason: 'Row disappeared after save.' };
    }

    const successAlert = document.getElementById('success-alert');
    return {
      ok: true,
      ticket: row.getAttribute('data-ticket') || '',
      updatedStatus: row.getAttribute('data-status') || '',
      updatedRemark: row.getAttribute('data-remarks') || '',
      successText: successAlert ? successAlert.textContent || '' : '',
    };
  }, { name: person.name, status: desiredStatus, remark: person.remark });

  if (!saveResult.ok) {
    throw new Error(saveResult.reason || `Could not save ticket for ${person.name}.`);
  }

  if (saveResult.updatedStatus !== desiredStatus) {
    throw new Error(
      `Status verification failed for ${person.name}: expected "${desiredStatus}", got "${saveResult.updatedStatus}".`
    );
  }

  if (saveResult.updatedRemark !== person.remark) {
    throw new Error(`Remark verification failed for ${person.name}.`);
  }

  const extractedDataMatch = (saveResult.successText || '').match(/Ticket #\d+/i);
  const extractedData = extractedDataMatch ? extractedDataMatch[0] : saveResult.ticket || '';
  appendCompletedAudit(person.name, extractedData);

  log(
    '\x1b[32m%s\x1b[0m',
    `✅ Saved ${person.name}: status="${saveResult.updatedStatus}", ticket="${extractedData || saveResult.ticket}"`
  );

  return {
    success: true,
    achieved: true,
    extractedData,
  };
}

async function runGoalOnPage(model, page, goal, broadcast, options = {}) {
  const { log, logError } = createLogger(broadcast);
  const clickDelayMs = options.clickDelayMs || 1000;
  const doneDelayMs = options.doneDelayMs || 0;
  const promptOverride = options.promptOverride || null;

  let step = 0;
  const MAX_STEPS = 10;
  let achieved = false;
  let extractedData = '';
  let resultMessage = 'Execution finished before goal completion.';

  while (step < MAX_STEPS) {
    step += 1;

    log('\x1b[36m%s\x1b[0m', `\n🔁 --- GhostOps Loop Step ${step} ---`);

    const popupDetected = await page.evaluate(() => {
      function visible(el) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 40 && rect.height > 40;
      }

      const candidates = Array.from(
        document.querySelectorAll('dialog,[role="dialog"],[aria-modal="true"],.modal,.popup,.cookie,.consent')
      ).filter(visible);

      const fixedOverlays = Array.from(document.querySelectorAll('body *'))
        .filter((el) => {
          const style = window.getComputedStyle(el);
          if (style.position !== 'fixed') return false;
          const z = parseInt(style.zIndex || '0', 10);
          if (!Number.isFinite(z) || z < 1000) return false;
          return visible(el);
        })
        .slice(0, 3);

      return candidates.length > 0 || fixedOverlays.length > 0;
    });

    if (popupDetected) {
      log('\x1b[33m%s\x1b[0m', '⚠️ Popup detected. Initiating self-correction sequence.');
    }

    log('\x1b[33m%s\x1b[0m', '🏷️ Injecting numbered tags into interactive elements (SoM tagging)...');
    const tagMappings = await page.evaluate(() => {
      function isVisible(el) {
        const style = window.getComputedStyle(el);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.opacity === '0'
        ) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0;
      }

      Array.from(document.querySelectorAll('.ghostops-tag')).forEach((el) => el.remove());

      const elements = Array.from(
        document.querySelectorAll('input, textarea, button, a')
      ).filter((el) => isVisible(el) && el.getAttribute('data-ghostops-ignore') !== 'true');
      let idCounter = 1;
      const mappings = [];

      elements.forEach((el) => {
        const rect = el.getBoundingClientRect();
        const id = idCounter++;

        const tag = document.createElement('div');
        tag.textContent = String(id);
        tag.className = 'ghostops-tag';
        tag.style.position = 'absolute';
        tag.style.left = `${rect.left + window.scrollX}px`;
        tag.style.top = `${rect.top + window.scrollY}px`;
        tag.style.background = 'yellow';
        tag.style.color = 'black';
        tag.style.fontSize = '12px';
        tag.style.fontWeight = 'bold';
        tag.style.padding = '2px 4px';
        tag.style.borderRadius = '3px';
        tag.style.zIndex = '999999';
        tag.style.pointerEvents = 'none';
        tag.style.boxShadow = '0 0 4px rgba(0,0,0,0.4)';

        document.body.appendChild(tag);

        mappings.push({
          id,
          x: rect.left + window.scrollX + rect.width / 2,
          y: rect.top + window.scrollY + rect.height / 2,
        });
      });

      return mappings;
    });

    log('\x1b[36m%s\x1b[0m', `✅ SoM tagging complete. Injected ${tagMappings.length} interactive element tags.`);

    log('\x1b[33m%s\x1b[0m', '📸 Taking screenshot with yellow tag overlays...');
    const screenshotBase64 = await page.screenshot({
      type: 'png',
      encoding: 'base64',
    });
    broadcastEvent(broadcast, 'image', screenshotBase64);

    const imagePart = {
      inlineData: {
        data: screenshotBase64,
        mimeType: 'image/png',
      },
    };

    const geminiAction = await getGeminiAction(model, goal, imagePart, log, promptOverride);
    const { action, id, text, extractedData: extractedValue } = geminiAction || {};

    log(
      '\x1b[32m%s\x1b[0m',
      `📋 Gemini decision: action="${action}", id=${id}, text=${text ? `"${text}"` : 'null'}`
    );

    if (action === 'done') {
      log('\x1b[32m%s\x1b[0m', '✅ Goal achieved! Breaking loop.');
      achieved = true;
      extractedData = typeof extractedValue === 'string' ? extractedValue : '';
      resultMessage = 'Goal achieved';
      if (doneDelayMs > 0) {
        await new Promise((r) => setTimeout(r, doneDelayMs));
      }
      break;
    }

    if (action === 'click') {
      const numericId = Number.parseInt(id, 10);
      if (!Number.isInteger(numericId)) {
        log('\x1b[33m%s\x1b[0m', '⚠️ Gemini requested "click" without a valid id. Retrying...');
        continue;
      }

      const targetTag = tagMappings.find((tag) => Number.parseInt(tag.id, 10) === numericId);
      if (!targetTag) {
        broadcastEvent(broadcast, 'log', `⚠️ Tag ID ${id} not found on screen. Retrying...`);
        continue;
      }

      const { x, y } = targetTag;
      log('\x1b[33m%s\x1b[0m', `🖱️ Clicking tag ${numericId} at X=${x}, Y=${y} ...`);
      await page.mouse.click(x, y);
      await new Promise((resolve) => setTimeout(resolve, clickDelayMs));
      resultMessage = `Executed action: click ${numericId}`;
      continue;
    }

    if (action === 'type') {
      const numericId = Number.parseInt(id, 10);
      if (!Number.isInteger(numericId) || typeof text !== 'string' || !text.length) {
        log('\x1b[33m%s\x1b[0m', '⚠️ Gemini requested "type" without a valid id/text. Retrying...');
        continue;
      }

      const targetTag = tagMappings.find((tag) => Number.parseInt(tag.id, 10) === numericId);
      if (!targetTag) {
        broadcastEvent(broadcast, 'log', `⚠️ Tag ID ${id} not found on screen. Retrying...`);
        continue;
      }

      const { x, y } = targetTag;
      log('\x1b[36m%s\x1b[0m', `🧹 Clearing existing text, then typing into tag ${numericId}: "${text}"`);
      await page.mouse.click(x, y, { clickCount: 3 });
      await new Promise((r) => setTimeout(r, 200));
      await page.keyboard.press('Backspace');
      await new Promise((r) => setTimeout(r, 200));
      await page.keyboard.type(text, { delay: 50 });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      resultMessage = `Executed action: type "${text}"`;
      continue;
    }

    log('\x1b[33m%s\x1b[0m', `⚠️ Unsupported action "${action}". Retrying...`);
  }

  if (!achieved && step >= MAX_STEPS) {
    resultMessage = `Stopped after ${MAX_STEPS} steps before reaching completion.`;
    logError('\x1b[31m%s\x1b[0m', resultMessage);
  }

  appendCompletedAudit(options.personName, extractedData);

  return { success: true, message: resultMessage, extractedData, achieved };
}

async function runGhostOps(goal, broadcast, options = {}) {
  let browser = null;
  const { log, logError } = createLogger(broadcast);

  log('\x1b[36m%s\x1b[0m', '🚀 Starting GhostOps UI Navigator (autonomous loop)...');
  log('\x1b[32m%s\x1b[0m', `🎯 Goal: ${goal}`);
  broadcastEvent(broadcast, 'log', `🚀 Mission started: ${goal}`);

  try {
    const model = await createGeminiModel(log);
    const executablePath = resolveChromeExecutable();

    browser = await puppeteer.launch({
      headless: false,
      executablePath,
      defaultViewport: null,
      args: [
        '--window-size=800,900',
        '--window-position=800,0',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    const page = await browser.newPage();
    const targetUrl = `file://${resolveTargetHtml()}`;
    await page.goto(targetUrl, { waitUntil: 'networkidle0' });

    const result = await runGoalOnPage(model, page, goal, broadcast, options);
    await uploadAuditTrail(page, goal, result.achieved, broadcast, logError);
    broadcastEvent(broadcast, 'log', 'Execution Finished & Uploaded.');

    return { success: true, message: result.message, extractedData: result.extractedData };
  } catch (error) {
    logError('\x1b[31m%s\x1b[0m', '💥 An error occurred in GhostOps:', error);
    broadcastEvent(broadcast, 'log', `💥 GhostOps error: ${error.message || 'Unknown error'}`);
    return {
      success: false,
      message: error.message || 'Unknown error in GhostOps',
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore browser close failures
      }
    }
  }
}

async function runBatchGhostOps(backlogArray, broadcast) {
  let browser = null;
  const { log, logError } = createLogger(broadcast);

  try {
    const model = await createGeminiModel(log);
    const bucketName = process.env.GCS_BUCKET_NAME;
    const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const storage =
      bucketName && credentialsPath && fs.existsSync(credentialsPath)
        ? new Storage({ keyFilename: credentialsPath })
        : null;
    const executablePath = resolveChromeExecutable();
    browser = await puppeteer.launch({
      headless: false,
      executablePath,
      defaultViewport: null,
      args: [
        '--window-size=800,900',
        '--window-position=800,0',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });
    const page = await browser.newPage();
    const targetUrl = `file://${resolveTargetHtml()}`;
    await page.goto(targetUrl, { waitUntil: 'networkidle0' });

    for (const person of backlogArray) {
      await page.reload({ waitUntil: 'networkidle0' });
      await page.evaluate(({ name }) => {
        const successAlert = document.getElementById('success-alert');
        if (successAlert) {
          successAlert.textContent = '';
          successAlert.classList.add('hidden');
        }

        const modal = document.getElementById('edit-modal');
        if (modal) {
          modal.classList.add('hidden');
          modal.classList.remove('flex');
        }

        const dropdownMenu = document.getElementById('status-dropdown-menu');
        if (dropdownMenu) {
          dropdownMenu.classList.add('hidden');
        }

        const saveConfirmation = document.getElementById('save-confirmation');
        if (saveConfirmation) {
          saveConfirmation.classList.add('opacity-0');
        }

        const searchInput = document.getElementById('global-search');
        if (searchInput) {
          searchInput.value = name;
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        }

        const row = Array.from(document.querySelectorAll('tbody tr')).find((candidate) => {
          const owner = (candidate.getAttribute('data-owner') || '').trim().toLowerCase();
          return owner === name.trim().toLowerCase();
        });

        if (row) {
          row.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        } else {
          window.scrollTo({ top: 0, behavior: 'instant' });
        }
      }, { name: person.name });

      await page.waitForFunction(({ name }) => {
        const row = Array.from(document.querySelectorAll('tbody tr')).find((candidate) => {
          const owner = (candidate.getAttribute('data-owner') || '').trim().toLowerCase();
          return owner === name.trim().toLowerCase();
        });

        return !!row && row.style.display !== 'none';
      }, { timeout: 3000 }, { name: person.name });

      broadcastEvent(broadcast, 'log', `📦 Currently processing: ${person.name}`);
      const goal =
        `Find the ticket for ${person.name}. Click Edit. Change status to ${person.status}. ` +
        `Type EXACTLY "${person.remark}" into the remarks box. Click Save.`;
      const promptOverride =
        `Your goal is to update ${person.name}. ${goal} ` +
        `The CRM has already been filtered to ${person.name}, so focus on the visible matching row and its edit button. ` +
        `If you see a SUCCESS banner, OR if you see that ${person.name}'s row is already updated to "${person.status}", ` +
        'YOU MUST IMMEDIATELY return STRICTLY {"action":"done","extractedData":"Ticket Number"}. Do not click anything else. ' +
        'Otherwise return the next "click" or "type" action with the correct "id". ' +
        'CRITICAL: The "id" you return MUST be the exact INTEGER NUMBER printed inside the yellow bounding box overlay. Do NOT return HTML ids, strings, or names. Only return the integer. ' +
        'For "type", include the exact "text". Return STRICTLY a JSON object only.';

      let step = 0;
      let achieved = false;
      let extractedData = '';

      while (step < 10) {
        step += 1;
        log('\x1b[36m%s\x1b[0m', `\n🔁 --- Batch Loop Step ${step} for ${person.name} ---`);

        const tagMappings = await page.evaluate(() => {
          function isVisible(el) {
            const style = window.getComputedStyle(el);
            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              style.opacity === '0'
            ) {
              return false;
            }
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0;
          }

          Array.from(document.querySelectorAll('.ghostops-tag')).forEach((el) => el.remove());

          const elements = Array.from(
            document.querySelectorAll('input, textarea, button, a')
          ).filter((el) => isVisible(el) && el.getAttribute('data-ghostops-ignore') !== 'true');
          let idCounter = 1;
          const mappings = [];

          elements.forEach((el) => {
            const rect = el.getBoundingClientRect();
            const id = idCounter++;

            const tag = document.createElement('div');
            tag.textContent = String(id);
            tag.className = 'ghostops-tag';
            tag.style.position = 'absolute';
            tag.style.left = `${rect.left + window.scrollX}px`;
            tag.style.top = `${rect.top + window.scrollY}px`;
            tag.style.background = 'yellow';
            tag.style.color = 'black';
            tag.style.fontSize = '12px';
            tag.style.fontWeight = 'bold';
            tag.style.padding = '2px 4px';
            tag.style.borderRadius = '3px';
            tag.style.zIndex = '999999';
            tag.style.pointerEvents = 'none';
            tag.style.boxShadow = '0 0 4px rgba(0,0,0,0.4)';

            document.body.appendChild(tag);

            mappings.push({
              id,
              x: rect.left + window.scrollX + rect.width / 2,
              y: rect.top + window.scrollY + rect.height / 2,
            });
          });

          return mappings;
        });

        const screenshotBase64 = await page.screenshot({
          type: 'png',
          encoding: 'base64',
        });
        broadcastEvent(broadcast, 'image', screenshotBase64);

        const geminiAction = await getGeminiAction(
          model,
          goal,
          {
            inlineData: {
              data: screenshotBase64,
              mimeType: 'image/png',
            },
          },
          log,
          promptOverride
        );

        const { action, id, text, extractedData: extractedValue } = geminiAction || {};
        log(
          '\x1b[32m%s\x1b[0m',
          `📋 Gemini decision for ${person.name}: action="${action}", id=${id}, text=${text ? `"${text}"` : 'null'}`
        );

        if (action === 'done') {
          achieved = true;
          extractedData = typeof extractedValue === 'string' ? extractedValue : 'Ticket Number';
          break;
        }

        if (action === 'click') {
          const numericId = Number.parseInt(id, 10);
          const targetTag = tagMappings.find((tag) => Number.parseInt(tag.id, 10) === numericId);

          if (!targetTag) {
            broadcastEvent(broadcast, 'log', `⚠️ Tag ID ${id} not found on screen. Retrying...`);
            continue;
          }

          const { x, y } = targetTag;
          await page.mouse.click(x, y);
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }

        if (action === 'type') {
          const numericId = Number.parseInt(id, 10);
          const targetTag = tagMappings.find((tag) => Number.parseInt(tag.id, 10) === numericId);

          if (!targetTag || typeof text !== 'string' || !text.length) {
            broadcastEvent(broadcast, 'log', `⚠️ Tag ID ${id} not found on screen. Retrying...`);
            continue;
          }

          const { x, y } = targetTag;
          await page.mouse.click(x, y, { clickCount: 3 });
          await new Promise((resolve) => setTimeout(resolve, 200));
          await page.keyboard.press('Backspace');
          await new Promise((resolve) => setTimeout(resolve, 200));
          await page.keyboard.type(text, { delay: 50 });
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }

        broadcastEvent(broadcast, 'log', `⚠️ Unsupported action "${action}" for ${person.name}. Retrying...`);
      }

      const screenshotBuffer = await page.screenshot();
      fs.appendFileSync(
        'completed_audit.csv',
        `${person.name},${person.status},${new Date().toISOString()}\n`
      );

      try {
        if (!storage || !bucketName) {
          broadcastEvent(
            broadcast,
            'log',
            `☁️ Skipping cloud save for ${person.name} because GCS is not configured.`
          );
        } else {
          const timestamp = Date.now();
          const bucket = storage.bucket(process.env.GCS_BUCKET_NAME);
          const file = bucket.file(`audit-${timestamp}.png`);
          await file.save(screenshotBuffer, { contentType: 'image/png' });

          const summaryFile = bucket.file(`audit-${timestamp}.json`);
          await summaryFile.save(
            JSON.stringify({
              name: person.name,
              status: person.status,
              timestamp: new Date().toISOString(),
            }),
            { contentType: 'application/json' }
          );

          broadcastEvent(broadcast, 'log', `☁️ Successfully saved ${person.name} to CSV and Google Cloud!`);
        }
      } catch (uploadError) {
        logError('\x1b[31m%s\x1b[0m', `☁️ Failed to upload audit for ${person.name}:`, uploadError);
        broadcastEvent(
          broadcast,
          'log',
          `☁️ Failed to upload ${person.name} to Google Cloud, continuing to the next user.`
        );
      }

      broadcastEvent(broadcast, 'log', `✅ Finished processing ${person.name}.`);
      if (!achieved) {
        logError('\x1b[31m%s\x1b[0m', `Batch item for ${person.name} stopped before completion.`);
      }
    }

    await uploadAuditTrail(page, 'Batch backlog processing complete', true, broadcast, logError);
    broadcastEvent(broadcast, 'log', 'Execution Finished & Uploaded.');
    return { success: true, message: 'Batch complete' };
  } catch (error) {
    logError('\x1b[31m%s\x1b[0m', '💥 Batch GhostOps error:', error);
    broadcastEvent(broadcast, 'log', `💥 Batch GhostOps error: ${error.message || 'Unknown error'}`);
    return {
      success: false,
      message: error.message || 'Unknown error in batch GhostOps',
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore browser close failures
      }
    }
  }
}

module.exports = {
  runBatchGhostOps,
  runGhostOps,
};

if (require.main === module) {
  require('./server');
}
