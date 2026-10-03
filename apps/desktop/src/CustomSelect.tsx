import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type SelectOption = { value: string; label: string; disabled?: boolean };

type MenuBox = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: 'top' | 'bottom';
};

export function CustomSelect({
  value,
  options,
  onChange,
  disabled = false,
  label,
  className = '',
  menuPlacement = 'bottom',
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  label: string;
  className?: string;
  menuPlacement?: 'top' | 'bottom';
}) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<MenuBox | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];

  useLayoutEffect(() => {
    if (!open || !trigger.current) {
      setBox(null);
      return;
    }
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const gap = 6;
      const preferredMax = 250;
      const spaceBelow = window.innerHeight - rect.bottom - gap - 8;
      const spaceAbove = rect.top - gap - 8;
      let placement = menuPlacement;
      if (menuPlacement === 'bottom' && spaceBelow < 120 && spaceAbove > spaceBelow) {
        placement = 'top';
      } else if (menuPlacement === 'top' && spaceAbove < 120 && spaceBelow > spaceAbove) {
        placement = 'bottom';
      }
      const maxHeight = Math.max(
        120,
        Math.min(preferredMax, placement === 'bottom' ? spaceBelow : spaceAbove),
      );
      setBox({
        placement,
        width: Math.max(rect.width, 160),
        left: Math.min(rect.left, window.innerWidth - Math.max(rect.width, 160) - 8),
        top: placement === 'bottom' ? rect.bottom + gap : Math.max(8, rect.top - gap - maxHeight),
        maxHeight,
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, menuPlacement, options.length]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (root.current?.contains(target) || menu.current?.contains(target)) return;
      setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div
      className={`custom-select ${open ? 'open' : ''} menu-${menuPlacement} ${className}`}
      ref={root}
    >
      <button
        ref={trigger}
        type="button"
        className="custom-select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <span>{selected?.label ?? 'Choose an option'}</span>
        <ChevronDown size={16} />
      </button>
      {open &&
        box &&
        createPortal(
          <div
            ref={menu}
            className={`custom-select-menu portal menu-${box.placement}`}
            id={listId}
            role="listbox"
            aria-label={label}
            style={{
              position: 'fixed',
              top: box.top,
              left: box.left,
              width: box.width,
              maxHeight: box.maxHeight,
              zIndex: 140000,
            }}
          >
            {options.map((option) => (
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                disabled={option.disabled}
                key={option.value}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span>{option.label}</span>
                {option.value === value && <Check size={15} />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
