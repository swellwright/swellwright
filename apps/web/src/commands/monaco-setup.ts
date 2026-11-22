// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/shared/utils/setup-monaco/setup-monaco.ts. The
// panel bundles Monaco with Vite instead of letting `@monaco-editor/react` fetch it from a CDN, and so does this
// console: a page that sends nothing to another origin, under a Content-Security-Policy that allows only its own
// (ADR 0038). Changes: only what a script and the configurations of the connected panel need: the editor worker, the
// JSON language (its own worker, the panel's `jsonWorker`) and the shell and YAML syntax highlighting (no YAML language
// service: the panel's `monaco-yaml` worker validates what is edited, and these viewers do not edit); the theme is the
// panel's.
//
// Importing this file loads Monaco (several hundred kilobytes). Only `code-editor.tsx` imports it, and only lazily.
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/editor';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/shell/register';
import 'monaco-editor/languages/definitions/yaml/register';
import 'monaco-editor/languages/features/json/register';
import jsonWorker from 'monaco-editor/languages/features/json/json.worker?worker';

import { MONACO_THEME_NAME, monacoTheme } from './monaco-theme.js';

// The worker is a file of this origin (Vite emits it next to the other assets), which `worker-src 'self'` allows.
self.MonacoEnvironment = {
  getWorker: (_id, label) => (label === 'json' ? new jsonWorker() : new editorWorker()),
};

loader.config({ monaco });
monaco.editor.defineTheme(MONACO_THEME_NAME, { ...monacoTheme, base: 'vs-dark' });
