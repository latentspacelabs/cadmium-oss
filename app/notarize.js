require('dotenv').config();
const { notarize } = require('@electron/notarize');

// Credentials come from the environment / .env — never hardcode them here.
// Without them (local/dev builds) notarization is skipped, which is the
// desired behavior for ad-hoc-signed local builds.
exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') {
    return;
  }

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('notarize: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set — skipping notarization');
    return;
  }

  const appName = context.packager.appInfo.productFilename;

  return await notarize({
    appBundleId: 'com.latentspacelabs.cadmium',
    appPath: `${appOutDir}/${appName}.app`,
    appleId: APPLE_ID,
    teamId: APPLE_TEAM_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
  });
};
