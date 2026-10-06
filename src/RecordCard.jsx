// Owner: Sean — reusable selectable card for project history and shot summaries.
import React from 'react';

export default function RecordCard({
  title,
  leading,
  meta,
  status,
  selected = false,
  onSelect,
  actions,
  className = '',
  ariaLabel,
}) {
  const activate = () => onSelect?.();
  const onKeyDown = event => {
    if (!onSelect) return;
    if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    activate();
  };
  return <article className={`record-card ${selected ? 'selected' : ''} ${className}`} onClick={event => { if (event.target === event.currentTarget) activate(); }}>
    <div
      className="record-card-main"
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={ariaLabel || title}
      onClick={activate}
      onKeyDown={onKeyDown}
    >
      {leading && <div className="record-card-leading">{leading}</div>}
      <div className="record-card-copy">
        <div className="record-card-title"><strong>{title}</strong>{status}</div>
        {meta && <small>{meta}</small>}
      </div>
      {actions && <div className="record-card-actions" onClick={event => event.stopPropagation()}>{actions}</div>}
    </div>
  </article>;
}
