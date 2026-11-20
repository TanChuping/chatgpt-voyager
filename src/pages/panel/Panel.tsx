import React from 'react';
import { useLanguage } from '@/contexts/LanguageContext';

import '@pages/panel/Panel.css';

export default function Panel() {
  const { t } = useLanguage();
  return (
    <div className="container">
      <h1>{t('sidePanel')}</h1>
    </div>
  );
}
