import * as Sentry from '@sentry/electron';
import { isDevelopment, isProduction } from './app-util';

const LOG_ERRORS_TO_CONSOLE = isDevelopment();
const LOG_ERRORS_TO_SENTRY = isProduction();

/* eslint-disable import/prefer-default-export */
export function logError(error, errorMessage) {
  if (LOG_ERRORS_TO_CONSOLE) {
    if (errorMessage) { console.error(errorMessage); }
    if (error) { console.error(error); }
  }
  if (LOG_ERRORS_TO_SENTRY) {
    if (errorMessage) { Sentry.captureException(errorMessage); }
    if (error) { Sentry.captureException(error); }
  }
}
