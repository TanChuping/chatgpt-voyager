import enMessages from '@/locales/en/messages.json';
import { extractMessageDictionary } from '@/utils/localeMessages';
import { installTranslations } from '@/utils/translations';

/** Unit fixtures that bypass the app bootstrap must provide its ready dictionary. */
export function installEnglishLocale(): void {
  installTranslations(extractMessageDictionary(enMessages));
}
