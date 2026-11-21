import React from 'react';

import '@pages/options/Options.css';

import { LanguageProvider } from '../../contexts/LanguageContext';
import { LocalTransfer } from './LocalTransfer';

export default function Options() {
  return (
    <LanguageProvider>
      <LocalTransfer />
    </LanguageProvider>
  );
}
