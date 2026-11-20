import React, { ReactNode, createContext, useContext, useEffect, useState } from 'react';

import { getCachedLanguage, getTranslationSync, initI18n, setLanguagePreference, subscribeLanguageChange } from '@/utils/i18n';
import type { AppLanguage } from '@/utils/language';
import type { TranslationKey } from '@/utils/translations';

interface LanguageContextType {
  language: AppLanguage;
  setLanguage: (lang: AppLanguage) => Promise<void>;
  t: (key: TranslationKey) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export const LanguageProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<AppLanguage>(getCachedLanguage());
  const [ready, setReady] = useState(false);
  const [, refreshDictionary] = useState(0);
  useEffect(() => {
    let mounted = true;
    const unsubscribe = subscribeLanguageChange((next) => {
      if (mounted) { setLanguageState(next); setReady(true); refreshDictionary((n) => n + 1); }
    });
    void initI18n().then(() => {
      if (mounted) { setLanguageState(getCachedLanguage()); setReady(true); }
    });
    return () => { mounted = false; unsubscribe(); };
  }, []);

  return (
    <LanguageContext.Provider value={{ language, setLanguage: setLanguagePreference, t: getTranslationSync }}>
      {ready ? children : null}
    </LanguageContext.Provider>
  );
};

export const useLanguage = (): LanguageContextType => {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useLanguage must be used within a LanguageProvider');
  return context;
};
