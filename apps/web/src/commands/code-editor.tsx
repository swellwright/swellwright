// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/shared/ui/code-editor/{code-editor.tsx,
// CodeEditor.module.css}. The panel's editor is Monaco through `@monaco-editor/react`, in a box with a one pixel border
// and the card colour behind it. Changes: Monaco is loaded the first time an editor is shown (the panel imports it with
// the first page; this console keeps it out of its main bundle), the JSON path bar and the repair action are not
// ported (a script is not JSON), and the box has an accessible name.
import { Box } from '@mantine/core';
import { lazy, Suspense } from 'react';

import { LoaderModal } from '@swellwright/ui';

import { MONACO_THEME_NAME, SCRIPT_EDITOR_OPTIONS } from './monaco-theme.js';

/** A problem to underline: a line (1-based), a column when it is known, and what is wrong. */
export interface EditorMarker {
  readonly line: number;
  readonly column: number | null;
  readonly message: string;
}

export interface CodeEditorProps {
  value: string;
  onChange?: ((value: string) => void) | undefined;
  readOnly?: boolean;
  /** The language of Monaco, `shell` by default. */
  language?: string;
  /** CSS height of the editor, `360px` by default. */
  height?: string;
  /** Accessible name of the editor (Monaco's own text area has none). */
  label: string;
  /** Problems to underline, for example the issues of a validation. */
  markers?: readonly EditorMarker[];
}

// The editor, Monaco and its worker are one chunk, loaded when the first editor is drawn.
const Editor = lazy(() => import('./code-editor-monaco.js'));

/** A code editor in the panel's look: Monaco with the panel's dark theme, in a framed box. */
export function CodeEditor({
  value,
  onChange,
  readOnly = false,
  language = 'shell',
  height = '360px',
  label,
  markers,
}: CodeEditorProps) {
  return (
    <Box
      aria-label={label}
      role="group"
      style={{
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 'var(--mantine-radius-md)',
        overflow: 'hidden',
        height,
        backgroundColor: '#161b22',
      }}
    >
      <Suspense fallback={<LoaderModal mih="100%" />}>
        <Editor
          language={language}
          markers={markers ?? []}
          onChange={onChange}
          readOnly={readOnly}
          theme={MONACO_THEME_NAME}
          value={value}
          options={SCRIPT_EDITOR_OPTIONS}
        />
      </Suspense>
    </Box>
  );
}
