# Optional non-semantic controls

Browser workspace v0.1.10 (bridge v0.0.10) adds two optional arguments to
`browser_snapshot`. The default inventory remains semantic controls only.

```json
{
  "includeNonSemantic": true,
  "candidateSelector": ".option-item, #next-btn"
}
```

`includeNonSemantic` adds visible, named elements with an inline `onclick`
attribute or a `cursor: pointer` boundary. A pointer inherited by a card's
text/icon does not create another target. Native controls, their descendants,
containers holding native controls, associated labels, hidden/inert elements
and unnamed boxes are excluded from the additional scan. Inferred elements
use the snapshot role `clickable`; this is evidence of potential interaction,
not a guarantee that a click will advance the task.

`candidateSelector` filters both interactive elements and form fields before
their count caps. It matches the controls themselves, not every descendant of
a matched container: use `#task button`, not just `#task`. It leaves main text
unchanged (`region` continues to control text extraction). Invalid selectors
fail; no matches produce an empty inventory, never a whole-page fallback.
Controls retain their indices when only the filter changes.

Scoped snapshots acknowledge their settings in an `Inventory scope:` JSON
header. Action deltas retain the preceding snapshot's inventory settings.
Consumers must verify the acknowledgement before trusting a scoped inventory;
older extensions may ignore unknown arguments.

Native/ARIA checked, selected and pressed states are rendered explicitly,
including their false values. Inferred controls also expose up to 160
characters of raw class tokens in a URI-encoded `classes=` flag. Class changes
appear in delta snapshots. These tokens are untrusted page data: `active` or
`selected` is not converted into an invented ARIA role or a guaranteed checked
state. Pages expressing selection only through pixels remain unsupported.

This heuristic does not enumerate JavaScript listeners. Controls with no
semantic marker, inline handler or pointer boundary may still be missed.
Canvas controls, drag gestures and trusted-user-gesture requirements are not
covered. Scope real task controls before increasing candidate budgets.
