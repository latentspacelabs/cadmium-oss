import { i18n } from '@/util/i18nVue';
import showCustomDialog from '@/util/customDialog';

export function colorImportedFirst() {
  return new Promise((resolve) => {
    showCustomDialog({
      title: i18n.__('Color Has No Line'),
      message: i18n.__('Just a heads up, one or more color frames that you imported '
        + 'do not have an associated line frame. Cadmium will attempt to generate '
        + 'one for you, but it is recommended to import line images first for best results.'),
      buttons: [i18n.__('Continue'), i18n.__('Stop Import')],
      defaultId: 0,
      cancelId: 1,
      type: 'warning',
    }).then((result) => {
      resolve(result);
    });
  });
}
