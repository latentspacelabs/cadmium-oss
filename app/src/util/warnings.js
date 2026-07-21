import { t } from '@/util/i18n';
import showCustomDialog from '@/util/customDialog';

export function colorImportedFirst() {
  return new Promise((resolve) => {
    showCustomDialog({
      title: t('Color Has No Line'),
      message: t('Just a heads up, one or more color frames that you imported '
        + 'do not have an associated line frame. Cadmium will attempt to generate '
        + 'one for you, but it is recommended to import line images first for best results.'),
      buttons: [t('Continue'), t('Stop Import')],
      defaultId: 0,
      cancelId: 1,
      type: 'warning',
    }).then((result) => {
      resolve(result);
    });
  });
}
