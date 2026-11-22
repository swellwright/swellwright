// The part of the code editor that needs Monaco: `code-editor.tsx` loads this file lazily. Importing `./monaco-setup.js`
// first makes `@monaco-editor/react` use the Monaco that is bundled here instead of fetching one from a CDN.
import './monaco-setup.js';

import Editor from '@monaco-editor/react';
import * as monaco from 'monaco-editor/editor';
import type { editor } from 'monaco-editor';
import { useCallback, useEffect, useRef } from 'react';

import { LoaderModal } from '@swellwright/ui';

import type { EditorMarker } from './code-editor.js';

export interface MonacoEditorProps {
  value: string;
  language: string;
  theme: string;
  readOnly: boolean;
  onChange: ((value: string) => void) | undefined;
  options: editor.IStandaloneEditorConstructionOptions;
  markers: readonly EditorMarker[];
}

export default function MonacoEditor({
  value,
  language,
  theme,
  readOnly,
  onChange,
  options,
  markers,
}: MonacoEditorProps) {
  const handle = useRef<editor.IStandaloneCodeEditor | null>(null);
  const apply = useCallback(() => {
    const model = handle.current?.getModel();
    if (!model) {
      return;
    }
    monaco.editor.setModelMarkers(
      model,
      'swellwright',
      markers
        .filter((marker) => marker.line >= 1 && marker.line <= model.getLineCount())
        .map((marker) => ({
          severity: monaco.MarkerSeverity.Error,
          message: marker.message,
          startLineNumber: marker.line,
          startColumn: marker.column ?? 1,
          endLineNumber: marker.line,
          endColumn: model.getLineMaxColumn(marker.line),
        })),
    );
  }, [markers]);
  useEffect(() => {
    apply();
  }, [apply, value]);
  return (
    <Editor
      onMount={(mounted) => {
        handle.current = mounted;
        apply();
      }}
      language={language}
      loading={<LoaderModal mih="100%" />}
      onChange={(next) => {
        onChange?.(next ?? '');
      }}
      options={{ ...options, readOnly }}
      theme={theme}
      value={value}
    />
  );
}
