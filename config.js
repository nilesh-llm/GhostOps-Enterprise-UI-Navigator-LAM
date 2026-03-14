const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const envCandidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '.gitignore/.env'),
];

for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}

const fallbackCredentials = path.resolve(process.cwd(), '.gitignore/google-credentials.json');
const configuredCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS
  ? path.resolve(process.cwd(), process.env.GOOGLE_APPLICATION_CREDENTIALS)
  : null;

if (configuredCredentials && fs.existsSync(configuredCredentials)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = configuredCredentials;
} else if (fs.existsSync(fallbackCredentials)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = fallbackCredentials;
}

function resolveTargetHtml() {
  if (process.env.TARGET_HTML) {
    return path.resolve(process.cwd(), process.env.TARGET_HTML);
  }

  const candidates = [
    path.resolve(process.cwd(), 'enterprise-dashboard.html'),
    path.resolve(process.cwd(), 'legacy-crm.html'),
  ];

  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  return existing || candidates[0];
}

function resolveChromeExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const macChromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return fs.existsSync(macChromePath) ? macChromePath : undefined;
}

module.exports = {
  resolveChromeExecutable,
  resolveTargetHtml,
};
