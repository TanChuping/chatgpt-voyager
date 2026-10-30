import React, { useLayoutEffect, useState } from 'react';

import { Moon, Sun } from 'lucide-react';

import { useDarkMode } from '../hooks/useDarkMode';
import { Button } from './ui/button';

export const DarkModeToggle: React.FC = () => {
  const { isDark, toggleDarkMode } = useDarkMode();
  // Animate the icon swap only once the theme has actually changed — never
  // on first paint, and never on the outgoing icon (it would be caught
  // mid-animation in the view-transition snapshot).
  const [shownIsDark, setShownIsDark] = useState(isDark);
  const [swapped, setSwapped] = useState(false);
  if (shownIsDark !== isDark) {
    setShownIsDark(isDark);
    setSwapped(true);
  }

  // Paint the resolved theme before the first frame (the hook's own effect
  // runs after paint, which showed a light flash for dark-mode users).
  // Class only — persisting the preference stays with useDarkMode.
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
  }, [isDark]);

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={(e) => toggleDarkMode(e)}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="text-fg-3 hover:text-fg h-[30px] w-[30px]"
    >
      <span key={isDark ? 'sun' : 'moon'} className={swapped ? 'gv-icon-swap' : 'inline-flex'}>
        {isDark ? (
          <Sun className="h-4 w-4" strokeWidth={1.8} />
        ) : (
          <Moon className="h-4 w-4" strokeWidth={1.8} />
        )}
      </span>
      <span className="sr-only">Toggle dark mode</span>
    </Button>
  );
};
