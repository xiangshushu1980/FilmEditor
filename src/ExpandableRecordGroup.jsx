// Owner: Sean — reusable disclosure group for lists of selectable record cards.
import React from 'react';

export default function ExpandableRecordGroup({ title, count, hint, children, defaultOpen = false }) {
  return <details className="record-group" open={defaultOpen}>
    <summary><span>{title}</span><small>{count}{hint ? ` · ${hint}` : ''}</small></summary>
    <div className="record-list">{children}</div>
  </details>;
}
