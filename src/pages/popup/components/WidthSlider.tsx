import React, { useId } from 'react';

import { Slider } from '../../../components/ui/slider';
import { Switch } from '../../../components/ui/switch';

interface WidthSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  narrowLabel: string;
  wideLabel: string;
  valueFormatter?: (value: number) => string;
  onChange: (value: number) => void;
  onChangeComplete?: (value: number) => void;
  /** When provided, renders a toggle switch in the title row */
  enabled?: boolean;
  /** Callback when the toggle is flipped */
  onToggle?: (enabled: boolean) => void;
}

/**
 * Slider setting rendered as a single row of a grouped list:
 * title · value · (switch) on one line, the slider revealed underneath
 * while the setting is on. Used for chat width, font sizes, spacing, etc.
 */
export default function WidthSlider({
  label,
  value,
  min,
  max,
  step,
  narrowLabel,
  wideLabel,
  valueFormatter,
  onChange,
  onChangeComplete,
  enabled,
  onToggle,
}: WidthSliderProps) {
  const formatValue = valueFormatter ?? ((v: number) => `${v}%`);
  const hasToggle = enabled !== undefined && onToggle !== undefined;
  const isExpanded = !hasToggle || enabled;
  const switchId = useId();
  const sliderId = useId();

  return (
    <div className="gv-row gv-row--stack">
      <div className="gv-row__line">
        <label
          htmlFor={hasToggle ? switchId : sliderId}
          className="gv-row__title min-w-0 flex-1 cursor-pointer"
        >
          {label}
        </label>
        <span className="gv-value" data-visible={isExpanded} aria-hidden={!isExpanded}>
          {formatValue(value)}
        </span>
        {hasToggle && (
          <Switch id={switchId} checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        )}
      </div>
      <div className="gv-reveal" data-open={isExpanded}>
        <div className="gv-reveal__body">
          <div className="pt-2">
            <Slider
              id={sliderId}
              min={min}
              max={max}
              step={step}
              value={value}
              onValueChange={onChange}
              onValueCommit={onChangeComplete}
            />
            <div className="gv-scale" aria-hidden="true">
              <span>{narrowLabel}</span>
              <span>{wideLabel}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
