import React from 'react';
import { Globe } from 'lucide-react';

import { useLanguage } from '../contexts/LanguageContext';
import { APP_LANGUAGES, APP_LANGUAGE_LABELS, isAppLanguage } from '../utils/language';

export const LanguageSwitcher: React.FC = () => {
  const { language, setLanguage, t } = useLanguage();
  return (
    <label className="text-fg-3 hover:text-fg relative flex h-[30px] items-center gap-1">
      <Globe className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
      <select
        value={language}
        onChange={(event) => { if (isAppLanguage(event.target.value)) void setLanguage(event.target.value); }}
        title={t('language')}
        aria-label={t('language')}
        className="bg-bg text-fg max-w-[112px] cursor-pointer rounded border-0 py-1 text-xs"
      >
        {APP_LANGUAGES.map((lang) => <option key={lang} value={lang}>{APP_LANGUAGE_LABELS[lang]}</option>)}
      </select>
    </label>
  );
};
